/**
 * Slack Events ingress (gateway): core verifies + enqueues REFS; the worker distills.
 *
 * Core never stores message text (no raw content in core, and the LLM key lives only in the
 * worker). A message event becomes an ingest_events row keyed on the sweep's unit granularity —
 * thread_key = `${channel}/${thread_ts ?? ts}` — so the worker re-fetches the WHOLE thread via the
 * connector and files it with the same externalId/contentHash a sweep would produce; the
 * ingest_artifacts barrier then dedupes push/sweep overlap for free. The event path NEVER touches
 * ingest_watermarks: the 15-min sweep stays cursor authority and the self-healing backstop.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { withSystem } from "../db/rls.js";
import { ingestEvents, ingestAllowlist, sourceConnections, projects } from "../db/schema.js";
import { projectArchived } from "../auth/permissions.js";

const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

/**
 * Enqueue a Slack message event. Gate = the allowlist (channel → project), same routing authority
 * as sweeps. Returns false when the channel isn't allowlisted / connection inactive / project
 * archived — the event is dropped. Thread coalescing rides the partial unique index
 * (connection_id, thread_key) WHERE status IN ('queued','processing').
 */
export async function enqueueSlackEvent(ev: {
  channel: string;
  ts: string;
  threadTs?: string;
}): Promise<boolean> {
  return withSystem(async (tx) => {
    const rows = await tx
      .select({
        allow: ingestAllowlist,
        conn: sourceConnections,
      })
      .from(ingestAllowlist)
      .innerJoin(sourceConnections, eq(ingestAllowlist.connectionId, sourceConnections.id))
      .where(
        and(
          eq(ingestAllowlist.sourceRef, ev.channel),
          eq(ingestAllowlist.enabled, true),
          eq(sourceConnections.tool, "slack"),
          eq(sourceConnections.status, "active"),
        ),
      );
    const hit = rows[0];
    if (!hit) return false;
    const proj = (await tx.select().from(projects).where(eq(projects.id, hit.allow.projectId)).limit(1))[0];
    if (!proj || projectArchived(proj.settings)) return false;

    await tx
      .insert(ingestEvents)
      .values({
        orgId: hit.allow.orgId,
        projectId: hit.allow.projectId,
        connectionId: hit.allow.connectionId,
        sourceRef: ev.channel,
        threadKey: `${ev.channel}/${ev.threadTs ?? ev.ts}`,
        latestEventTs: ev.ts,
        status: "queued",
      })
      .onConflictDoNothing();
    return true;
  });
}

export interface PendingEventBatch {
  orgId: string;
  connectionId: string;
  tool: string;
  entity: string;
  connectedAccountId: string | null;
  events: Array<{ id: string; projectId: string; sourceRef: string; threadKey: string; threadTs: string }>;
}

/**
 * Claim queued events for the worker (lease + attempts, mirroring the writebacks posture): stale
 * `processing` rows are requeued (attempts < MAX) or failed, then queued rows are leased. Grouped
 * per connection so the worker builds one connector per batch.
 */
export async function claimPendingEvents(limit = 50): Promise<PendingEventBatch[]> {
  return withSystem(async (tx) => {
    const now = new Date();
    // Requeue or fail stale leases.
    const stale = await tx
      .select()
      .from(ingestEvents)
      .where(and(eq(ingestEvents.status, "processing"), lt(ingestEvents.lockedUntil, now)));
    for (const s of stale) {
      await tx
        .update(ingestEvents)
        .set(s.attempts >= MAX_ATTEMPTS ? { status: "failed", processedAt: now } : { status: "queued", lockedUntil: null })
        .where(eq(ingestEvents.id, s.id));
    }

    const lease = new Date(now.getTime() + LEASE_MS).toISOString();
    const claimed = await tx.execute(sql`
      UPDATE ingest_events SET status = 'processing', locked_until = ${lease}::timestamptz, attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM ingest_events WHERE status = 'queued' ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )
      RETURNING id, org_id, project_id, connection_id, source_ref, thread_key, latest_event_ts
    `);
    const rows = claimed as unknown as Array<{
      id: string;
      org_id: string;
      project_id: string;
      connection_id: string;
      source_ref: string;
      thread_key: string;
      latest_event_ts: string;
    }>;
    if (rows.length === 0) return [];

    const connIds = [...new Set(rows.map((r) => r.connection_id))];
    const conns = await tx.select().from(sourceConnections).where(inArray(sourceConnections.id, connIds));
    const byConn = new Map(conns.map((c) => [c.id, c]));
    const batches = new Map<string, PendingEventBatch>();
    for (const r of rows) {
      const conn = byConn.get(r.connection_id);
      if (!conn) continue;
      let b = batches.get(r.connection_id);
      if (!b) {
        b = {
          orgId: conn.orgId,
          connectionId: conn.id,
          tool: conn.tool,
          entity: conn.entity,
          connectedAccountId: conn.connectedAccountId,
          events: [],
        };
        batches.set(r.connection_id, b);
      }
      b.events.push({
        id: r.id,
        projectId: r.project_id,
        sourceRef: r.source_ref,
        threadKey: r.thread_key,
        // The thread root ts is the tail of the threadKey — the worker fetches root + replies.
        threadTs: r.thread_key.split("/")[1] ?? r.latest_event_ts,
      });
    }
    return [...batches.values()];
  });
}

/** Mark claimed events done, or release for retry — rows at the attempt cap fail instead. */
export async function completeEvents(ids: string[], ok: boolean): Promise<{ updated: number }> {
  if (ids.length === 0) return { updated: 0 };
  return withSystem(async (tx) => {
    if (ok) {
      const res = await tx
        .update(ingestEvents)
        .set({ status: "done", processedAt: new Date(), lockedUntil: null })
        .where(and(inArray(ingestEvents.id, ids), eq(ingestEvents.status, "processing")))
        .returning({ id: ingestEvents.id });
      return { updated: res.length };
    }
    const failed = await tx
      .update(ingestEvents)
      .set({ status: "failed", processedAt: new Date(), lockedUntil: null })
      .where(
        and(
          inArray(ingestEvents.id, ids),
          eq(ingestEvents.status, "processing"),
          sql`${ingestEvents.attempts} >= ${MAX_ATTEMPTS}`,
        ),
      )
      .returning({ id: ingestEvents.id });
    const requeued = await tx
      .update(ingestEvents)
      .set({ status: "queued", lockedUntil: null })
      .where(and(inArray(ingestEvents.id, ids), eq(ingestEvents.status, "processing")))
      .returning({ id: ingestEvents.id });
    return { updated: failed.length + requeued.length };
  });
}
