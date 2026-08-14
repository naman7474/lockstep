/**
 * scheduled_jobs (gateway): due-claim with lease, reschedule-from-now on completion, one-shot
 * behavior, lease-expiry reclaim, and concurrent-claim exclusivity (FOR UPDATE SKIP LOCKED).
 * Uses per-test singleton keys so runs never collide with the seeded expiry/digest/drain jobs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { withSystem } from "../db/rls.js";
import { scheduledJobs } from "../db/schema.js";
import { claimDueJobs, completeJob } from "./jobs-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 910_000_000;
const uid = (): number => ++seq;

const insertJob = (kind: string, over: Partial<typeof scheduledJobs.$inferInsert> = {}) =>
  withSystem(async (tx) =>
    one(
      await tx
        .insert(scheduledJobs)
        .values({ kind, singletonKey: `${kind}-${uid()}`, runAt: new Date(Date.now() - 1000), ...over })
        .returning(),
    ),
  );

const jobRow = (id: string) =>
  withSystem(async (tx) => one(await tx.select().from(scheduledJobs).where(eq(scheduledJobs.id, id))));

test("due jobs claim once (lease), reschedule from now on completion", async () => {
  const job = await insertJob("test-recurring", { intervalSeconds: 3600 });
  const claimed = (await claimDueJobs()).filter((j) => j.id === job.id);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]!.kind, "test-recurring");

  const again = (await claimDueJobs()).filter((j) => j.id === job.id);
  assert.equal(again.length, 0, "leased job is not claimable");

  const before = Date.now();
  const done = await completeJob(job.id, true);
  const row = await jobRow(job.id);
  assert.equal(row.lastStatus, "ok");
  assert.equal(row.lockedUntil, null);
  assert.ok(row.runAt.getTime() >= before + 3600_000 - 5000, "recurring job marches forward from NOW");
  assert.equal(done.rescheduledFor, row.runAt.toISOString());

  const notDue = (await claimDueJobs()).filter((j) => j.id === job.id);
  assert.equal(notDue.length, 0, "rescheduled job is no longer due");
});

test("one-shot completes inert; failures record last_error", async () => {
  const job = await insertJob("test-oneshot", { intervalSeconds: null });
  assert.equal((await claimDueJobs()).filter((j) => j.id === job.id).length, 1);
  const done = await completeJob(job.id, false, "boom");
  assert.equal(done.rescheduledFor, null);
  const row = await jobRow(job.id);
  assert.equal(row.lastStatus, "error");
  assert.equal(row.lastError, "boom");
  // run_at unchanged (past) but the lease is cleared — a one-shot IS claimable again after failure,
  // which is the retry story for one-shots; recurring jobs retry on their next interval instead.
  assert.equal((await claimDueJobs()).filter((j) => j.id === job.id).length, 1);
});

test("expired lease is claimable again (crashed-worker recovery)", async () => {
  const job = await insertJob("test-lease", { intervalSeconds: 60 });
  assert.equal((await claimDueJobs()).filter((j) => j.id === job.id).length, 1);
  await withSystem((tx) =>
    tx.update(scheduledJobs).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(scheduledJobs.id, job.id)),
  );
  assert.equal((await claimDueJobs()).filter((j) => j.id === job.id).length, 1, "stale lease reclaims");
});

test("concurrent claims never double-run a job (SKIP LOCKED)", async () => {
  const job = await insertJob("test-concurrent", { intervalSeconds: 60 });
  const [a, b] = await Promise.all([claimDueJobs(), claimDueJobs()]);
  const hits = [...a, ...b].filter((j) => j.id === job.id);
  assert.equal(hits.length, 1, "exactly one of two concurrent claims wins");
});
