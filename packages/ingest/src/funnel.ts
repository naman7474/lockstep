import { createHash } from "node:crypto";
import type { SourceConnector, Unit } from "./connectors/SourceConnector.js";
import type { ProposedItem } from "./client.js";
import { recall as defaultRecall } from "./distill/recall.js";
import { extract as defaultExtract, extractBatch } from "./distill/extract.js";
import { gate } from "./distill/gate.js";
import { resolveScope } from "./distill/scope.js";
import { parseExpiresHint } from "./distill/expiry.js";
import { MODELS } from "./distill/llm.js";
import type { Extraction } from "./distill/rubric.js";

export interface FunnelStats {
  seen: number;
  recalled: number;
  proposed: number;
  questions: number;
  discarded: number;
}
export interface FunnelResult {
  items: ProposedItem[];
  cursors: Record<string, string>;
  stats: FunnelStats;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Retention/redaction: strip obvious secrets/PII before any text leaves for the LLM or is stored as
 * evidence. Conservative — emails, bearer tokens, and long key-like strings. (Phase 4 hardening.)
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b(?:sk|xox[baprs]|ghp|gho|glpat|AKIA)[-_A-Za-z0-9]{8,}\b/g, "[token]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, "Bearer [token]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[hash]");
}

/**
 * The Part-A funnel (stages 0–6) over every allowlisted source of one connection. Two-phase so the
 * expensive extraction can run inline (fast, interactive) or via the Anthropic Batch API (--batch,
 * 50% cost, for scheduled sweeps). Idempotency is enforced server-side on (connectionId, externalId,
 * contentHash) by fileProposedDecision.
 */
export async function runFunnel(opts: {
  connector: SourceConnector;
  orgId: string;
  /** Fallback routing target when a source doesn't carry its own projectId (#10: they normally do). */
  projectId: string;
  connectionId: string;
  sources: Array<{ sourceRef: string; cursor: string | null; projectId?: string }>;
  tool?: string;
  useHaiku?: boolean;
  batch?: boolean;
  log?: (msg: string) => void;
  // Injectable for tests — default to the real Haiku/Sonnet stages.
  recallFn?: (text: string, useHaiku: boolean) => Promise<boolean>;
  extractFn?: (externalId: string, text: string) => Promise<Extraction>;
  batchExtractFn?: (items: Array<{ externalId: string; text: string }>) => Promise<Map<string, Extraction>>;
}): Promise<FunnelResult> {
  const log = opts.log ?? (() => {});

  // Phase 1 — collect units + advance cursors.
  // #10: each source routes to ITS allowlist row's project — remember it per sourceRef.
  const projectFor = new Map<string, string>();
  for (const src of opts.sources) projectFor.set(src.sourceRef, src.projectId ?? opts.projectId);
  const cursors: Record<string, string> = {};
  const collected: Array<{ unit: Unit; projectId: string }> = [];
  for (const src of opts.sources) {
    const units = await opts.connector.listUnitsSince(src.sourceRef, src.cursor);
    log(`  ${src.sourceRef}: ${units.length} unit(s) since cursor`);
    let maxTs = src.cursor ?? "0";
    for (const u of units) {
      if (u.ts > maxTs) maxTs = u.ts;
      collected.push({ unit: u, projectId: projectFor.get(u.sourceRef) ?? opts.projectId });
    }
    cursors[src.sourceRef] = maxTs;
  }

  const { items, stats } = await runFunnelOnUnits({ ...opts, units: collected });
  return { items, cursors, stats };
}

/**
 * The distillation phases (recall → extract → gate → scope) over pre-collected units. Shared by the
 * sweep (which collects via cursors above) and the gateway event drain (which re-fetches one thread
 * per Slack event) — same unit granularity, same contentHash, so fileProposedDecision's
 * (connectionId, externalId, contentHash) barrier dedupes overlap between the two paths.
 */
