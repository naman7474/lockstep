import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { registerSession } from "../mcp/session.js";
import { call } from "../mcp/api.js";
import { gitRemote } from "../mcp/git.js";
import { readFeatureContext } from "./feature-context.js";
import { changedFiles } from "./diff.js";
import { isContractSurface, riskTierFor } from "./classify.js";
import { extractAllSurfaces } from "./extract.js";
import { readManifest } from "./manifest.js";

/** Sync this repo's declared dependencies (lockstep.yaml `consumes:`) into the usage graph. Idempotent. */
async function syncManifestDeps(cwd: string, sessionId: string): Promise<void> {
  const { consumes } = readManifest(cwd);
  for (const producedSurface of consumes) {
    await call("POST", "/dependencies", sessionId, { producedSurface, source: "manifest" }).catch(() => {});
  }
}

interface InboxResp {
  unread?: number;
  changes?: Array<{ summary: string; surface: string | null; impact?: number }>;
  questions?: Array<{ id: string; body: string; scopeRef: string | null; urgent: boolean; status: string }>;
  tasks?: Array<{ id: string; title: string; runState: string; status: string }>;
  decisions?: Array<{ id: string; scopeRef: string; ruleText: string; status: string; impact?: number }>;
  conflicts?: Array<{ id: string; surface: string; constraintRuleText: string; engRuleText: string }>;
}
interface DecisionsResp {
  decisions?: Array<{ scopeRef: string; status: string; ruleText: string; impact?: number }>;
}
/** Product-layer briefing: ranked, budget-capped constraints (origin=document, binding) in scope. */
export interface BriefingResp {
  constraints: Array<{ line: string; impact: number; conflictOpen: boolean }>;
  overflow: number;
  /** Phase P: binding decisionType=principle decisions — the team's standing decision criteria. */
  principles?: Array<{ line: string; impact: number }>;
  principlesOverflow?: number;
  /** Compiled decision-pack hash — compared against the locally-written pack for the staleness nudge. */
  pack?: { hash: string };
}

export type PackState = "stale" | "missing" | null;

/** Highest-blast-radius first, so the session-start briefing leads with what matters most. */
const byImpact = <T extends { impact?: number }>(a: T, b: T): number => (b.impact ?? 0) - (a.impact ?? 0);
const tag = (impact?: number): string => ((impact ?? 0) > 0 ? `[impact ${impact}] ` : "");

