#!/usr/bin/env node
import { LockstepClient } from "./client.js";
import { StubConnector } from "./connectors/StubConnector.js";
import { ComposioConnector, type Tool } from "./connectors/ComposioConnector.js";
import { GDocsConnector } from "./connectors/GDocsConnector.js";
import { ConfluenceConnector } from "./connectors/ConfluenceConnector.js";
import { NangoConnector } from "./connectors/NangoConnector.js";
import type { DocumentConnector, SourceConnector } from "./connectors/SourceConnector.js";
import { runFunnel } from "./funnel.js";
import { runDocFunnel } from "./docFunnel.js";
import { drainWritebacks } from "./writeback.js";
import { drainEvents } from "./events.js";
import { runEval } from "./eval/run.js";
import { runDocEval } from "./eval/run-docs.js";
import type { SweptDoc } from "./client.js";

/**
 * lockstep-ingest — the v2 sweep worker CLI.
 *
 *   lockstep-ingest channels --entity <projectId>        list Slack channels (to find allowlist ids)
 *   lockstep-ingest connect  --connection <id> --entity <projectId>   run Composio OAuth, finalize
 *   lockstep-ingest sweep    [--stub] [--no-haiku]        one-shot: fetch → distill → propose
 *   lockstep-ingest serve    [--interval <sec>] [--fast-interval <sec>]
 *       two loops: the sweep (default 900s) + the gateway fast loop (default 60s) that drains live
 *       Slack-event units and executes scheduled jobs (expiry / weekly digests / writeback drain)
 *
 * Env: LOCKSTEP_API_URL, LOCKSTEP_INGEST_TOKEN, COMPOSIO_API_KEY, ANTHROPIC_API_KEY,
 *      SLACK_BOT_TOKEN (ratification digests — optional; digests stay queued without it).
 */

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function env(name: string, required = false): string {
  const v = process.env[name];
  if (!v && required) throw new Error(`${name} is required`);
  return v ?? "";
}
function client(): LockstepClient {
  return new LockstepClient(env("LOCKSTEP_API_URL") || "http://localhost:8080", env("LOCKSTEP_INGEST_TOKEN", true));
}
function composio(entity: string, tool: Tool = "slack"): ComposioConnector {
  return new ComposioConnector(env("COMPOSIO_API_KEY", true), entity, tool);
}
function toolFlag(): Tool {
  return (flag("tool") as Tool) ?? "slack";
}
/**
 * The native-registered doc sources (registered by URL, swept via their own Composio app) each get a
 * dedicated connector; every other tool routes through the connection's Composio connector (returns
 * null so the caller falls back). Keeps the gdocs/confluence pick in one place.
 */
function docConnectorFor(tool: string, entity: string): DocumentConnector | null {
  if (tool === "gdocs") return new GDocsConnector(env("COMPOSIO_API_KEY", true), entity);
  if (tool === "confluence") return new ConfluenceConnector(env("COMPOSIO_API_KEY", true), entity);
  return null;
}
/** Anchor addressing scheme per doc source — synthetic fuzzy keys for gdocs/confluence, block ids for Notion. */
function docAnchorType(tool: string): "notion_block" | "gdoc_fuzzy" | "confluence_xpath" {
  if (tool === "gdocs") return "gdoc_fuzzy";
  if (tool === "confluence") return "confluence_xpath";
  return "notion_block";
}

async function cmdChannels(): Promise<void> {
  const entity = flag("entity");
  if (!entity) throw new Error("--entity <projectId> required");
  const chans = await composio(entity, toolFlag()).listChannels();
  for (const c of chans) console.log(`${c.id}\t${c.name}`);
  console.log(`\n${chans.length} source(s). Add the ones you want swept in the dashboard Connections page.`);
}

