/**
 * GitHub webhook (gateway): route-level signature/ping/config checks via inject() (full-flow route
 * assertions run only when GITHUB_WEBHOOK_SECRET is set — the same conditional pattern as
 * slack-actions.test.ts), plus service-level PR-merge flow with injected fake GitHub API deps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { env } from "../../env.js";
import { verifyGitHubSignature } from "../../auth/github-verify.js";
import { withSystem, withOrg } from "../../db/rls.js";
import { orgs, principals, members, projects, repos, githubInstallations, changeFeedEntries, contracts } from "../../db/schema.js";
import { processGitHubEvent } from "../../gateway/github-webhook-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 940_000_000;
const uid = (): number => ++seq;

const sign = (body: string, secret: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

test("verifyGitHubSignature: valid, tampered, absent", () => {
  const body = JSON.stringify({ a: 1 });
  const sig = sign(body, "s3cret");
  assert.equal(verifyGitHubSignature({ secret: "s3cret", signature: sig, rawBody: body }), true);
  assert.equal(verifyGitHubSignature({ secret: "s3cret", signature: sig, rawBody: body + "x" }), false);
  assert.equal(verifyGitHubSignature({ secret: "other", signature: sig, rawBody: body }), false);
  assert.equal(verifyGitHubSignature({ secret: "s3cret", signature: undefined, rawBody: body }), false);
});

test("route: 503 unconfigured / 401 bad signature / 200 ping", async (t) => {
  const app: FastifyInstance = buildApp();
  t.after(() => app.close());
  const body = JSON.stringify({ zen: "hi" });

  if (!env.GITHUB_WEBHOOK_SECRET) {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    assert.equal(res.statusCode, 503, "unset secret → 503, never a silent 200");
    return;
  }
  const bad = await app.inject({
    method: "POST",
    url: "/webhooks/github",
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef", "x-github-event": "ping" },
    payload: body,
  });
  assert.equal(bad.statusCode, 401);

  const ping = await app.inject({
    method: "POST",
    url: "/webhooks/github",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body, env.GITHUB_WEBHOOK_SECRET),
      "x-github-event": "ping",
    },
    payload: body,
  });
  assert.equal(ping.statusCode, 200);
  assert.equal(ping.json().pong, true);
});

/* ── service-level flow with injected fakes ── */

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `GH-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: n, githubLogin: `gh-${n}` }).returning());
    const m = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId: n, githubLogin: `gh-${n}` })
        .returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: `gh-${n}`, createdBy: m.id }).returning());
    const repo = one(
      await tx
        .insert(repos)
        .values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/acme/svc-${n}`, defaultBranch: "main" })
        .returning(),
    );
    await tx.insert(githubInstallations).values({ orgId: org.id, installationId: n, accountLogin: "acme" });
    return { orgId: org.id, projectId: proj.id, repoId: repo.id, memberId: m.id, installationId: n, ghUserId: n, n };
  });
}

const fakeDeps = {
  listPrFiles: async () => [
    { filename: "src/routes/auth.ts", status: "modified" },
    { filename: "README.md", status: "modified" },
  ],
  getFile: async (_i: number, _o: string, _r: string, path: string) =>
    path === "src/routes/auth.ts" ? { content: `router.post("/auth/session", h);`, sha: "abc" } : null,
};

const prPayload = (s: { installationId: number; ghUserId: number; n: number }, over: Record<string, unknown> = {}) => ({
  action: "closed",
  installation: { id: s.installationId },
  repository: { full_name: `acme/svc-${s.n}` },
  sender: { id: s.ghUserId, login: `gh-${s.n}` },
  pull_request: {
    number: 7,
    title: "add session route",
    merged: true,
    merge_commit_sha: `sha-${s.n}`,
    merged_by: { id: s.ghUserId, login: `gh-${s.n}` },
  },
  ...over,
});

test("merged PR → verified git-diff change rows; redelivery dedupes", async () => {
  const s = await setup();
  const res = await processGitHubEvent("pull_request", prPayload(s), fakeDeps);
  assert.equal(res.handled, true);
  assert.equal(res.changes, 1);

  const rows = await withOrg(s.orgId, (tx) =>
    tx.select().from(changeFeedEntries).where(eq(changeFeedEntries.repoId, s.repoId)),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.surface, "http:POST /auth/session");
  assert.equal(rows[0]!.createdBy, s.memberId);
  assert.equal(rows[0]!.diffHash, `sha-${s.n}:http:POST /auth/session`);
  const contract = await withOrg(s.orgId, (tx) =>
    tx.select().from(contracts).where(and(eq(contracts.repoId, s.repoId), eq(contracts.surface, "http:POST /auth/session"))),
  );
  assert.equal(contract[0]!.verificationStatus, "verified", "merged code records a VERIFIED contract");
  assert.equal(contract[0]!.verifiedAgainst, "git-diff");

  const again = await processGitHubEvent("pull_request", prPayload(s), fakeDeps);
  assert.equal(again.changes, 0, "same merge commit + surface never records twice");
});

test("non-merge closes, unknown installations, and non-member actors are safe no-ops", async () => {
  const s = await setup();
  const closedUnmerged = await processGitHubEvent(
    "pull_request",
    prPayload(s, { pull_request: { number: 8, merged: false, merge_commit_sha: "x" } }),
    fakeDeps,
  );
  assert.equal(closedUnmerged.handled, false);

  const unknownInstall = await processGitHubEvent(
    "pull_request",
    prPayload(s, { installation: { id: 1 } }),
    fakeDeps,
  );
  assert.equal(unknownInstall.skipped, "unknown installation");

  const stranger = await processGitHubEvent(
    "pull_request",
    prPayload(s, {
      sender: { id: 42, login: "someone-else" },
      pull_request: { number: 9, title: "t", merged: true, merge_commit_sha: `sha2-${s.n}`, merged_by: { id: 42, login: "someone-else" } },
    }),
    fakeDeps,
  );
  assert.equal(stranger.skipped, "actor is not a member");
  assert.equal(stranger.changes, 0);
});

test("one remote connected to two projects records the change into each", async () => {
  const s = await setup();
  const second = await withSystem(async (tx) => {
    const proj = one(
      await tx.insert(projects).values({ orgId: s.orgId, name: `gh2-${s.n}`, createdBy: s.memberId }).returning(),
    );
    return one(
      await tx
        .insert(repos)
        .values({ orgId: s.orgId, projectId: proj.id, gitRemote: `github.com/acme/svc-${s.n}`, defaultBranch: "main" })
        .returning(),
    );
  });
  const res = await processGitHubEvent("pull_request", prPayload(s), fakeDeps);
  assert.equal(res.changes, 2, "both connected repos record the merge");
  const rows = await withOrg(s.orgId, (tx) =>
    tx
      .select()
      .from(changeFeedEntries)
      .where(and(eq(changeFeedEntries.surface, "http:POST /auth/session"), eq(changeFeedEntries.repoId, second.id))),
  );
  assert.equal(rows.length, 1);
});