export function formatReplay(
  inbox: InboxResp | null,
  decisions: DecisionsResp | null,
  briefing?: BriefingResp | null,
  packState?: PackState,
): string {
  const lines: string[] = [];
  const changes = [...(inbox?.changes ?? [])].sort(byImpact);
  if (changes.length) {
    lines.push(`📥 ${changes.length} change(s) since you were last here:`);
    for (const c of changes.slice(0, 8))
      lines.push(`  • ${tag(c.impact)}${c.summary}${c.surface ? ` (${c.surface})` : ""}`);
  }
  const qs = (inbox?.questions ?? []).filter((q) => q.status === "open");
  if (qs.length) {
    lines.push(`❓ ${qs.length} open question(s) for you:`);
    for (const q of qs.slice(0, 8)) lines.push(`  • ${q.urgent ? "[URGENT] " : ""}${q.body}`);
  }
  const ts = (inbox?.tasks ?? []).filter((t) => t.status === "open");
  if (ts.length) {
    lines.push(`📋 ${ts.length} task(s) assigned to you:`);
    for (const t of ts.slice(0, 8)) lines.push(`  • ${t.title}`);
  }
  const pendingDecisions = (inbox?.decisions ?? []).filter((d) => d.status === "open");
  if (pendingDecisions.length) {
    lines.push(`⚖️ ${pendingDecisions.length} decision(s) pending your acknowledgment:`);
    for (const d of pendingDecisions.slice(0, 8)) lines.push(`  • [${d.scopeRef}] ${d.ruleText}`);
  }
  const conflicts = inbox?.conflicts ?? [];
  if (conflicts.length) {
    lines.push(`⚔️ ${conflicts.length} drift conflict(s) — your work may conflict with a ratified product constraint:`);
    for (const c of conflicts.slice(0, 8))
      lines.push(`  • [${c.surface}] your "${c.engRuleText}" vs constraint "${c.constraintRuleText}" — review both`);
  }
  // Principles lead — they're the criteria the agent should judge everything else by (TOMASP "M").
  const principles = briefing?.principles ?? [];
  if (principles.length) {
    lines.push(`◆ ${principles.length} project principle(s) — the team's standing decision criteria:`);
    for (const p of principles) lines.push(`  • ${p.line}`);
    if ((briefing?.principlesOverflow ?? 0) > 0)
      lines.push(`  • (+${briefing?.principlesOverflow} more — query the ledger)`);
  }
  const binding = (decisions?.decisions ?? []).filter((d) => d.status === "binding").sort(byImpact);
  const constraints = briefing?.constraints ?? [];
  if (binding.length || constraints.length) {
    // Constraints ARE binding decisions (origin=document) — interleave them into this section,
    // impact-desc across both; on ties, product constraints lead.
    type Row = { impact: number; isConstraint: boolean; line: string };
    const rows: Row[] = [
      ...binding.map((d) => ({
        impact: d.impact ?? 0,
        isConstraint: false,
        line: `  • ${tag(d.impact)}[${d.scopeRef}] ${d.ruleText}`,
      })),
      ...constraints.map((c) => ({ impact: c.impact, isConstraint: true, line: `  • ${c.line}` })),
    ].sort((a, b) => b.impact - a.impact || Number(b.isConstraint) - Number(a.isConstraint));

    lines.push(`📌 ${rows.length} binding decision(s) in effect:`);
    for (const r of rows.slice(0, 8)) lines.push(r.line);
    if ((briefing?.overflow ?? 0) > 0)
      lines.push(`  • (+${briefing?.overflow} product constraints in scope — get_product_context)`);
  }
  // Read-only staleness nudge — the hook never writes the pack itself (hook doctrine).
  if (packState === "missing")
    lines.push("📦 No decision pack installed — run `lockstep pack` (or call refresh_decision_pack).");
  else if (packState === "stale")
    lines.push("📦 Decision pack is stale (the ledger changed) — refresh with refresh_decision_pack or `lockstep pack`.");
  return lines.length ? `Lockstep:\n${lines.join("\n")}` : "Lockstep: nothing new.";
}

interface PeekResp {
  unread?: number;
  questions?: number;
  tasks?: number;
  changes?: number;
  decisions?: number;
}

/** Format a short badge from inbox peek counts. Returns null if nothing new. */
function formatPeek(peek: PeekResp | null): string | null {
  if (!peek || !peek.unread) return null;
  const parts: string[] = [];
  if (peek.questions) parts.push(`${peek.questions} question${peek.questions > 1 ? "s" : ""}`);
  if (peek.tasks) parts.push(`${peek.tasks} task${peek.tasks > 1 ? "s" : ""}`);
  if (peek.decisions) parts.push(`${peek.decisions} decision${peek.decisions > 1 ? "s" : ""} to review`);
  if (peek.changes) parts.push(`${peek.changes} change${peek.changes > 1 ? "s" : ""}`);
  if (parts.length === 0) return null;
  return `[Lockstep] ${peek.unread} new message${peek.unread > 1 ? "s" : ""} (${parts.join(", ")}). Check your inbox.`;
}

/**
 * Hook entrypoint. Resilient by design — never break the agent: on any error it exits 0.
 *  SessionStart → replay inbox + binding decisions as additionalContext.
 *  PostToolUse/Stop → diff → classify surface → risk-tiered publish via notify.
 */