async function cmdConnect(): Promise<void> {
  const connectionId = flag("connection");
  const entity = flag("entity");
  if (!connectionId || !entity) throw new Error("--connection <id> --entity <projectId> required");
  const conn = composio(entity, toolFlag());
  const { redirectUrl, connectedAccountId } = await conn.initiate();
  console.log(`\nAuthorize ${toolFlag()} here, then return:\n\n  ${redirectUrl}\n`);
  process.stdout.write("Waiting for authorization");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    process.stdout.write(".");
    if (await conn.isActive(connectedAccountId)) {
      await client().finalizeConnection(connectionId, connectedAccountId);
      console.log(`\n✓ Connected. Connection ${connectionId} is now active.`);
      return;
    }
  }
  console.log(`\nTimed out. Once authorized, finalize manually via the worker endpoint with account ${connectedAccountId}.`);
}

async function sweepOnce(): Promise<void> {
  const ls = client();
  const useStub = has("stub");
  const useNango = has("nango");
  const batch = has("batch");
  const useHaiku = !has("no-haiku");
  const work = await ls.getWork();
  console.log(`[sweep] ${work.length} connection(s) with allowlisted sources${batch ? " (batch mode)" : ""}`);
  for (const w of work) {
    if (!useStub && !w.connectedAccountId) {
      console.log(`[sweep] skip ${w.connectionId} (not connected)`);
      continue;
    }
    const connector: SourceConnector = useStub
      ? new StubConnector()
      : useNango
        ? new NangoConnector(env("NANGO_SECRET_KEY", true), w.connectedAccountId ?? w.entity, w.tool)
        : composio(w.entity, w.tool as Tool);
    console.log(`[sweep] connection ${w.connectionId} (${w.tool}) — ${w.sources.length} source(s)`);
    const { items, cursors, stats } = await runFunnel({
      connector,
      orgId: w.orgId,
      projectId: w.projectId,
      connectionId: w.connectionId,
      sources: w.sources.map((s) => ({ sourceRef: s.sourceRef, cursor: s.cursor, projectId: s.projectId })),
      tool: w.tool,
      useHaiku,
      batch,
      log: (m) => console.log(m),
    });
    const res = await ls.postProposed(items);
    for (const [sourceRef, cursor] of Object.entries(cursors)) {
      await ls.setWatermark(w.orgId, w.connectionId, sourceRef, cursor);
    }
    console.log(
      `[sweep] seen=${stats.seen} recalled=${stats.recalled} proposed=${stats.proposed} ` +
        `questions=${stats.questions} discarded=${stats.discarded} → filed=${res.filed} deduped=${res.deduped}`,
    );
    // Auto-link members.slack_user_id by email so ratification/drift/weekly digests actually deliver.
    // Idempotent (fills nulls only) + best-effort — a failed users-list never aborts the sweep.
    if (w.tool === "slack" && !useStub && !useNango) {
      try {
        const users = await (connector as ComposioConnector).listSlackUsers();
        const { matched } = await ls.reconcileSlackMembers(w.orgId, users);
        if (matched > 0) console.log(`[sweep] auto-linked ${matched} Slack member(s) by email`);
      } catch (e) {
        console.log(`[sweep] slack member reconcile skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  // v3 doc phase — its failure must never take the conversation sweep down with it.
  try {
    await docSweepOnce(ls, { useStub, useHaiku, batch });
  } catch (e) {
    console.error("[docs] doc sweep error:", e);
  }
  // Gateway note: expiry/weekly-digest/writeback-drain moved OFF the sweep tick onto scheduled_jobs
  // (the fast loop claims them) — a one-shot `sweep` still drains once below so it stays self-contained.
  if (process.argv[2] === "sweep") {
    try {
      await runWritebackDrain(ls, useStub);
    } catch (e) {
      console.error("[writebacks] drain error:", e);
    }
  }
  console.log("[sweep] done");
}

/**
 * The v3 document phase: sweep allowlisted PRD databases (listing → core upsert → extraction
 * directives), run the doc funnel on whatever core says changed (+ the standalone/native docs it
 * queued), then drain the write-back queue (conflict comments → Notion, ratification digests → Slack).
 */
async function docSweepOnce(
  ls: LockstepClient,
  opts: { useStub: boolean; useHaiku: boolean; batch: boolean },
): Promise<void> {
  const work = await ls.getDocumentWork();
  if (work.length === 0) return;
  console.log(`[docs] ${work.length} connection(s) with document work`);
  for (const w of work) {
    if (!opts.useStub && !w.connectedAccountId) {
      console.log(`[docs] skip ${w.connectionId} (not connected)`);
      continue;
    }
    const connector: DocumentConnector = opts.useStub ? new StubConnector() : composio(w.entity, w.tool as Tool);
    console.log(`[docs] connection ${w.connectionId} (${w.tool}) — ${w.containers.length} container(s), ${w.docs.length} native doc(s)`);
    // What to extract: directives from each container sweep, plus core's standalone/native docs. `tool`
    // rides on each target so a native GDocs doc gets a GDocsConnector while mirrored containers stay Notion.
    const targets: Array<{ docId: string; externalId: string; title: string; url: string | null; knownSectionHashes: string[]; tool: string }> = [];
    for (const c of w.containers) {
      const metas = await connector.listDocuments(c.containerRef, c.statusProperty);
      const metaByExt = new Map(metas.map((m) => [m.externalId, m]));
      const swept: SweptDoc[] = metas.map((m) => ({
        externalId: m.externalId,
        containerRef: m.containerRef,
        title: m.title,
        url: m.url,
        rawStateValue: m.rawStateValue,
        ownerRef: m.ownerRef,
        lastEditedTime: m.lastEditedTime,
      }));
      const directives = await ls.upsertDocuments(w.connectionId, swept);
      for (const d of directives) {
        if (!d.shouldExtract) continue;
        const meta = metaByExt.get(d.externalId);
        targets.push({
          docId: d.docId,
          externalId: d.externalId,
          title: meta?.title ?? d.externalId,
          url: meta?.url ?? null,
          knownSectionHashes: d.knownSectionHashes,
          tool: w.tool, // mirrored container docs stay on the connection's (Notion) tool
        });
      }
    }
    for (const d of w.docs) {
      targets.push({
        docId: d.docId,
        externalId: d.externalId,
        title: d.externalId,
        url: null,
        knownSectionHashes: d.knownSectionHashes,
        tool: d.tool ?? w.tool,
      });
    }
    for (const t of targets) {
      // GDocs/Confluence are separate, native-registered doc sources; every other tool routes through the
      // connection's Composio connector. In stub mode all targets share the one StubConnector (assertable, no network).
      const nativeConnector = opts.useStub ? null : docConnectorFor(t.tool, w.entity);
      const targetConnector: DocumentConnector = nativeConnector ?? connector;
      const { items, stats, docContentHash, extractedAnchorKeys, currentSections } = await runDocFunnel({
        connector: targetConnector,
        doc: { externalId: t.externalId, title: t.title, url: t.url },
        knownSectionHashes: t.knownSectionHashes,
        anchorType: docAnchorType(t.tool),
        useHaiku: opts.useHaiku,
        batch: opts.batch,
        log: (m) => console.log(m),
      });
      const res = await ls.postDocCandidates(t.docId, items, docContentHash, extractedAnchorKeys, currentSections);
      console.log(
        `[docs] doc ${t.title}: sections=${stats.sections} skipped=${stats.skipped} proposed=${stats.proposed} ` +
          `low=${stats.lowConfidence} → filed=${res.filed} reversioned=${res.reversioned} staled=${res.staled} conflicts=${res.conflicts}`,
      );
    }
  }
}

/**
 * Drain queued write-backs (Notion conflict comments, Slack digests/alerts). Gateway: runs on the
 * `writeback_drain` scheduled job in the fast loop — no longer coupled to document work existing
 * (the old placement inside docSweepOnce meant orgs with zero doc connections NEVER drained).
 * In stub mode everything routes to one StubConnector (assertable, no network).
 */
async function runWritebackDrain(ls: LockstepClient, useStub: boolean): Promise<void> {
  const stubConnector = useStub ? new StubConnector() : null;
  const { posted, failed } = await drainWritebacks(ls, {
    connectorFor: (row) => {
      if (stubConnector) return stubConnector;
      if (!row.connection?.connectedAccountId) return null;
      return (
        docConnectorFor(row.connection.tool, row.connection.entity) ??
        composio(row.connection.entity, row.connection.tool as Tool)
      );
    },
    slackBotToken: env("SLACK_BOT_TOKEN") || undefined,
    log: (m) => console.log(m),
  });
  if (posted + failed > 0) console.log(`[writebacks] posted=${posted} failed=${failed}`);
}

/**
 * The fast loop (gateway): drain live Slack-event units (≈real-time distillation instead of ≤15 min),
 * then claim + execute due scheduled jobs. Every step is try/caught — one failure never kills a loop.
 */
async function fastTick(ls: LockstepClient, useStub: boolean, useHaiku: boolean): Promise<void> {
  try {
    const r = await drainEvents(ls, {
      fetcherFor: (b) => {
        if (useStub) return new StubConnector();
        if (b.tool !== "slack" || !b.connectedAccountId) return null;
        return composio(b.entity, "slack");
      },
      useHaiku,
      log: (m) => console.log(m),
    });
    if (r.processed + r.failed > 0) console.log(`[events] processed=${r.processed} proposed=${r.proposed} failed=${r.failed}`);
  } catch (e) {
    console.error("[events] drain error:", e);
  }

  let jobs: Array<{ id: string; kind: string }> = [];
  try {
    jobs = await ls.claimJobs();
  } catch (e) {
    console.error("[jobs] claim error:", e);
  }
  for (const job of jobs) {
    try {
      switch (job.kind) {
        case "expiry": {
          const exp = await ls.runExpiry();
          if (exp.expired > 0) console.log(`[expiry] ${exp.expired} constraint(s) expired, ${exp.conflictsDismissed} conflict(s) dismissed`);
          break;
        }
        case "weekly_digest": {
          const wk = await ls.runWeeklyDigests();
          if (wk.enqueued > 0) console.log(`[weekly] ${wk.enqueued} digest(s) enqueued`);
          break;
        }
        case "writeback_drain":
          await runWritebackDrain(ls, useStub);
          break;
        default:
          console.log(`[jobs] unknown kind ${job.kind} — completing as error`);
          await ls.completeJob(job.id, false, `unknown kind ${job.kind}`);
          continue;
      }
      await ls.completeJob(job.id, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[jobs] ${job.kind} failed:`, msg);
      await ls.completeJob(job.id, false, msg).catch(() => {});
    }
  }
}

async function cmdServe(): Promise<void> {
  const interval = Number(flag("interval") ?? 900) * 1000;
  const fastInterval = Number(flag("fast-interval") ?? 60) * 1000;
  const ls = client();
  const useStub = has("stub");
  const useHaiku = !has("no-haiku");
  console.log(`[serve] sweeping every ${interval / 1000}s; fast loop (events + jobs) every ${fastInterval / 1000}s`);
  const sweepLoop = (async () => {
    for (;;) {
      try {
        await sweepOnce();
      } catch (e) {
        console.error("[serve] sweep error:", e);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  })();
  const fastLoop = (async () => {
    for (;;) {
      await fastTick(ls, useStub, useHaiku);
      await new Promise((r) => setTimeout(r, fastInterval));
    }
  })();
  await Promise.all([sweepLoop, fastLoop]);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "channels":
      return cmdChannels();
    case "connect":
      return cmdConnect();
    case "sweep":
      return sweepOnce();
    case "serve":
      return cmdServe();
    case "eval":
      return has("docs") ? runDocEval() : runEval();
    default:
      console.log("usage: lockstep-ingest <channels|connect|sweep|serve|eval> [flags]");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
