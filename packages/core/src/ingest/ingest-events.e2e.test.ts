/**
 * ingest_events claim/lease lifecycle (gateway): enqueue gating, batch grouping per connection,
 * lease + requeue of stale processing rows, fail-after-3, and completion semantics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { withSystem } from "../db/rls.js";
import { orgs, principals, members, projects, sourceConnections, ingestAllowlist, ingestEvents } from "../db/schema.js";
import { enqueueSlackEvent, claimPendingEvents, completeEvents } from "./ingest-events-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 920_000_000;
const uid = (): number => ++seq;

async function setup(opts?: { archived?: boolean; enabled?: boolean; connStatus?: string }) {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `Ev-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: n, githubLogin: `ev-${n}` }).returning());
    const m = one(
      await tx.insert(members).values({ orgId: org.id, principalId: p.id, githubUserId: n, githubLogin: `ev-${n}` }).returning(),
    );
    const proj = one(
      await tx
        .insert(projects)
        .values({ orgId: org.id, name: `ev-${n}`, createdBy: m.id, settings: opts?.archived ? { archived: true } : null })
        .returning(),
    );
    const conn = one(
      await tx
        .insert(sourceConnections)
        .values({ orgId: org.id, tool: "slack", entity: org.id, status: opts?.connStatus ?? "active" })
        .returning(),
    );
    const channel = `C${n}`;
    await tx.insert(ingestAllowlist).values({
      orgId: org.id,
      projectId: proj.id,
      connectionId: conn.id,
      sourceKind: "channel",
      sourceRef: channel,
      enabled: opts?.enabled ?? true,
    });
    return { orgId: org.id, projectId: proj.id, connectionId: conn.id, channel };
  });
}

test("enqueue gates on allowlist, connection status, and archived projects", async () => {
  const s = await setup();
  assert.equal(await enqueueSlackEvent({ channel: s.channel, ts: "1.0" }), true);
  assert.equal(await enqueueSlackEvent({ channel: "C-unknown", ts: "1.0" }), false);

  const disabled = await setup({ enabled: false });
  assert.equal(await enqueueSlackEvent({ channel: disabled.channel, ts: "1.0" }), false);
  const revoked = await setup({ connStatus: "revoked" });
  assert.equal(await enqueueSlackEvent({ channel: revoked.channel, ts: "1.0" }), false);
  const archived = await setup({ archived: true });
  assert.equal(await enqueueSlackEvent({ channel: archived.channel, ts: "1.0" }), false);
});

test("claim leases queued rows grouped per connection; done completes them", async () => {
  const s = await setup();
  await enqueueSlackEvent({ channel: s.channel, ts: "10.1" });
  await enqueueSlackEvent({ channel: s.channel, ts: "20.1" }); // separate thread → separate unit

  const batches = (await claimPendingEvents()).filter((b) => b.connectionId === s.connectionId);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.events.length, 2);
  assert.equal(batches[0]!.events[0]!.threadTs, "10.1");

  const claimedTwice = (await claimPendingEvents()).filter((b) => b.connectionId === s.connectionId);
  assert.equal(claimedTwice.length, 0, "leased rows are not claimable again");

  const ids = batches[0]!.events.map((e) => e.id);
  await completeEvents(ids, true);
  const rows = await withSystem((tx) => tx.select().from(ingestEvents).where(eq(ingestEvents.orgId, s.orgId)));
  assert.ok(rows.every((r) => r.status === "done" && r.processedAt !== null));

  // A NEW message in a completed thread re-opens a fresh unit (the partial index only spans open rows).
  assert.equal(await enqueueSlackEvent({ channel: s.channel, ts: "10.2", threadTs: "10.1" }), true);
  const reopened = await withSystem((tx) => tx.select().from(ingestEvents).where(eq(ingestEvents.orgId, s.orgId)));
  assert.equal(reopened.length, 3);
});

test("failed handling requeues, then fails at the attempt cap; stale leases requeue", async () => {
  const s = await setup();
  await enqueueSlackEvent({ channel: s.channel, ts: "30.1" });

  // attempts 1 and 2: !ok → requeued; attempt 3: !ok → failed (cap).
  for (let round = 1; round <= 3; round++) {
    const batches = (await claimPendingEvents()).filter((b) => b.connectionId === s.connectionId);
    assert.equal(batches.length, 1, `round ${round} claims the row`);
    await completeEvents([batches[0]!.events[0]!.id], false);
  }
  const rows = await withSystem((tx) => tx.select().from(ingestEvents).where(eq(ingestEvents.orgId, s.orgId)));
  assert.equal(rows[0]!.status, "failed");
  assert.equal(rows[0]!.attempts, 3);

  // Stale lease: a processing row whose lease expired requeues on the next claim pass (attempts < cap).
  await enqueueSlackEvent({ channel: s.channel, ts: "40.1" });
  const claimed = (await claimPendingEvents()).filter((b) => b.connectionId === s.connectionId);
  assert.equal(claimed.length, 1);
  await withSystem((tx) =>
    tx
      .update(ingestEvents)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(ingestEvents.id, claimed[0]!.events[0]!.id)),
  );
  const reclaimed = (await claimPendingEvents()).filter((b) => b.connectionId === s.connectionId);
  assert.equal(reclaimed.length, 1, "expired lease is claimable again");
});
