/**
 * Gateway event drain (the fast loop): claim pending Slack-event units from core, re-fetch each
 * thread via the connector (sweep-identical granularity → sweep-identical contentHash → the
 * ingest_artifacts barrier dedupes overlap), distill with the shared funnel phases, file proposals.
 * NEVER writes ingest_watermarks — the 15-min sweep stays cursor authority and backstop.
 */
import type { PendingEventBatch, ProposedItem } from "./client.js";
import type { Unit } from "./connectors/SourceConnector.js";
import { runFunnelOnUnits } from "./funnel.js";

/** The slice of LockstepClient the drain needs — narrow so tests fake it (writeback.ts pattern). */
export interface EventsClient {
  getPendingEvents(): Promise<PendingEventBatch[]>;
  markEventsDone(ids: string[], ok: boolean): Promise<void>;
  postProposed(items: ProposedItem[]): Promise<{ filed: number; deduped: number }>;
}

export interface EventDrainDeps {
  /** Build a thread-fetcher for a batch's connection (Composio in prod, stub in tests). */
  fetcherFor: (batch: PendingEventBatch) => {
    fetchThreadUnit: (channel: string, threadTs: string) => Promise<Unit | null>;
  } | null;
  useHaiku?: boolean;
  log?: (msg: string) => void;
  recallFn?: (text: string, useHaiku: boolean) => Promise<boolean>;
  extractFn?: Parameters<typeof runFunnelOnUnits>[0]["extractFn"];
}

export async function drainEvents(
  ls: EventsClient,
  deps: EventDrainDeps,
): Promise<{ processed: number; proposed: number; failed: number }> {
  const log = deps.log ?? (() => {});
  const batches = await ls.getPendingEvents();
  let processed = 0;
  let proposed = 0;
  let failed = 0;
  for (const b of batches) {
    const fetcher = deps.fetcherFor(b);
    if (!fetcher) {
      await ls.markEventsDone(b.events.map((e) => e.id), false);
      failed += b.events.length;
      continue;
    }
    const okIds: string[] = [];
    const failIds: string[] = [];
    const units: Array<{ unit: Unit; projectId: string }> = [];
    for (const ev of b.events) {
      try {
        const unit = await fetcher.fetchThreadUnit(ev.sourceRef, ev.threadTs);
        // A vanished thread (deleted root) is DONE, not failed — retrying can't bring it back.
        if (unit) units.push({ unit, projectId: ev.projectId });
        okIds.push(ev.id);
      } catch {
        failIds.push(ev.id);
      }
    }
    try {
      if (units.length > 0) {
        const { items, stats } = await runFunnelOnUnits({
          units,
          orgId: b.orgId,
          connectionId: b.connectionId,
          tool: b.tool,
          useHaiku: deps.useHaiku,
          log,
          recallFn: deps.recallFn,
          extractFn: deps.extractFn,
        });
        const res = await ls.postProposed(items);
        proposed += res.filed;
        log(
          `[events] connection ${b.connectionId}: units=${units.length} recalled=${stats.recalled} ` +
            `proposed=${stats.proposed} → filed=${res.filed} deduped=${res.deduped}`,
        );
      }
      await ls.markEventsDone(okIds, true);
      processed += okIds.length;
    } catch (e) {
      // Distillation/post failure: release the whole batch for retry (attempt-capped server-side).
      log(`[events] batch failed for ${b.connectionId}: ${e instanceof Error ? e.message : String(e)}`);
      failIds.push(...okIds);
    }
    if (failIds.length > 0) {
      await ls.markEventsDone(failIds, false);
      failed += failIds.length;
    }
  }
  return { processed, proposed, failed };
}
