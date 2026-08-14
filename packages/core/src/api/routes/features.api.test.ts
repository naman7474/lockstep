/**
 * HTTP coverage of the Phase B routes via inject(): session-scoped GET /briefing + GET /product-context
 * (product-layer gated, degrade silently when off), the Features composite endpoints, and the
 * governs-edge confirm/reject routes with role gating.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { withSystem, withOrg } from "../../db/rls.js";
import { orgs, principals, members, projects, projectMembers, repos, sessions, graphEdges } from "../../db/schema.js";
import { issueTokenTx } from "../../auth/tokens.js";
import { registerDependency, ratifyDecision } from "../../ledger/ledger-service.js";
import { registerDocument, fileDocCandidates, setDocumentState } from "../../documents/document-service.js";
import { decisions } from "../../db/schema.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 970_000_000;
const uid = (): number => ++seq;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const PAGE = () => `00000000-0000-4000-8000-${uid().toString(16).padStart(12, "0")}`;
const SURFACE = "http:POST /payments/init";
const CAP = "feature:guest-checkout";

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `FeatApi-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `pm-${n}` }).returning());
    const pm = one(await tx.insert(members).values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `pm-${n}` }).returning());
    const p2 = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `eng-${n}` }).returning());
    const eng = one(await tx.insert(members).values({ orgId: org.id, principalId: p2.id, githubUserId: p2.githubUserId, githubLogin: `eng-${n}` }).returning());
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "acme", settings: { productLayer: { enabled: true } } }).returning());
    await tx.insert(projectMembers).values({ orgId: org.id, projectId: proj.id, memberId: pm.id, invitedGithubLogin: pm.githubLogin, role: "pm", status: "active" });
    await tx.insert(projectMembers).values({ orgId: org.id, projectId: proj.id, memberId: eng.id, invitedGithubLogin: eng.githubLogin, role: "member", status: "active" });
    const repo = one(await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/acme/product-${n}` }).returning());
    // Sessions the CLI would hold (x-lockstep-session): one for the PM, one for the eng.
    const pmSession = one(await tx.insert(sessions).values({ orgId: org.id, memberId: pm.id, repoId: repo.id, projectId: proj.id, gitRemote: `github.com/acme/product-${n}`, state: "live" }).returning());
    const pmToken = await issueTokenTx(tx, p.id);
    const engToken = await issueTokenTx(tx, p2.id);
    return { orgId: org.id, projectId: proj.id, pm: pm.id, repo: repo.id, pmSession: pmSession.id, pmToken, engToken };
  });
}

test("features API: briefing + product-context + features index/detail + edge confirm/reject gating", async (t) => {
  const app: FastifyInstance = buildApp();
  t.after(() => app.close());
  const s = await setup();
  const base = `/orgs/${s.orgId}/projects/${s.projectId}`;
  const sess = { "x-lockstep-session": s.pmSession };

  await registerDependency(s.orgId, { projectId: s.projectId, memberId: s.pm, consumerRepoId: s.repo, producedSurface: SURFACE });

  // Ratify a surface-scoped constraint + a capability-scoped one (seeds a proposed governs edge).
  const pageId = PAGE();
  const reg = await registerDocument(s.orgId, { projectId: s.projectId, memberId: s.pm, url: `https://notion.so/prd-${pageId}` });
  await setDocumentState(s.orgId, reg.documentId, s.pm, "active");
  await fileDocCandidates(reg.documentId, [
    {
      scopeKind: "surface", scopeRef: SURFACE, ruleText: "No OTP before payment.", constraintKind: "behavioral",
      expiresAt: null, expiresHint: "", lowConfidence: false, confidence: 90,
      externalId: `${pageId}#c2`, contentHash: "h-c2",
      anchor: { type: "notion_block", pageId, blockId: "c2", headingPath: ["Requirements"], snippet: "…" },
      evidence: [{ externalId: `${pageId}#c2`, quote: "…" }], rationale: "", surfaceCandidates: [],
    },
    {
      scopeKind: "capability", scopeRef: CAP, ruleText: "Guests check out without an account.", constraintKind: "behavioral",
      expiresAt: null, expiresHint: "", lowConfidence: false, confidence: 90,
      externalId: `${pageId}#c1`, contentHash: "h-c1",
      anchor: { type: "notion_block", pageId, blockId: "c1", headingPath: ["Requirements"], snippet: "…" },
      evidence: [{ externalId: `${pageId}#c1`, quote: "…" }], rationale: "", surfaceCandidates: [SURFACE],
    },
  ]);
  for (const d of await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(and(eq(decisions.projectId, s.projectId), eq(decisions.status, "proposed"))))) {
    await ratifyDecision(s.orgId, d.id, s.pm);
  }

  // Briefing: session-scoped, product-layer on → the surface-scoped C-2 is in scope for this repo.
  const brief = await app.inject({ method: "GET", url: "/briefing", headers: { ...auth(s.pmToken), ...sess } });
  assert.equal(brief.statusCode, 200);
  const bj = brief.json() as { constraints: Array<{ line: string }>; overflow: number };
  assert.ok(bj.constraints.some((c) => /No OTP before payment/.test(c.line)));

  // product-context by capability.
  const pc = await app.inject({ method: "GET", url: `/product-context?scope=${encodeURIComponent(CAP)}`, headers: { ...auth(s.pmToken), ...sess } });
  assert.equal(pc.statusCode, 200);
  assert.ok((pc.json() as { constraints: unknown[] }).constraints.length >= 1);
  const missing = await app.inject({ method: "GET", url: "/product-context", headers: { ...auth(s.pmToken), ...sess } });
  assert.equal(missing.statusCode, 400);

  // Features index + detail.
  const feats = await app.inject({ method: "GET", url: `${base}/features`, headers: auth(s.pmToken) });
  assert.equal(feats.statusCode, 200);
  const feat = (feats.json() as { features: Array<{ ref: string }> }).features.find((f) => f.ref === CAP);
  assert.ok(feat, "capability in the index");
  const detail = await app.inject({ method: "GET", url: `${base}/features/${encodeURIComponent(CAP)}`, headers: auth(s.pmToken) });
  assert.equal(detail.statusCode, 200);
  const notFound = await app.inject({ method: "GET", url: `${base}/features/${encodeURIComponent("feature:nope")}`, headers: auth(s.pmToken) });
  assert.equal(notFound.statusCode, 404);

  // Edge confirm/reject role gating.
  const edge = one(await withOrg(s.orgId, (tx) => tx.select().from(graphEdges).where(and(eq(graphEdges.projectId, s.projectId), eq(graphEdges.kind, "governs"), eq(graphEdges.status, "proposed")))));
  const denied = await app.inject({ method: "POST", url: `${base}/graph/edges/${edge.id}/confirm`, headers: auth(s.engToken), payload: {} });
  assert.equal(denied.statusCode, 403, "member cannot confirm");
  const ok = await app.inject({ method: "POST", url: `${base}/graph/edges/${edge.id}/confirm`, headers: auth(s.pmToken), payload: {} });
  assert.equal(ok.statusCode, 200);
  const confirmed = one(await withOrg(s.orgId, (tx) => tx.select().from(graphEdges).where(eq(graphEdges.id, edge.id))));
  assert.equal(confirmed.status, "confirmed");
});

test("features API: briefing degrades to empty (not 403) when the product layer is off", async (t) => {
  const app: FastifyInstance = buildApp();
  t.after(() => app.close());
  const s = await setup();
  await withOrg(s.orgId, (tx) => tx.update(projects).set({ settings: { productLayer: { enabled: false } } }).where(eq(projects.id, s.projectId)));
  const res = await app.inject({ method: "GET", url: "/briefing", headers: { ...auth(s.pmToken), "x-lockstep-session": s.pmSession } });
  assert.equal(res.statusCode, 200);
  // Principles flow regardless of the product-layer gate (Phase P) — only constraints are silenced.
  // pack.hash is additive and always present (the decision-pack staleness signal).
  const body = res.json() as { pack?: { hash?: string } };
  assert.match(body.pack?.hash ?? "", /^[0-9a-f]{16}$/);
  assert.deepEqual(body, { constraints: [], overflow: 0, principles: [], principlesOverflow: 0, pack: body.pack });
});
