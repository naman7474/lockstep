/**
 * Slack Events ingress (gateway): challenge echo, allowlist gating, thread coalescing via the
 * partial unique index, and bot/subtype filtering. Signed-flow tests run only when
 * LOCKSTEP_SLACK_SIGNING_SECRET is set (the slack-actions.test.ts conditional pattern).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { env } from "../../env.js";
import { withSystem } from "../../db/rls.js";
import { orgs, principals, members, projects, sourceConnections, ingestAllowlist, ingestEvents } from "../../db/schema.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 930_000_000;
const uid = (): number => ++seq;

function sign(body: string) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature = `v0=${createHmac("sha256", env.LOCKSTEP_SLACK_SIGNING_SECRET!).update(`v0:${ts}:${body}`).digest("hex")}`;
  return { "x-slack-request-timestamp": ts, "x-slack-signature": signature, "content-type": "application/json" };
}

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `SlackEv-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: n, githubLogin: `se-${n}` }).returning());
    const m = one(
      await tx.insert(members).values({ orgId: org.id, principalId: p.id, githubUserId: n, githubLogin: `se-${n}` }).returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: `se-${n}`, createdBy: m.id }).returning());
    const conn = one(
      await tx
        .insert(sourceConnections)
        .values({ orgId: org.id, tool: "slack", entity: org.id, status: "active", connectedAccountId: `ca-${n}` })
        .returning(),
    );
    const channel = `C${n}`;
    await tx.insert(ingestAllowlist).values({
      orgId: org.id,
      projectId: proj.id,
      connectionId: conn.id,
      sourceKind: "channel",
      sourceRef: channel,
      sourceName: "#eng",
      enabled: true,
    });
    return { orgId: org.id, projectId: proj.id, connectionId: conn.id, channel, n };
  });
}

const messageEvent = (channel: string, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "event_callback", event: { type: "message", channel, ts, ...extra } });

test("slack events route", async (t) => {
  const app: FastifyInstance = buildApp();
  t.after(() => app.close());

  if (!env.LOCKSTEP_SLACK_SIGNING_SECRET) {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/slack/events",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    assert.equal(res.statusCode, 503, "unset secret → 503");
    return;
  }

  await t.test("url_verification echoes the challenge", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "chal-123" });
    const res = await app.inject({ method: "POST", url: "/webhooks/slack/events", headers: sign(body), payload: body });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().challenge, "chal-123");
  });

  await t.test("bad signature is rejected", async () => {
    const body = messageEvent("C1", "1.0");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/slack/events",
      headers: { ...sign(body), "x-slack-signature": "v0=deadbeef" },
      payload: body,
    });
    assert.equal(res.statusCode, 401);
  });

  await t.test("allowlisted message enqueues; thread replies coalesce into one open unit", async () => {
    const s = await setup();
    const root = messageEvent(s.channel, "100.1");
    const r1 = await app.inject({ method: "POST", url: "/webhooks/slack/events", headers: sign(root), payload: root });
    assert.equal(r1.statusCode, 200);

    // Two replies in the same thread + a Slack retry of the first — all one open unit.
    for (const ts of ["100.2", "100.3", "100.2"]) {
      const reply = messageEvent(s.channel, ts, { thread_ts: "100.1" });
      await app.inject({ method: "POST", url: "/webhooks/slack/events", headers: sign(reply), payload: reply });
    }
    const rows = await withSystem((tx) => tx.select().from(ingestEvents).where(eq(ingestEvents.orgId, s.orgId)));
    assert.equal(rows.length, 1, "root + replies + retry coalesce on (connection, threadKey)");
    assert.equal(rows[0]!.threadKey, `${s.channel}/100.1`);
    assert.equal(rows[0]!.status, "queued");
    assert.equal(rows[0]!.projectId, s.projectId);
  });

  await t.test("bot messages, subtyped noise, and non-allowlisted channels are dropped", async () => {
    const s = await setup();
    const bot = messageEvent(s.channel, "200.1", { bot_id: "B1" });
    await app.inject({ method: "POST", url: "/webhooks/slack/events", headers: sign(bot), payload: bot });
    const joined = messageEvent(s.channel, "200.2", { subtype: "channel_join" });
    await app.inject({ method: "POST", url: "/webhooks/slack/events", headers: sign(joined), payload: joined });
    const wrongChannel = messageEvent(`C-other-${s.n}`, "200.3");
    await app.inject({ method: "POST", url: "/webhooks/slack/events", headers: sign(wrongChannel), payload: wrongChannel });

    const rows = await withSystem((tx) => tx.select().from(ingestEvents).where(eq(ingestEvents.orgId, s.orgId)));
    assert.equal(rows.length, 0);
  });
});