export async function runCapture(event: string): Promise<void> {
  const vendor = process.env.LOCKSTEP_VENDOR ?? "unknown";
  const cwd = process.cwd();

  let session;
  try {
    session = await registerSession(vendor);
  } catch {
    process.exit(0); // not a connected repo / not logged in → silent no-op
  }

  const remote = gitRemote(cwd);
  const capabilityRef = remote ? readFeatureContext(remote) : null;

  try {
    if (event === "SessionStart") {
      await syncManifestDeps(cwd, session.sessionId); // keep the usage graph current from lockstep.yaml
      const inbox = await call<InboxResp>("GET", "/inbox", session.sessionId).catch(() => null);
      const decisions = await call<DecisionsResp>("GET", "/decisions", session.sessionId).catch(() => null);
      const briefing = await call<BriefingResp>("GET", "/briefing", session.sessionId).catch(() => null);
      let packState: PackState = null;
      if (briefing?.pack?.hash) {
        const { readLocalPackHash } = await import("../pack.js");
        const local = readLocalPackHash(cwd);
        packState = local === null ? "missing" : local === briefing.pack.hash ? null : "stale";
      }
      const replay = formatReplay(inbox, decisions, briefing, packState);
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: replay },
        }),
      );
      // Also write to stderr so it's visible in the terminal
      if ((inbox?.unread ?? 0) > 0) {
        process.stderr.write(`\n${replay}\n\n`);
      }
      return;
    }

    // PostToolUse / Stop — capture the change
    const files = changedFiles(cwd);
    if (files.length === 0) return;

    // Extract CANONICAL surface IDs (e.g. "http:POST /auth/session") — the shared vocabulary that
    // lets a consumer's declared dependency match a producer's change. File paths never matched.
    const surfaceIds = new Set<string>();
    let anyContractSurface = false;
    for (const f of files) {
      let content = "";
      try {
        content = readFileSync(join(cwd, f), "utf8");
      } catch {
        /* deleted/binary — skip content */
      }
      const ids = extractAllSurfaces(f, content);
      if (ids.length > 0) {
        anyContractSurface = true;
        ids.forEach((s) => surfaceIds.add(s));
      } else if (isContractSurface(f, content)) {
        anyContractSurface = true; // contract-ish file we couldn't parse into an exact surface
      }
    }

    // v1: contract surface ⇒ shared (the safety-critical bias). Ownership-based refinement later.
    const riskTier = riskTierFor({ anyContractSurface, allOwnedByMe: true });
    const summary = `${event}: changed ${files.length} file(s): ${files.slice(0, 5).join(", ")}${files.length > 5 ? "…" : ""}`;
    const baseHash = createHash("sha256").update(files.sort().join("|")).digest("hex").slice(0, 16);

    const ids = [...surfaceIds].slice(0, 10);
    if (ids.length === 0) {
      // No contract surface touched — record a single owned activity entry (routes to no one).
      await call("POST", "/changes", session.sessionId, {
        summary,
        riskTier,
        verified: true,
        verifiedAgainst: "git-diff",
        diffHash: baseHash,
        capabilityRef: capabilityRef ?? undefined,
      }).catch(() => {});
    } else {
      // One change per changed surface, so each routes to that surface's consumers.
      for (const surface of ids) {
        await call("POST", "/changes", session.sessionId, {
          summary,
          surface,
          riskTier,
          verified: true, // mechanical delta is derived from real local code (displayed as "extracted", not "verified")
          verifiedAgainst: "git-diff",
          diffHash: `${baseHash}:${surface}`,
          capabilityRef: capabilityRef ?? undefined,
        }).catch(() => {});
      }
    }
    process.stderr.write(`[lockstep] published change (${riskTier}, ${ids.length} surface(s))\n`);

    // NOTE: capture publishes a CHANGE event only. A change is NOT a decision — decisions are
    // durable rules/architectural choices, logged deliberately by the agent via propose_decision
    // (see the lockstep skill). Auto-minting a decision per save was a category error that flooded
    // the ledger; routing/impact for changes is handled by recordChange on the server.

    // Peek at inbox (without marking as read) — notify the agent if there are unread items
    const peek = await call<PeekResp>("GET", "/inbox/peek", session.sessionId).catch(() => null);
    const badge = formatPeek(peek);
    if (badge) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: badge },
        }),
      );
    }
  } catch {
    process.exit(0);
  }
}