export async function runFunnelOnUnits(opts: {
  units: Array<{ unit: Unit; projectId: string }>;
  orgId: string;
  connectionId: string;
  tool?: string;
  useHaiku?: boolean;
  batch?: boolean;
  log?: (msg: string) => void;
  recallFn?: (text: string, useHaiku: boolean) => Promise<boolean>;
  extractFn?: (externalId: string, text: string) => Promise<Extraction>;
  batchExtractFn?: (items: Array<{ externalId: string; text: string }>) => Promise<Map<string, Extraction>>;
}): Promise<{ items: ProposedItem[]; stats: FunnelStats }> {
  const log = opts.log ?? (() => {});
  const source = opts.tool ?? "slack";
  const recall = opts.recallFn ?? defaultRecall;
  const extract = opts.extractFn ?? defaultExtract;
  const batchExtract = opts.batchExtractFn ?? extractBatch;
  const stats: FunnelStats = { seen: 0, recalled: 0, proposed: 0, questions: 0, discarded: 0 };

  // Cheap recall filter.
  type Survivor = { unit: Unit; projectId: string; text: string };
  const survivors: Survivor[] = [];
  for (const { unit: u, projectId } of opts.units) {
    stats.seen++;
    const text = redactSecrets(u.text);
    if (!(await recall(text, opts.useHaiku ?? true))) {
      stats.discarded++;
      continue;
    }
    stats.recalled++;
    survivors.push({ unit: u, projectId, text });
  }

  // Phase 2 — extraction (batch or inline).
  const extractions = new Map<string, Awaited<ReturnType<typeof extract>>>();
  if (opts.batch) {
    log(`  batch-extracting ${survivors.length} survivor(s)…`);
    const res = await batchExtract(survivors.map((s) => ({ externalId: s.unit.externalId, text: s.text })));
    for (const [k, v] of res) extractions.set(k, v);
  } else {
    for (const s of survivors) extractions.set(s.unit.externalId, await extract(s.unit.externalId, s.text));
  }

  // Phase 3 — gate → scope → build proposed items.
  const items: ProposedItem[] = [];
  for (const s of survivors) {
    const u = s.unit;
    const x = extractions.get(u.externalId);
    if (!x) {
      stats.discarded++;
      continue;
    }
    const action = gate(x);
    if (action === "discard") {
      stats.discarded++;
      continue;
    }
    if (action === "question") {
      stats.questions++;
      log(`    ~ question (not agreed): ${x.rule_text.slice(0, 80)}`);
      continue;
    }
    const scope = resolveScope(x.surface_candidates, x.scope_hint);
    // Review tripwire (Phase J): calendar-anchored "revisit …" phrasing resolves to a date; an
    // event-relative hint ("after launch") keeps the verbatim text in provenance with no date.
    const reviewAt = parseExpiresHint(x.review_hint ?? "", new Date());
    items.push({
      orgId: opts.orgId,
      projectId: s.projectId,
      scopeKind: scope.scopeKind,
      scopeRef: scope.scopeRef,
      ruleText: x.rule_text,
      decisionType: x.decision_type === "architecture" ? "architecture" : "rule",
      provenance: {
        source,
        connectionId: opts.connectionId,
        externalId: u.externalId,
        url: u.permalink ?? null,
        evidence: x.evidence,
        extractorModel: MODELS.extract,
        confidence: x.confidence,
        decidedBy: x.decided_by,
        decidedAt: u.ts,
        scopeHint: x.scope_hint,
        rationale: x.rationale,
        alternatives: x.alternatives_considered,
        reviewHint: x.review_hint || undefined,
      },
      connectionId: opts.connectionId,
      externalId: u.externalId,
      contentHash: sha256(u.text),
      confidence: Math.round(x.confidence * 100),
      rationale: x.rationale || undefined,
      alternatives: x.alternatives_considered?.length ? x.alternatives_considered : undefined,
      reviewAt: reviewAt ? reviewAt.toISOString() : null,
    });
    stats.proposed++;
    log(`    ✓ proposed [${scope.scopeRef}] ${x.rule_text.slice(0, 80)}`);
  }
  return { items, stats };
}
