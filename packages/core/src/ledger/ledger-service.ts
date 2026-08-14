import { and, desc, eq, ne, or } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import {
  decisions,
  decisionVersions,
  decisionApprovals,
  dependencyEdges,
  changeFeedEntries,
  contracts,
  questions,
  answers,
  tasks,
  members,
  repos,
  projects,
  ingestArtifacts,
  decisionProvenances,
  graphNodes,
  graphEdges,
} from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";
import { fanoutChangeTx, fanoutToProjectTx } from "../routing/routing-engine.js";
import {
  upsertNodeTx,
  upsertEdgeTx,
  upsertGovernsEdgeTx,
  confirmGovernsEdgesForSurfacesTx,
} from "../graph/graph-service.js";
import { canRatifyTx, projectVisibility, projectArchived } from "../auth/permissions.js";
import { prepareScopeSimilarity, embedTexts, EMBED_FUSE_MIN, EMBED_SUPERSEDE_MAX, type Embedder } from "./embeddings.js";
import {
  semanticDecisionScores,
  hybridRank,
  MIN_QUERY_SIM,
  SEMANTIC_TOP_K,
  type RetrievalEmbedders,
} from "./retrieval.js";
import { sourceDocuments, conflicts, writebacks } from "../db/schema.js";
import { notifyConflictTx } from "../routing/routing-engine.js";
import { inArray } from "drizzle-orm";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

const SURFACE_SCOPES = new Set(["surface", "contract", "shared"]);

/**
 * Which repo in this project *produces* a given surface — the closed-world lookup that powers
 * graph-resolved dependencies. A dependency edge whose producer is known links the two repos in the
 * graph; this is what lets `lockstep scan` match an outbound call to the sibling repo that serves it.
 * Matches on the canonical surface ID (exact string). Excludes the asking repo (a repo doesn't
 * "consume" its own surface). Returns null when no sibling produces it (i.e. an external dependency).
 */
async function producerRepoForSurfaceTx(
  tx: Tx,
  projectId: string,
  surface: string,
  excludeRepoId?: string,
): Promise<string | null> {
  const rps = await tx.select({ id: repos.id }).from(repos).where(eq(repos.projectId, projectId));
  const repoIds = rps.map((r) => r.id).filter((id) => id !== excludeRepoId);
  if (repoIds.length > 0) {
    const c = (
      await tx
        .select({ repoId: contracts.repoId })
        .from(contracts)
        .where(and(inArray(contracts.repoId, repoIds), eq(contracts.surface, surface)))
        .limit(1)
    )[0];
    if (c) return c.repoId;
  }
  // #4 cross-project resolution: fall back org-wide among SHARED, non-archived projects. Walled
  // projects are fully invisible here (the simplest wall-respecting rule); same-project always wins
  // (above). Deterministic pick: oldest contract row.
  const shared = (await tx.select().from(projects)).filter(
    (p) => p.id !== projectId && projectVisibility(p.settings) === "shared" && !projectArchived(p.settings),
  );
  if (shared.length === 0) return null;
  const otherRepos = await tx
    .select({ id: repos.id })
    .from(repos)
    .where(
      inArray(
        repos.projectId,
        shared.map((p) => p.id),
      ),
    );
  const otherIds = otherRepos.map((r) => r.id).filter((id) => id !== excludeRepoId);
  if (otherIds.length === 0) return null;
  const hit = (
    await tx
      .select({ repoId: contracts.repoId })
      .from(contracts)
      .where(and(inArray(contracts.repoId, otherIds), eq(contracts.surface, surface)))
      .orderBy(contracts.createdAt)
      .limit(1)
  )[0];
  return hit?.repoId ?? null;
}

/**
 * Distinct consumers of a surface in the usage graph = its blast radius. #4: counts ORG-WIDE —
 * same-project edges plus other projects' edges that resolved to this project's repos as producer.
 * The count is a scalar (no identity leak), so walled consumers are included: undercounting would
 * misrank a genuinely cross-cutting decision as own-area.
 */
async function consumerCountTx(tx: Tx, projectId: string, surface: string): Promise<number> {
  const rps = await tx.select({ id: repos.id }).from(repos).where(eq(repos.projectId, projectId));
  const repoIds = rps.map((r) => r.id);
  const edges = await tx
    .select()
    .from(dependencyEdges)
    .where(
      and(
        eq(dependencyEdges.producedSurface, surface),
        eq(dependencyEdges.active, true),
        repoIds.length > 0
          ? or(eq(dependencyEdges.projectId, projectId), inArray(dependencyEdges.producedRepoId, repoIds))
          : eq(dependencyEdges.projectId, projectId),
      ),
    );
  return new Set(edges.map((e) => e.consumerRepoId)).size;
}

/**
 * Impact = blast radius of a scoped decision/change, derived from the usage graph. Surface-scoped
 * items use their consumer count; a project-wide rule affects every other repo; other scopes default
 * low. This single number drives the binding model and session-start ranking (see the product thesis).
 */
async function impactForScopeTx(tx: Tx, projectId: string, scopeKind: string, scopeRef: string): Promise<number> {
  if (SURFACE_SCOPES.has(scopeKind)) return consumerCountTx(tx, projectId, scopeRef);
  if (scopeKind === "project") {
    const rs = await tx.select().from(repos).where(eq(repos.projectId, projectId));
    return Math.max(0, rs.length - 1);
  }
  // Non-code decision: blast radius = how many people/teams the org graph links to this topic.
  if (scopeKind === "topic") return topicImpactTx(tx, projectId, scopeRef);
  // v3 product constraint scoped to a feature: max consumer count across its confirmed governed
  // surfaces (max, not sum — one hot surface should rank the constraint high even if the feature
  // also touches dead endpoints).
  if (scopeKind === "capability") return capabilityImpactTx(tx, projectId, scopeRef);
  return 0;
}

/** Governed surfaces of a capability node — CONFIRMED governs edges only (proposed edges never scope). */
export async function capabilitySurfacesTx(tx: Tx, projectId: string, capabilityRef: string): Promise<string[]> {
  const node = (
    await tx
      .select()
      .from(graphNodes)
      .where(
        and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "capability"), eq(graphNodes.ref, capabilityRef)),
      )
      .limit(1)
  )[0];
  if (!node) return [];
  const edges = await tx
    .select()
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        eq(graphEdges.fromId, node.id),
        eq(graphEdges.kind, "governs"),
        eq(graphEdges.status, "confirmed"),
      ),
    );
  if (edges.length === 0) return [];
  const surfaces = await tx
    .select()
    .from(graphNodes)
    .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "surface")));
  const toIds = new Set(edges.map((e) => e.toId));
  return surfaces.filter((s) => toIds.has(s.id)).map((s) => s.ref);
}

async function capabilityImpactTx(tx: Tx, projectId: string, capabilityRef: string): Promise<number> {
  const surfaces = await capabilitySurfacesTx(tx, projectId, capabilityRef);
  let max = 0;
  for (const s of surfaces) max = Math.max(max, await consumerCountTx(tx, projectId, s));
  return max;
}

/**
 * The reverse of capabilitySurfacesTx: capabilities that govern a surface, via CONFIRMED governs edges
 * only. surface node → governs edges where toId=surfaceNode → capability node refs. This is the
 * briefing scoping direction (a repo touches surfaces → which product capabilities govern them).
 */
export async function surfaceCapabilitiesTx(tx: Tx, projectId: string, surface: string): Promise<string[]> {
  const node = (
    await tx
      .select()
      .from(graphNodes)
      .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "surface"), eq(graphNodes.ref, surface)))
      .limit(1)
  )[0];
  if (!node) return [];
  const edges = await tx
    .select()
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        eq(graphEdges.toId, node.id),
        eq(graphEdges.kind, "governs"),
        eq(graphEdges.status, "confirmed"),
      ),
    );
  if (edges.length === 0) return [];
  const caps = await tx
    .select()
    .from(graphNodes)
    .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "capability")));
  const fromIds = new Set(edges.map((e) => e.fromId));
  return caps.filter((c) => fromIds.has(c.id)).map((c) => c.ref);
}

/** Recompute + persist impact for all capability-scoped decisions on a capability (after edges change). */
export async function recomputeCapabilityImpactTx(tx: Tx, projectId: string, capabilityRef: string): Promise<void> {
  const impact = await capabilityImpactTx(tx, projectId, capabilityRef);
  await tx
    .update(decisions)
    .set({ impact })
    .where(
      and(
        eq(decisions.projectId, projectId),
        eq(decisions.scopeKind, "capability"),
        eq(decisions.scopeRef, capabilityRef),
      ),
    );
}

/** Crude token estimate (chars/4) — no tokenizer dep in the repo; good enough for the briefing budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Org-graph impact for a topic node: distinct person/team neighbours (0 if the graph isn't derived yet). */
async function topicImpactTx(tx: Tx, projectId: string, topicRef: string): Promise<number> {
  const node = (
    await tx
      .select()
      .from(graphNodes)
      .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "topic"), eq(graphNodes.ref, topicRef)))
      .limit(1)
  )[0];
  if (!node) return 0;
  const edges = await tx.select().from(graphEdges).where(eq(graphEdges.projectId, projectId));
  const neighbourIds = new Set<string>();
  for (const e of edges) {
    if (e.fromId === node.id) neighbourIds.add(e.toId);
    else if (e.toId === node.id) neighbourIds.add(e.fromId);
  }
  if (neighbourIds.size === 0) return 0;
  const people = await tx
    .select()
    .from(graphNodes)
    .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "person")));
  return people.filter((p) => neighbourIds.has(p.id)).length;
}

export interface ProposeInput {
  projectId: string;
  memberId: string;
  scopeKind: string; // surface | repo | topic | project | shared | contract
  scopeRef: string;
  ruleText: string;
  baseVersion: number; // CAS: must equal the decision's current version (0 for new)
  decisionType?: string; // rule | architecture (default rule)
  provenance?: unknown;
  // v3: the feature the agent declared it was working on (set_feature_context). Persisted into the
  // version provenance so drift detection can SUPPRESS conflicts between a constraint and its own
  // intended implementation (F7). Optional — un-tagged work trips drift, the safe default.
  capabilityRef?: string;
  // Phase J deliberation fields (ADR context): the why, and what was considered and rejected.
  rationale?: string;
  alternatives?: string[];
  // Phase J review tripwire — when this decision should be revisited (never affects binding).
  reviewAt?: Date | null;
}

/**
 * Propose a decision with optimistic concurrency. New version only commits if
 * baseVersion matches the decision's current version, else 409 (caller re-bases).
 * Owner-scoped → binding immediately; shared/contract → open until acked.
 */
export async function proposeDecision(
  orgId: string,
  input: ProposeInput,
): Promise<{ decisionId: string; version: number; status: string; impact: number }> {
  return withOrg(orgId, async (tx: Tx) => {
    // Agent decisions and product constraints (origin=document) can share a surface — they are
    // SEPARATE decision streams. Never version a constraint from propose_decision; a co-location
    // between the two is a drift conflict, handled below, not a new version of the constraint.
    const existing = (
      await tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.projectId, input.projectId),
            eq(decisions.scopeKind, input.scopeKind),
            eq(decisions.scopeRef, input.scopeRef),
            ne(decisions.origin, "document"),
          ),
        )
        .limit(1)
    )[0];

    let decisionId: string;
    let currentVersion: number;

    if (!existing) {
      if (input.baseVersion !== 0) throw conflict(`stale base_version: expected 0, got ${input.baseVersion}`);
      const d = one(
        await tx
          .insert(decisions)
          .values({
            orgId,
            projectId: input.projectId,
            scopeKind: input.scopeKind,
            scopeRef: input.scopeRef,
            decisionType: input.decisionType ?? "rule",
            currentVersion: 0,
            status: "open",
          })
          .returning(),
      );
      decisionId = d.id;
      currentVersion = 0;
    } else {
      if (existing.currentVersion !== input.baseVersion) {
        throw conflict(`stale base_version: current is ${existing.currentVersion}, got ${input.baseVersion}`);
      }
      decisionId = existing.id;
      currentVersion = existing.currentVersion;
    }

    // Mixed binding model (impact-driven): a cross-cutting decision (impact > 0 — touches a surface
    // others consume, or a project-wide rule) stays `open` until an affected team acks it; an
    // own-area decision (impact 0) binds on assertion. Replaces the old scopeKind-name gate.
    const impact = await impactForScopeTx(tx, input.projectId, input.scopeKind, input.scopeRef);
    const needsAck = impact > 0;
    const version = currentVersion + 1;
    const status = needsAck ? "open" : "binding";
    // Carry the agent's declared feature tag on the version provenance (drift suppression, F7).
    const provenance = input.capabilityRef
      ? { ...((input.provenance as object | null) ?? {}), capabilityRef: input.capabilityRef }
      : (input.provenance ?? null);
    await tx.insert(decisionVersions).values({
      orgId,
      decisionId,
      version,
      baseVersion: input.baseVersion,
      ruleText: input.ruleText,
      provenance,
      rationale: input.rationale ?? null,
      alternatives: input.alternatives ?? null,
      status,
      proposedBy: input.memberId,
    });
    await tx
      .update(decisions)
      .set({
        currentVersion: version,
        status,
        impact,
        ...(input.reviewAt !== undefined ? { reviewAt: input.reviewAt } : {}),
      })
      .where(eq(decisions.id, decisionId));
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "decision.proposed",
      entityKind: "decision",
      entityId: decisionId,
      entityVersion: version,
      payload: { scopeKind: input.scopeKind, scopeRef: input.scopeRef, status, impact },
    });
    // Own-area decisions bind on assertion — check for drift against active product constraints.
    if (status === "binding") {
      await openDriftForEngDecisionTx(tx, orgId, {
        decisionId,
        projectId: input.projectId,
        scopeKind: input.scopeKind,
        scopeRef: input.scopeRef,
        ruleText: input.ruleText,
        authorMemberId: input.memberId,
        capabilityRef: input.capabilityRef ?? null,
      });
    }
    // Fan out decisions awaiting acknowledgement so affected members see them in their inbox.
    if (needsAck) {
      await fanoutToProjectTx(tx, orgId, {
        projectId: input.projectId,
        refId: decisionId,
        kind: "decision",
        senderMemberId: input.memberId,
        reason: { scopeRef: input.scopeRef, ruleText: input.ruleText, impact },
      });
    }
    return { decisionId, version, status, impact };
  });
}

/** Ack/review a shared decision; an approval promotes it to binding (v1: first ack binds). */
export async function ackDecision(
  orgId: string,
  decisionId: string,
  version: number,
  memberId: string,
  verdict = "ack",
): Promise<{ status: string }> {
  return withOrg(orgId, async (tx) => {
    const d = (await tx.select().from(decisions).where(eq(decisions.id, decisionId)).limit(1))[0];
    if (!d) throw Object.assign(new Error("decision not found"), { statusCode: 404 });
    await tx.insert(decisionApprovals).values({ orgId, decisionId, version, reviewerId: memberId, verdict });
    let status = d.status;
    if ((verdict === "ack" || verdict === "approve") && d.status === "open") {
      status = "binding";
      await tx.update(decisions).set({ status }).where(eq(decisions.id, decisionId));
    }
    await writeAudit(tx, {
      orgId,
      projectId: d.projectId,
      actorMemberId: memberId,
      action: "decision.acked",
      entityKind: "decision",
      entityId: decisionId,
      entityVersion: version,
      payload: { verdict, status },
    });
    // A cross-cutting decision that just bound on ack — check drift against active constraints.
    if (status === "binding" && d.origin !== "document") {
      const cur = (
        await tx
          .select()
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, decisionId), eq(decisionVersions.version, d.currentVersion)))
          .limit(1)
      )[0];
      await openDriftForEngDecisionTx(tx, orgId, {
        decisionId,
        projectId: d.projectId,
        scopeKind: d.scopeKind,
        scopeRef: d.scopeRef,
        ruleText: cur?.ruleText ?? "",
        authorMemberId: (cur?.proposedBy as string | null) ?? memberId,
        capabilityRef: (cur?.provenance as { capabilityRef?: string } | null)?.capabilityRef ?? null,
      });
      // Bound on ack — retire the decision this one was filed to supersede, if any.
      await applySupersessionTx(tx, orgId, {
        newDecisionId: decisionId,
        projectId: d.projectId,
        oldDecisionId: supersedesHint(cur?.provenance),
        actorMemberId: memberId,
      });
    }
    return { status };
  });
}

/* ───────────────────────────── v2: ingested (proposed) decisions ───────────────────────────── */

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "to",
  "of",
  "and",
  "or",
  "for",
  "with",
  "we",
  "our",
  "be",
  "on",
  "in",
]);

/** Cheap lexical similarity (Jaccard over content words) — the v1 dedup/fusion signal (no embeddings yet). */
export function similar(a: string, b: string): number {
  const toks = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    );
  const A = toks(a);
  const B = toks(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

async function addProvenanceTx(
  tx: Tx,
  orgId: string,
  decisionId: string,
  prov: {
    source?: string;
    url?: string | null;
    evidence?: unknown;
    externalId?: string | null;
    confidence?: number;
    anchor?: unknown; // v3 document constraints: exact origin location in the source doc
  },
): Promise<void> {
  const source = prov.source ?? "unknown";
  const externalId = prov.externalId ?? null;
  const existing = (
    await tx
      .select()
      .from(decisionProvenances)
      .where(
        and(
          eq(decisionProvenances.decisionId, decisionId),
          eq(decisionProvenances.source, source),
          externalId === null ? eq(decisionProvenances.externalId, "") : eq(decisionProvenances.externalId, externalId),
        ),
      )
      .limit(1)
  )[0];
  if (existing) return;
  await tx.insert(decisionProvenances).values({
    orgId,
    decisionId,
    source,
    externalId,
    url: prov.url ?? null,
    evidence: prov.evidence ?? null,
    confidence: prov.confidence ?? null,
    anchor: prov.anchor ?? null,
  });
}

/** All provenance rows for a project's decisions, grouped by decision id (for the review queue UI). */
export async function listProvenancesForProject(
  orgId: string,
  projectId: string,
): Promise<
  Record<
    string,
    Array<{
      source: string;
      externalId: string | null;
      url: string | null;
      evidence: unknown;
      confidence: number | null;
    }>
  >
> {
  return withOrg(orgId, async (tx) => {
    const ds = await tx.select({ id: decisions.id }).from(decisions).where(eq(decisions.projectId, projectId));
    const ids = new Set(ds.map((d) => d.id));
    const rows = await tx.select().from(decisionProvenances).where(eq(decisionProvenances.orgId, orgId));
    const out: Record<
      string,
      Array<{
        source: string;
        externalId: string | null;
        url: string | null;
        evidence: unknown;
        confidence: number | null;
      }>
    > = {};
    for (const r of rows) {
      if (!ids.has(r.decisionId)) continue;
      (out[r.decisionId] ??= []).push({
        source: r.source,
        externalId: r.externalId,
        url: r.url,
        evidence: r.evidence,
        confidence: r.confidence,
      });
    }
    return out;
  });
}

/**
 * Phase J: flip-on-bind supersession. When a decision binds and carries a `supersedes` provenance
 * hint (written by fileProposedDecision's scope scan), retire the hinted prior decision: status →
 * superseded plus the supersededById link. The status predicate is the CAS — a re-run, a race, or
 * an already-retired target flips nothing. Never crosses projects; forward-only (no unwind: the
 * flip only ever happens at bind, so rejecting a proposal leaves its target untouched).
 */
async function applySupersessionTx(
  tx: Tx,
  orgId: string,
  args: {
    newDecisionId: string;
    projectId: string;
    oldDecisionId: string | null | undefined;
    actorMemberId?: string | null;
  },
): Promise<void> {
  const oldId = args.oldDecisionId;
  if (!oldId || oldId === args.newDecisionId) return;
  const flipped = await tx
    .update(decisions)
    .set({ status: "superseded", supersededById: args.newDecisionId })
    .where(and(eq(decisions.id, oldId), eq(decisions.projectId, args.projectId), eq(decisions.status, "binding")))
    .returning({ currentVersion: decisions.currentVersion });
  const hit = flipped[0];
  if (!hit) return;
  await writeAudit(tx, {
    orgId,
    projectId: args.projectId,
    actorMemberId: args.actorMemberId ?? undefined,
    action: "decision.superseded",
    entityKind: "decision",
    entityId: oldId,
    entityVersion: hit.currentVersion,
    payload: { supersededById: args.newDecisionId },
  });
}

/** Provenance hint accessor for the flip: the prior-decision id fileProposedDecision stashed. */
function supersedesHint(provenance: unknown): string | null {
  return (provenance as { supersedes?: string } | null)?.supersedes ?? null;
}

export interface FileProposedInput {
  projectId: string;
  scopeKind: string; // surface | repo | topic | project | shared | contract | capability (v3)
  scopeRef: string;
  ruleText: string;
  decisionType?: string; // rule | architecture
  provenance: unknown; // {source, connectionId, externalId, url, evidence[], extractorModel, confidence, decidedBy, decidedAt}
  // idempotency + tuning audit keys (from the ingest funnel)
  connectionId: string;
  externalId: string;
  contentHash: string;
  confidence?: number; // 0..100
  // v3 document constraints (origin=document). The v2 conversation path leaves all of these unset.
  origin?: string; // ingested (default) | document
  constraintKind?: string; // behavioral | launch_gate | scope_exclusion
  expiresAt?: Date | null;
  anchor?: unknown; // stored on the provenance row — exact origin location in the source doc
  // Phase J deliberation fields (first-class; the funnel also keeps them in the provenance blob).
  rationale?: string;
  alternatives?: string[];
  reviewAt?: Date | null; // review tripwire parsed from "revisit …" phrasing
}

/**
 * File a decision distilled from a human tool (Slack/Jira/Notion) as a **proposed** draft. It is
 * `origin:"ingested"`, `status:"proposed"`, non-binding, and does NOT fan out — a human confirms it in
 * the review queue before it can bind. Idempotent on (connectionId, externalId, contentHash): a
 * re-seen unit returns the existing decision instead of minting a duplicate.
 */
export async function fileProposedDecision(
  orgId: string,
  input: FileProposedInput,
  embedder: Embedder = embedTexts,
): Promise<{ decisionId: string; deduped: boolean; fused: boolean; supersedes?: string }> {
  const prov = (input.provenance ?? {}) as { source?: string; url?: string | null; evidence?: unknown };
  const origin = input.origin ?? "ingested";
  // #6 pre-pass — embeddings are fetched OUTSIDE the main tx (HTTP under a transaction is a hazard).
  // Null ⇒ the scope scan below runs pure Jaccard, exactly the pre-#6 behavior.
  const embedScores = await prepareScopeSimilarity(
    orgId,
    {
      projectId: input.projectId,
      scopeRef: input.scopeRef,
      ruleText: input.ruleText,
      dedupe: { connectionId: input.connectionId, externalId: input.externalId, contentHash: input.contentHash },
    },
    embedder,
  );
  const provRow = {
    source: prov.source,
    url: prov.url ?? null,
    evidence: prov.evidence,
    externalId: input.externalId,
    confidence: input.confidence,
    anchor: input.anchor ?? null,
  };
  return withOrg(orgId, async (tx) => {
    // Idempotency: a re-seen unit (same content) is never re-processed.
    const seen = (
      await tx
        .select()
        .from(ingestArtifacts)
        .where(
          and(
            eq(ingestArtifacts.connectionId, input.connectionId),
            eq(ingestArtifacts.externalId, input.externalId),
            eq(ingestArtifacts.contentHash, input.contentHash),
          ),
        )
        .limit(1)
    )[0];
    if (seen) return { decisionId: seen.decisionId ?? "", deduped: true, fused: false };

    // Fusion + supersession: scan live decisions in the same scope. Document constraints only ever
    // fuse into other document constraints — fusing a PRD constraint into a binding engineering
    // decision would swallow it before ratification (and the co-location conflict, not a supersedes
    // hint, is the honest signal for that collision).
    const scopeMates = await tx
      .select()
      .from(decisions)
      .where(and(eq(decisions.projectId, input.projectId), eq(decisions.scopeRef, input.scopeRef)));
    let fuseInto: string | null = null;
    let supersedes: string | undefined;
    // #6: per-mate similarity — embedding cosine when the pre-pass scored this mate, Jaccard
    // otherwise (no key, outage, or a mate created after the pre-pass — race-safe). The method +
    // score are recorded in the audits so threshold tuning is data-driven.
    let similarity: { method: "embedding" | "jaccard"; score: number } | undefined;
    for (const m of scopeMates) {
      if (m.status === "rejected" || m.status === "superseded") continue;
      if (origin === "document" && m.origin !== "document") continue;
      const v = (
        await tx
          .select()
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, m.id), eq(decisionVersions.version, m.currentVersion)))
          .limit(1)
      )[0];
      const emb = embedScores?.get(m.id);
      const method: "embedding" | "jaccard" = emb !== undefined ? "embedding" : "jaccard";
      const score = emb !== undefined ? emb : similar(input.ruleText, v?.ruleText ?? "");
      if (score >= (method === "embedding" ? EMBED_FUSE_MIN : 0.6)) {
        fuseInto = m.id;
        similarity = { method, score };
        break;
      }
      if (origin !== "document" && m.status === "binding" && score < (method === "embedding" ? EMBED_SUPERSEDE_MAX : 0.4)) {
        supersedes = m.id; // different rule, same scope → likely supersession
        similarity = { method, score };
      }
    }

    if (fuseInto) {
      // One decision, many provenances — attach this source instead of minting a duplicate.
      await addProvenanceTx(tx, orgId, fuseInto, provRow);
      await tx.insert(ingestArtifacts).values({
        orgId,
        connectionId: input.connectionId,
        externalId: input.externalId,
        contentHash: input.contentHash,
        status: "fused",
        confidence: input.confidence ?? null,
        decisionId: fuseInto,
      });
      await writeAudit(tx, {
        orgId,
        projectId: input.projectId,
        action: "decision.provenance_added",
        entityKind: "decision",
        entityId: fuseInto,
        payload: { source: prov.source, externalId: input.externalId, similarity },
      });
      return { decisionId: fuseInto, deduped: false, fused: true };
    }

    // Auto-bind (#8, opt-in / default OFF): a project can opt into binding low-impact, high-confidence
    // ingested rules without a human click — impact must be 0 (own-area, no blast radius), confidence at
    // or above the configured floor, and NEVER for document constraints (those bind only via ratify).
    // `settings.autoBind = { enabled, floor }`; floor accepts 0–1 or 0–100 (confidence is 0–100).
    const proj = (
      await tx.select({ settings: projects.settings }).from(projects).where(eq(projects.id, input.projectId)).limit(1)
    )[0];
    const ab = (proj?.settings as { autoBind?: { enabled?: boolean; floor?: number } } | null)?.autoBind;
    const floor = ab?.floor == null ? 90 : ab.floor <= 1 ? ab.floor * 100 : ab.floor;
    const impact = await impactForScopeTx(tx, input.projectId, input.scopeKind, input.scopeRef);
    const autoBound = origin !== "document" && Boolean(ab?.enabled) && impact === 0 && (input.confidence ?? 0) >= floor;
    const status = autoBound ? "binding" : "proposed";

    const d = one(
      await tx
        .insert(decisions)
        .values({
          orgId,
          projectId: input.projectId,
          scopeKind: input.scopeKind,
          scopeRef: input.scopeRef,
          decisionType: input.decisionType ?? "rule",
          currentVersion: 1,
          status,
          impact,
          origin,
          constraintKind: input.constraintKind ?? null,
          expiresAt: input.expiresAt ?? null,
          reviewAt: input.reviewAt ?? null,
        })
        .returning(),
    );
    await tx.insert(decisionVersions).values({
      orgId,
      decisionId: d.id,
      version: 1,
      baseVersion: 0,
      ruleText: input.ruleText,
      provenance: supersedes ? { ...(input.provenance as object), supersedes, similarity } : (input.provenance ?? null),
      rationale: input.rationale ?? null,
      alternatives: input.alternatives ?? null,
      status,
    });
    await addProvenanceTx(tx, orgId, d.id, provRow);
    await tx.insert(ingestArtifacts).values({
      orgId,
      connectionId: input.connectionId,
      externalId: input.externalId,
      contentHash: input.contentHash,
      status: autoBound ? "auto_bound" : "proposed",
      confidence: input.confidence ?? null,
      decisionId: d.id,
    });
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      action: autoBound ? "decision.auto_bound" : "decision.proposed",
      entityKind: "decision",
      entityId: d.id,
      entityVersion: 1,
      payload: { scopeKind: input.scopeKind, scopeRef: input.scopeRef, origin, status, supersedes, similarity: supersedes ? similarity : undefined },
    });
    // NOTE: auto-bound rules are impact-0/own-area; drift-vs-PRD is checked on the deliberate
    // confirm/ack path (confirmDecision), not here (no single human author for the conflict notify).
    // Auto-bound is still a bind — retire the decision this one supersedes (no human actor).
    if (autoBound) {
      await applySupersessionTx(tx, orgId, {
        newDecisionId: d.id,
        projectId: input.projectId,
        oldDecisionId: supersedes,
      });
    }
    return { decisionId: d.id, deduped: false, fused: false, supersedes };
  });
}

export interface ReproposeInput {
  projectId: string;
  existingDecisionId: string;
  ruleText: string;
  provenance: unknown;
  constraintKind?: string;
  expiresAt?: Date | null;
  anchor?: unknown;
  connectionId: string;
  externalId: string;
  contentHash: string;
  confidence?: number;
  rationale?: string; // Phase J: fresh rationale from re-extraction (falls back to the prior version's)
}

/**
 * Re-file an EDITED document constraint against its EXISTING decision (matched by anchor key), instead
 * of minting a duplicate: when the PRD section text changed but the extracted rule is the same, just
 * record the artifact (so future sweeps skip it); when the rule changed, append a CAS version and set
 * the decision back to `proposed` — it re-enters ratification, and ratifying it supersedes the prior
 * (binding) version and auto-resolves any open drift as `resolved_prd_amended` (F10 concede path).
 */
export async function reproposeDocConstraint(
  orgId: string,
  input: ReproposeInput,
): Promise<{ decisionId: string; reversioned: boolean; deduped: boolean }> {
  return withOrg(orgId, async (tx) => {
    const seen = (
      await tx
        .select()
        .from(ingestArtifacts)
        .where(
          and(
            eq(ingestArtifacts.connectionId, input.connectionId),
            eq(ingestArtifacts.externalId, input.externalId),
            eq(ingestArtifacts.contentHash, input.contentHash),
          ),
        )
        .limit(1)
    )[0];
    if (seen) return { decisionId: input.existingDecisionId, reversioned: false, deduped: true };

    const d = (await tx.select().from(decisions).where(eq(decisions.id, input.existingDecisionId)).limit(1))[0];
    if (!d) throw Object.assign(new Error("decision not found"), { statusCode: 404 });
    const cur = (
      await tx
        .select()
        .from(decisionVersions)
        .where(and(eq(decisionVersions.decisionId, d.id), eq(decisionVersions.version, d.currentVersion)))
        .limit(1)
    )[0];

    const unchanged = (cur?.ruleText ?? "").trim() === input.ruleText.trim();
    const recordArtifact = (status: string) =>
      tx
        .insert(ingestArtifacts)
        .values({
          orgId,
          connectionId: input.connectionId,
          externalId: input.externalId,
          contentHash: input.contentHash,
          status,
          confidence: input.confidence ?? null,
          decisionId: d.id,
        });

    if (unchanged) {
      // Section text drifted but the rule is identical — mark seen, don't churn a version.
      await recordArtifact("deduped");
      return { decisionId: d.id, reversioned: false, deduped: true };
    }

    const version = d.currentVersion + 1;
    await tx.insert(decisionVersions).values({
      orgId,
      decisionId: d.id,
      version,
      baseVersion: d.currentVersion,
      ruleText: input.ruleText,
      provenance: input.provenance ?? cur?.provenance ?? null,
      rationale: input.rationale ?? cur?.rationale ?? null,
      alternatives: cur?.alternatives ?? null,
      status: "proposed",
    });
    await tx
      .update(decisions)
      .set({
        status: "proposed",
        currentVersion: version,
        constraintKind: input.constraintKind ?? d.constraintKind,
        expiresAt: input.expiresAt ?? d.expiresAt,
      })
      .where(eq(decisions.id, d.id));
    await recordArtifact("proposed");
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      action: "decision.proposed",
      entityKind: "decision",
      entityId: d.id,
      entityVersion: version,
      payload: {
        scopeKind: d.scopeKind,
        scopeRef: d.scopeRef,
        origin: "document",
        status: "proposed",
        reversioned: true,
      },
    });
    return { decisionId: d.id, reversioned: true, deduped: false };
  });
}

/**
 * Confirm a proposed (ingested) decision: run the same impact/binding path as an agent-authored
 * decision (own-area binds on assertion; cross-cutting stays `open` until acked and fans out). Optional
 * `edits` overwrite the current version's rule text / scope before confirming.
 */
export async function confirmDecision(
  orgId: string,
  decisionId: string,
  memberId: string,
  edits?: {
    ruleText?: string;
    scopeKind?: string;
    scopeRef?: string;
    rationale?: string;
    alternatives?: string[];
    reviewAt?: Date | null;
  },
): Promise<{ status: string; impact: number }> {
  return withOrg(orgId, async (tx) => {
    const d = (await tx.select().from(decisions).where(eq(decisions.id, decisionId)).limit(1))[0];
    if (!d) throw Object.assign(new Error("decision not found"), { statusCode: 404 });
    if (d.status !== "proposed") throw conflict(`decision is ${d.status}, not proposed`);

    // decision_versions is append-only, so edits are a new version, never an in-place UPDATE.
    const cur = (
      await tx
        .select()
        .from(decisionVersions)
        .where(and(eq(decisionVersions.decisionId, decisionId), eq(decisionVersions.version, d.currentVersion)))
        .limit(1)
    )[0];
    const scopeKind = edits?.scopeKind ?? d.scopeKind;
    const scopeRef = edits?.scopeRef ?? d.scopeRef;
    const ruleText = edits?.ruleText ?? cur?.ruleText ?? "";
    // Deliberation fields live on the version row (append-only) — editing them appends too.
    const edited = Boolean(
      edits?.ruleText || edits?.scopeKind || edits?.scopeRef || edits?.rationale || edits?.alternatives,
    );

    const impact = await impactForScopeTx(tx, d.projectId, scopeKind, scopeRef);
    const needsAck = impact > 0;
    const status = needsAck ? "open" : "binding";
    let version = d.currentVersion;
    if (edited) {
      version = d.currentVersion + 1;
      await tx.insert(decisionVersions).values({
        orgId,
        decisionId,
        version,
        baseVersion: d.currentVersion,
        ruleText,
        provenance: cur?.provenance ?? null,
        rationale: edits?.rationale ?? cur?.rationale ?? null,
        alternatives: edits?.alternatives ?? cur?.alternatives ?? null,
        status,
        proposedBy: memberId,
      });
    }
    await tx
      .update(decisions)
      .set({
        scopeKind,
        scopeRef,
        status,
        impact,
        currentVersion: version,
        ...(edits?.reviewAt !== undefined ? { reviewAt: edits.reviewAt } : {}),
      })
      .where(eq(decisions.id, decisionId));
    await writeAudit(tx, {
      orgId,
      projectId: d.projectId,
      actorMemberId: memberId,
      action: "decision.confirmed",
      entityKind: "decision",
      entityId: decisionId,
      entityVersion: version,
      payload: { scopeKind, scopeRef, status, impact, origin: d.origin },
    });
    if (needsAck) {
      await fanoutToProjectTx(tx, orgId, {
        projectId: d.projectId,
        refId: decisionId,
        kind: "decision",
        senderMemberId: memberId,
        reason: { scopeRef, ruleText, impact },
      });
    }
    // Own-area confirmation binds immediately — check drift (skip the constraint side).
    if (status === "binding" && d.origin !== "document") {
      await openDriftForEngDecisionTx(tx, orgId, {
        decisionId,
        projectId: d.projectId,
        scopeKind,
        scopeRef,
        ruleText,
        authorMemberId: memberId,
        capabilityRef: (cur?.provenance as { capabilityRef?: string } | null)?.capabilityRef ?? null,
      });
    }
    // Bound on confirm — retire the decision this one was filed to supersede. (A confirm that
    // lands `open` flips later, at ack.)
    if (status === "binding") {
      await applySupersessionTx(tx, orgId, {
        newDecisionId: decisionId,
        projectId: d.projectId,
        oldDecisionId: supersedesHint(cur?.provenance),
        actorMemberId: memberId,
      });
    }
    return { status, impact };
  });
}

/**
 * Ratify a proposed document constraint (v3). Deliberately NOT confirmDecision: a ratified product
 * constraint binds on the PM's word regardless of impact and never fans out to inboxes — impact is
 * recomputed for ranking only. Requires the source document to be `active` (extraction runs at
 * `review`, but nothing binds from a PRD that might die in review) and an authorized member
 * (owner/pm role, doc owner, or registrant). An edited ruleText appends a CAS version — the anchor
 * keeps pointing at the source; the edit is attributable in decision_versions.
 */
export async function ratifyDecision(
  orgId: string,
  decisionId: string,
  memberId: string,
  opts?: { ruleText?: string },
): Promise<{ status: string; version: number; impact: number }> {
  return withOrg(orgId, async (tx) => {
    const d = (await tx.select().from(decisions).where(eq(decisions.id, decisionId)).limit(1))[0];
    if (!d) throw Object.assign(new Error("decision not found"), { statusCode: 404 });
    if (d.origin !== "document") throw conflict(`only document constraints are ratified (origin is ${d.origin})`);
    if (d.status !== "proposed") throw conflict(`decision is ${d.status}, not proposed`);

    const cur = (
      await tx
        .select()
        .from(decisionVersions)
        .where(and(eq(decisionVersions.decisionId, decisionId), eq(decisionVersions.version, d.currentVersion)))
        .limit(1)
    )[0];
    const provJson = (cur?.provenance ?? {}) as { documentId?: string };
    const doc = provJson.documentId
      ? (await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, provJson.documentId)).limit(1))[0]
      : undefined;
    if (!doc) throw conflict("constraint has no source document");
    if (doc.state !== "active")
      throw Object.assign(new Error("document_not_active"), { statusCode: 409, code: "document_not_active" });
    if (!(await canRatifyTx(tx, { projectId: d.projectId, memberId, doc })))
      throw Object.assign(new Error("ratify requires owner/pm role or document ownership"), { statusCode: 403 });

    // decision_versions is append-only — an edited rule is a new version, never an in-place UPDATE.
    let version = d.currentVersion;
    const editedText = opts?.ruleText?.trim();
    if (editedText && editedText !== cur?.ruleText) {
      version = d.currentVersion + 1;
      await tx.insert(decisionVersions).values({
        orgId,
        decisionId,
        version,
        baseVersion: d.currentVersion,
        ruleText: editedText,
        provenance: cur?.provenance ?? null,
        rationale: cur?.rationale ?? null,
        alternatives: cur?.alternatives ?? null,
        status: "binding",
        proposedBy: memberId,
      });
    }
    const impact = await impactForScopeTx(tx, d.projectId, d.scopeKind, d.scopeRef);
    await tx.insert(decisionApprovals).values({ orgId, decisionId, version, reviewerId: memberId, verdict: "ratify" });
    await tx
      .update(decisions)
      .set({ status: "binding", impact, currentVersion: version })
      .where(eq(decisions.id, decisionId));
    // Every bind path flips supersession. Guaranteed no-op today — the hint is never written for
    // document constraints — but keeps the invariant honest if that ever changes.
    await applySupersessionTx(tx, orgId, {
      newDecisionId: decisionId,
      projectId: d.projectId,
      oldDecisionId: supersedesHint(cur?.provenance),
      actorMemberId: memberId,
    });

    // First ratification of a capability-scoped constraint mints the capability node and links the
    // source doc to it, giving the org graph its product layer.
    if (d.scopeKind === "capability") {
      const label = d.scopeRef.replace(/^feature:|^metric:/, "").replace(/-/g, " ");
      const capId = await upsertNodeTx(tx, orgId, d.projectId, "capability", d.scopeRef, doc.title ?? label);
      const docNodeId = await upsertNodeTx(
        tx,
        orgId,
        d.projectId,
        "doc",
        `${doc.tool}:${doc.externalId}`,
        doc.title ?? doc.externalId,
      );
      await upsertEdgeTx(tx, orgId, d.projectId, docNodeId, capId, "owns");
      // Seed PROPOSED governs edges from the extraction's canonicalized surface candidates (F5), so the
      // Features page shows suggestions before any code is written. They only affect briefing scope
      // once a tech lead or a checked PR confirms them.
      const candidates = ((cur?.provenance as { surfaceCandidates?: string[] })?.surfaceCandidates ?? []).filter(
        Boolean,
      );
      for (const surface of candidates) {
        await upsertGovernsEdgeTx(tx, orgId, d.projectId, d.scopeRef, surface, "proposed", "extraction");
      }
    }

    // Concede path (F8): re-ratifying an amended constraint reconciles any open drift on it. On a
    // FIRST ratification there is no open drift (drift needs the constraint already binding), so this
    // is a no-op then; after a PRD amendment it auto-resolves the drift the amendment addressed.
    const openDrift = await tx
      .select()
      .from(conflicts)
      .where(
        and(eq(conflicts.constraintDecisionId, decisionId), eq(conflicts.kind, "drift"), eq(conflicts.status, "open")),
      );
    for (const k of openDrift) {
      await tx
        .update(conflicts)
        .set({ status: "resolved_prd_amended", resolvedAt: new Date(), resolvedBy: memberId })
        .where(eq(conflicts.id, k.id));
      await writeAudit(tx, {
        orgId,
        projectId: d.projectId,
        actorMemberId: memberId,
        action: "conflict.resolved",
        entityKind: "conflict",
        entityId: k.id,
        payload: { resolution: "resolved_prd_amended", auto: true },
      });
    }

    await writeAudit(tx, {
      orgId,
      projectId: d.projectId,
      actorMemberId: memberId,
      action: "constraint.ratified",
      entityKind: "decision",
      entityId: decisionId,
      entityVersion: version,
      payload: {
        scopeKind: d.scopeKind,
        scopeRef: d.scopeRef,
        documentId: doc.id,
        edited: version !== d.currentVersion,
      },
    });
    return { status: "binding", version, impact };
  });
}

/** Reject a proposed (ingested or document) decision — a human declined it. It never binds. */
export async function rejectDecision(orgId: string, decisionId: string, memberId: string): Promise<{ status: string }> {
  return withOrg(orgId, async (tx) => {
    const d = (await tx.select().from(decisions).where(eq(decisions.id, decisionId)).limit(1))[0];
    if (!d) throw Object.assign(new Error("decision not found"), { statusCode: 404 });
    // decision_versions is append-only; the live status lives on decisions.status.
    await tx.update(decisions).set({ status: "rejected" }).where(eq(decisions.id, decisionId));
    await writeAudit(tx, {
      orgId,
      projectId: d.projectId,
      actorMemberId: memberId,
      action: d.origin === "document" ? "constraint.rejected" : "decision.rejected",
      entityKind: "decision",
      entityId: decisionId,
      entityVersion: d.currentVersion,
    });
    return { status: "rejected" };
  });
}

/**
 * Phase J review tripwire mutation: set, snooze, or clear a binding decision's reviewAt. "Due for
 * review" itself is computed at query time (reviewAt < now) — this is the only state change, and it
 * is human-attributed (the audit trail a status-flipping job could never give).
 */
export async function setDecisionReview(
  orgId: string,
  decisionId: string,
  memberId: string,
  reviewAt: Date | null,
): Promise<{ reviewAt: Date | null }> {
  return withOrg(orgId, async (tx) => {
    const d = (await tx.select().from(decisions).where(eq(decisions.id, decisionId)).limit(1))[0];
    if (!d) throw Object.assign(new Error("decision not found"), { statusCode: 404 });
    if (d.status !== "binding") throw conflict(`decision is ${d.status}, not binding`);
    await tx.update(decisions).set({ reviewAt }).where(eq(decisions.id, decisionId));
    await writeAudit(tx, {
      orgId,
      projectId: d.projectId,
      actorMemberId: memberId,
      action: "decision.review_updated",
      entityKind: "decision",
      entityId: decisionId,
      entityVersion: d.currentVersion,
      payload: { reviewAt: reviewAt?.toISOString() ?? null },
    });
    return { reviewAt };
  });
}

export async function listDecisions(
  orgId: string,
  projectId: string,
  scopeRef?: string,
  opts?: { status?: string; origin?: string },
): Promise<
  Array<{
    id: string;
    scopeKind: string;
    scopeRef: string;
    status: string;
    origin: string;
    version: number;
    ruleText: string;
    provenance: unknown;
    decisionType: string;
    impact: number;
    createdAt: Date;
    rationale: string | null;
    alternatives: string[] | null;
    reviewAt: Date | null;
    dueForReview: boolean;
    supersededById: string | null;
    supersedes: string[];
    proposedAt: Date;
  }>
> {
  return withOrg(orgId, async (tx) => {
    const ds = await tx.select().from(decisions).where(eq(decisions.projectId, projectId));
    // Lineage reverse map: "X supersedes Y" is Y.supersededById === X — built from the same rows.
    const supersedesBy = new Map<string, string[]>();
    for (const d of ds) {
      if (!d.supersededById) continue;
      supersedesBy.set(d.supersededById, [...(supersedesBy.get(d.supersededById) ?? []), d.id]);
    }
    const now = new Date();
    const out = [];
    for (const d of ds) {
      if (scopeRef && d.scopeRef !== scopeRef) continue;
      if (opts?.status && d.status !== opts.status) continue;
      if (opts?.origin && d.origin !== opts.origin) continue;
      const v = (
        await tx
          .select()
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, d.id), eq(decisionVersions.version, d.currentVersion)))
          .limit(1)
      )[0];
      out.push({
        id: d.id,
        scopeKind: d.scopeKind,
        scopeRef: d.scopeRef,
        status: d.status,
        origin: d.origin,
        version: d.currentVersion,
        ruleText: v?.ruleText ?? "",
        provenance: v?.provenance ?? null,
        decisionType: d.decisionType,
        impact: d.impact,
        createdAt: d.createdAt,
        rationale: v?.rationale ?? null,
        alternatives: (v?.alternatives as string[] | null) ?? null,
        reviewAt: d.reviewAt,
        // Query-time tripwire: due decisions stay binding — they just surface for a human look.
        dueForReview: d.status === "binding" && d.reviewAt != null && d.reviewAt < now,
        supersededById: d.supersededById,
        supersedes: supersedesBy.get(d.id) ?? [],
        // Staleness anchor: the CURRENT version's timestamp — a re-proposed doc constraint re-enters
        // the queue with a fresh clock, not the decision's original createdAt.
        proposedAt: v?.createdAt ?? d.createdAt,
      });
    }
    return out;
  });
}

export async function registerDependency(
  orgId: string,
  input: {
    projectId: string;
    memberId: string;
    consumerRepoId: string;
    producedSurface: string;
    producedRepoId?: string | null;
    source?: string;
  },
): Promise<{ edgeId: string }> {
  return withOrg(orgId, async (tx) => {
    // Idempotent: the manifest is re-synced every session, so an identical (consumer, surface) edge
    // must not duplicate. Return the existing active edge if present.
    const existing = (
      await tx
        .select()
        .from(dependencyEdges)
        .where(
          and(
            eq(dependencyEdges.consumerRepoId, input.consumerRepoId),
            eq(dependencyEdges.producedSurface, input.producedSurface),
            eq(dependencyEdges.active, true),
          ),
        )
        .limit(1)
    )[0];

    // Resolve the producer from the project's produced-surface catalog (contracts) when the caller
    // didn't supply one — this is what turns a bare "I consume X" into a graph edge that links to the
    // sibling repo serving X. Self-healing: an edge created before the producer onboarded gets its
    // producer backfilled on the next re-sync.
    const producedRepoId =
      input.producedRepoId ??
      (await producerRepoForSurfaceTx(tx, input.projectId, input.producedSurface, input.consumerRepoId));

    if (existing) {
      if (producedRepoId && !existing.producedRepoId) {
        await tx.update(dependencyEdges).set({ producedRepoId }).where(eq(dependencyEdges.id, existing.id));
      }
      return { edgeId: existing.id };
    }

    const edge = one(
      await tx
        .insert(dependencyEdges)
        .values({
          orgId,
          projectId: input.projectId,
          consumerRepoId: input.consumerRepoId,
          producedRepoId,
          producedSurface: input.producedSurface,
          source: input.source ?? "register_dependency",
          createdBy: input.memberId,
        })
        .returning(),
    );
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "dependency.registered",
      entityKind: "dependency_edge",
      entityId: edge.id,
      payload: { consumerRepoId: input.consumerRepoId, producedSurface: input.producedSurface },
    });
    return { edgeId: edge.id };
  });
}

/**
 * Who consumes a given surface? Backs the agent's "does anyone use this endpoint?" question so it can
 * answer instantly from the usage graph instead of pinging a human. Excludes the asking repo.
 */
export async function listConsumers(
  orgId: string,
  projectId: string,
  surface: string,
  askingRepoId?: string,
): Promise<{ surface: string; count: number; consumers: Array<{ repoId: string; gitRemote: string; projectName?: string }> }> {
  return withOrg(orgId, async (tx) => {
    // #4: count org-wide (same-project edges + other projects' edges resolved to this project's
    // producers); consumer DETAIL only for same-project and SHARED projects — a walled project's
    // consumers appear in the count (a scalar leaks nothing) but never by name.
    const own = await tx.select({ id: repos.id }).from(repos).where(eq(repos.projectId, projectId));
    const ownIds = own.map((r) => r.id);
    const edges = await tx
      .select()
      .from(dependencyEdges)
      .where(
        and(
          eq(dependencyEdges.producedSurface, surface),
          eq(dependencyEdges.active, true),
          ownIds.length > 0
            ? or(eq(dependencyEdges.projectId, projectId), inArray(dependencyEdges.producedRepoId, ownIds))
            : eq(dependencyEdges.projectId, projectId),
        ),
      );
    const repoIds = [...new Set(edges.map((e) => e.consumerRepoId))].filter((r) => r !== askingRepoId);
    const projs = await tx.select().from(projects);
    const projById = new Map(projs.map((p) => [p.id, p]));
    const consumers: Array<{ repoId: string; gitRemote: string; projectName?: string }> = [];
    for (const repoId of repoIds) {
      const r = (await tx.select().from(repos).where(eq(repos.id, repoId)).limit(1))[0];
      if (!r) continue;
      if (r.projectId !== projectId) {
        const p = projById.get(r.projectId);
        if (!p || projectVisibility(p.settings) !== "shared") continue; // walled: count-only
        consumers.push({ repoId, gitRemote: r.gitRemote, projectName: p.name });
      } else {
        consumers.push({ repoId, gitRemote: r.gitRemote });
      }
    }
    return { surface, count: repoIds.length, consumers };
  });
}

export interface ProjectSurface {
  surface: string;
  repoId: string;
  gitRemote: string;
  /** #4: set when the producer lives in ANOTHER (shared) project — surface/repo/name only, never rule text. */
  crossProject?: boolean;
  projectId?: string;
  projectName?: string;
}

/**
 * The project's produced-surface catalog: every canonical surface any repo in the project produces,
 * with the producing repo. This is the closed-world set `lockstep scan` matches a repo's outbound
 * calls against to resolve `consumes` — the graph-resolved onboarding path. Sourced from `contracts`
 * (the produced-surface registry, now kept complete by `syncProducedSurfaces`) plus any edges whose
 * producer is already known. Session-scoped to the caller's project, so walled-project boundaries hold.
 */
export async function listProjectSurfaces(orgId: string, projectId: string): Promise<ProjectSurface[]> {
  return withOrg(orgId, async (tx) => {
    const rps = await tx
      .select({ id: repos.id, gitRemote: repos.gitRemote })
      .from(repos)
      .where(eq(repos.projectId, projectId));
    const remoteById = new Map(rps.map((r) => [r.id, r.gitRemote]));
    const repoIds = rps.map((r) => r.id);
    const out = new Map<string, ProjectSurface>(); // key = surface + repoId (a surface can be produced by >1 repo)
    if (repoIds.length > 0) {
      for (const c of await tx.select().from(contracts).where(inArray(contracts.repoId, repoIds))) {
        out.set(`${c.surface} ${c.repoId}`, {
          surface: c.surface,
          repoId: c.repoId,
          gitRemote: remoteById.get(c.repoId) ?? "(unknown)",
        });
      }
    }
    const edges = await tx
      .select()
      .from(dependencyEdges)
      .where(and(eq(dependencyEdges.projectId, projectId), eq(dependencyEdges.active, true)));
    for (const e of edges) {
      if (e.producedRepoId && remoteById.has(e.producedRepoId)) {
        out.set(`${e.producedSurface} ${e.producedRepoId}`, {
          surface: e.producedSurface,
          repoId: e.producedRepoId,
          gitRemote: remoteById.get(e.producedRepoId)!,
        });
      }
    }
    // #4 cross-project section: SHARED, non-archived sibling projects' contracts join the catalog so
    // `lockstep scan` resolves cross-project consumes. Payload = surface + repo + project name only —
    // never decision/rule text. Walled projects contribute nothing.
    const shared = (await tx.select().from(projects)).filter(
      (p) => p.id !== projectId && projectVisibility(p.settings) === "shared" && !projectArchived(p.settings),
    );
    if (shared.length > 0) {
      const nameByProject = new Map(shared.map((p) => [p.id, p.name]));
      const otherRepos = await tx
        .select()
        .from(repos)
        .where(
          inArray(
            repos.projectId,
            shared.map((p) => p.id),
          ),
        );
      const otherById = new Map(otherRepos.map((r) => [r.id, r]));
      if (otherRepos.length > 0) {
        for (const c of await tx
          .select()
          .from(contracts)
          .where(
            inArray(
              contracts.repoId,
              otherRepos.map((r) => r.id),
            ),
          )) {
          const r = otherById.get(c.repoId)!;
          if (!out.has(`${c.surface} ${c.repoId}`)) {
            out.set(`${c.surface} ${c.repoId}`, {
              surface: c.surface,
              repoId: c.repoId,
              gitRemote: r.gitRemote,
              crossProject: true,
              projectId: r.projectId,
              projectName: nameByProject.get(r.projectId),
            });
          }
        }
      }
    }
    return [...out.values()];
  });
}

/**
 * Register a repo's produced surfaces into the catalog (idempotent). `lockstep scan --apply` calls
 * this so `produces:` is synced server-side — without it the catalog is incomplete (a `contracts`
 * row was only ever written when a change carried an interface *delta*). Extracted from source, not
 * runtime-verified: `verified:false` / `verifiedAgainst:"source-extracted"` (see IMPROVEMENTS #4).
 */
export async function syncProducedSurfaces(
  orgId: string,
  input: { projectId: string; repoId: string; memberId?: string; surfaces: string[] },
): Promise<{ added: number; total: number }> {
  return withOrg(orgId, async (tx) => {
    let added = 0;
    for (const surface of [...new Set(input.surfaces)]) {
      const existing = (
        await tx
          .select({ id: contracts.id })
          .from(contracts)
          .where(and(eq(contracts.repoId, input.repoId), eq(contracts.surface, surface)))
          .limit(1)
      )[0];
      if (existing) continue;
      await tx.insert(contracts).values({
        orgId,
        repoId: input.repoId,
        surface,
        delta: null,
        verified: false,
        verifiedAgainst: "source-extracted",
        verificationStatus: "asserted_unverified",
        createdBy: input.memberId ?? null,
      });
      added++;
    }
    const total = (await tx.select({ id: contracts.id }).from(contracts).where(eq(contracts.repoId, input.repoId)))
      .length;
    return { added, total };
  });
}

export interface NotifyInput {
  projectId: string;
  repoId: string;
  memberId: string;
  summary: string;
  surface?: string;
  contractDelta?: unknown;
  riskTier?: string; // owned | shared | contract
  verified?: boolean;
  verifiedAgainst?: string;
  diffHash?: string;
  capabilityRef?: string; // v3: active feature context — auto-links the changed surface to the capability
}

/** Record a change-feed entry (+ contract if a delta is supplied). Routing happens in P5. */
export async function recordChange(
  orgId: string,
  input: NotifyInput,
): Promise<{ changeId: string; publishState: string; delivered: number; impact: number }> {
  const riskTier = input.riskTier ?? "owned";
  const publishState = riskTier === "owned" ? "published" : "pending_confirm";
  return withOrg(orgId, async (tx) => {
    let contractId: string | null = null;
    if (input.contractDelta !== undefined && input.surface) {
      const c = one(
        await tx
          .insert(contracts)
          .values({
            orgId,
            repoId: input.repoId,
            surface: input.surface,
            delta: input.contractDelta ?? null,
            verified: input.verified ?? false,
            verifiedAgainst: input.verifiedAgainst ?? null,
            verificationStatus: input.verified ? "verified" : "asserted_unverified",
            createdBy: input.memberId,
          })
          .returning(),
      );
      contractId = c.id;
    }
    // Impact = blast radius: how many repos consume the changed surface (the precise fan-out target).
    const impact = input.surface ? await consumerCountTx(tx, input.projectId, input.surface) : 0;
    const change = one(
      await tx
        .insert(changeFeedEntries)
        .values({
          orgId,
          projectId: input.projectId,
          repoId: input.repoId,
          summary: input.summary,
          contractId,
          surface: input.surface ?? null,
          riskTier,
          impact,
          publishState,
          diffHash: input.diffHash ?? null,
          createdBy: input.memberId,
        })
        .returning(),
    );
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "change.published",
      entityKind: "change_feed_entry",
      entityId: change.id,
      payload: { surface: input.surface, riskTier, publishState },
    });

    // v3 auto-link (F7): a change on a surface while a feature context is set proposes a
    // capability→surface governs edge. It stays `proposed` until a checked PR (reconcile) or a tech
    // lead confirms it, so it never silently widens briefing scope.
    if (input.surface && input.capabilityRef) {
      await upsertGovernsEdgeTx(
        tx,
        orgId,
        input.projectId,
        input.capabilityRef,
        input.surface,
        "proposed",
        "auto-link",
      );
    }

    // Route to consumers of the changed surface (dependency-graph fan-out).
    let delivered = 0;
    if (input.surface) {
      delivered = await fanoutChangeTx(tx, orgId, {
        projectId: input.projectId,
        changeId: change.id,
        surface: input.surface,
        senderRepoId: input.repoId,
        senderMemberId: input.memberId,
      });
    }
    return { changeId: change.id, publishState, delivered, impact };
  });
}

/* ───────────────────────────── Questions ───────────────────────────── */

export async function askQuestion(
  orgId: string,
  input: { projectId: string; memberId: string; body: string; scopeRef?: string; urgent?: boolean },
): Promise<{ questionId: string; status: string }> {
  return withOrg(orgId, async (tx) => {
    const q = one(
      await tx
        .insert(questions)
        .values({
          orgId,
          projectId: input.projectId,
          scopeKind: input.scopeRef ? "surface" : "project",
          scopeRef: input.scopeRef ?? null,
          body: input.body,
          urgent: input.urgent ?? false,
          askedBy: input.memberId,
        })
        .returning(),
    );
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "question.asked",
      entityKind: "question",
      entityId: q.id,
    });
    await fanoutToProjectTx(tx, orgId, {
      projectId: input.projectId,
      refId: q.id,
      kind: "question",
      senderMemberId: input.memberId,
      reason: { body: input.body, scopeRef: input.scopeRef ?? null, urgent: input.urgent ?? false },
    });
    return { questionId: q.id, status: q.status };
  });
}

export async function answerQuestion(
  orgId: string,
  questionId: string,
  memberId: string,
  response: string,
): Promise<{ answerId: string; status: string }> {
  return withOrg(orgId, async (tx) => {
    const q = (await tx.select().from(questions).where(eq(questions.id, questionId)).limit(1))[0];
    if (!q) throw Object.assign(new Error("question not found"), { statusCode: 404 });
    const ans = one(
      await tx.insert(answers).values({ orgId, questionId, body: response, answeredBy: memberId }).returning(),
    );
    await tx.update(questions).set({ status: "answered" }).where(eq(questions.id, questionId));
    await writeAudit(tx, {
      orgId,
      projectId: q.projectId,
      actorMemberId: memberId,
      action: "question.answered",
      entityKind: "question",
      entityId: questionId,
    });
    return { answerId: ans.id, status: "answered" };
  });
}

/* ───────────────────────────── Tasks ───────────────────────────── */

export async function createTask(
  orgId: string,
  input: { projectId: string; memberId: string; title: string; to?: string; refs?: unknown },
): Promise<{ taskId: string; runState: string }> {
  return withOrg(orgId, async (tx) => {
    let delegatedTo: string | null = null;
    if (input.to) {
      const m = (
        await tx
          .select()
          .from(members)
          .where(and(eq(members.orgId, orgId), eq(members.githubLogin, input.to)))
          .limit(1)
      )[0];
      delegatedTo = m?.id ?? null;
    }
    const t = one(
      await tx
        .insert(tasks)
        .values({
          orgId,
          projectId: input.projectId,
          title: input.title,
          refs: input.refs ?? null,
          delegatedBy: input.memberId,
          delegatedTo,
          approver: delegatedTo,
          runState: "queued",
          status: "open",
        })
        .returning(),
    );
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "task.delegated",
      entityKind: "task",
      entityId: t.id,
    });
    await fanoutToProjectTx(tx, orgId, {
      projectId: input.projectId,
      refId: t.id,
      kind: "task",
      senderMemberId: input.memberId,
      targetMemberId: delegatedTo,
      reason: { title: input.title, to: input.to ?? null },
    });
    return { taskId: t.id, runState: t.runState };
  });
}

export async function completeTask(orgId: string, taskId: string, memberId: string): Promise<{ status: string }> {
  return withOrg(orgId, async (tx) => {
    const t = (await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0];
    if (!t) throw Object.assign(new Error("task not found"), { statusCode: 404 });
    await tx.update(tasks).set({ runState: "done", status: "closed" }).where(eq(tasks.id, taskId));
    await writeAudit(tx, {
      orgId,
      projectId: t.projectId,
      actorMemberId: memberId,
      action: "task.completed",
      entityKind: "task",
      entityId: taskId,
    });
    return { status: "done" };
  });
}

/* ───────────────────────────── v3: product-constraint scoping (briefing / pull) ───────────────────────────── */

export interface ScopedConstraint {
  id: string;
  scopeKind: string;
  scopeRef: string;
  ruleText: string;
  constraintKind: string | null;
  status: string;
  impact: number;
  expiresAt: Date | null;
  docId: string | null;
  docTitle: string | null;
  docUrl: string | null;
  docState: string | null;
  anchorUrl: string | null;
  conflictOpen: boolean;
}

/** Resolve a document-constraint decision to its briefing/pull shape (doc + anchor + open-conflict). */
async function constraintDetailTx(tx: Tx, d: typeof decisions.$inferSelect): Promise<ScopedConstraint | null> {
  const v = (
    await tx
      .select()
      .from(decisionVersions)
      .where(and(eq(decisionVersions.decisionId, d.id), eq(decisionVersions.version, d.currentVersion)))
      .limit(1)
  )[0];
  const prov = (v?.provenance ?? {}) as { documentId?: string; url?: string };
  const doc = prov.documentId
    ? (await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, prov.documentId)).limit(1))[0]
    : undefined;
  const open = (
    await tx
      .select({ id: conflicts.id })
      .from(conflicts)
      .where(and(eq(conflicts.constraintDecisionId, d.id), eq(conflicts.status, "open")))
      .limit(1)
  )[0];
  return {
    id: d.id,
    scopeKind: d.scopeKind,
    scopeRef: d.scopeRef,
    ruleText: v?.ruleText ?? "",
    constraintKind: d.constraintKind,
    status: d.status,
    impact: d.impact,
    expiresAt: d.expiresAt,
    docId: doc?.id ?? null,
    docTitle: doc?.title ?? null,
    docUrl: doc?.url ?? null,
    docState: doc?.state ?? null,
    anchorUrl: prov.url ?? doc?.url ?? null,
    conflictOpen: Boolean(open),
  };
}

/** The surfaces a repo touches, server-side knowable: its consumed + produced dependency edges + contracts. */
async function repoSurfacesTx(tx: Tx, projectId: string, repoId: string): Promise<string[]> {
  const deps = await tx
    .select()
    .from(dependencyEdges)
    .where(and(eq(dependencyEdges.projectId, projectId), eq(dependencyEdges.active, true)));
  const surfaces = new Set<string>();
  for (const e of deps) {
    if (e.consumerRepoId === repoId || e.producedRepoId === repoId) surfaces.add(e.producedSurface);
  }
  for (const c of await tx.select().from(contracts).where(eq(contracts.repoId, repoId))) surfaces.add(c.surface);
  return [...surfaces];
}

/**
 * Binding product constraints (origin=document, doc active) in scope for a repo: those scoped directly
 * to a surface the repo touches, plus those scoped to a capability that governs such a surface (via
 * confirmed governs edges). Ranked by impact desc. The briefing + get_product_context backend.
 */
export async function constraintsInScope(
  orgId: string,
  projectId: string,
  repoId: string,
): Promise<ScopedConstraint[]> {
  return withOrg(orgId, (tx) => constraintsInScopeTx(tx, projectId, repoId));
}

async function constraintsInScopeTx(tx: Tx, projectId: string, repoId: string): Promise<ScopedConstraint[]> {
  const surfaces = await repoSurfacesTx(tx, projectId, repoId);
  if (surfaces.length === 0) return [];
  // Direct surface-scoped + capability-scoped (via surface→capability) constraint refs.
  const capRefs = new Set<string>();
  for (const s of surfaces) for (const c of await surfaceCapabilitiesTx(tx, projectId, s)) capRefs.add(c);
  const rows = await tx
    .select()
    .from(decisions)
    .where(and(eq(decisions.projectId, projectId), eq(decisions.origin, "document"), eq(decisions.status, "binding")));
  const surfaceSet = new Set(surfaces);
  const out: ScopedConstraint[] = [];
  for (const d of rows) {
    const inScope =
      (d.scopeKind === "surface" && surfaceSet.has(d.scopeRef)) ||
      (d.scopeKind === "capability" && capRefs.has(d.scopeRef));
    if (!inScope) continue;
    const detail = await constraintDetailTx(tx, d);
    if (!detail || detail.docState !== "active") continue; // only active-doc constraints reach agents
    out.push(detail);
  }
  out.sort((a, b) => b.impact - a.impact);
  return out;
}

/* ───────────────────────────── v3: drift detection (eng decision → active constraint) ───────────────────────────── */

/** The capability a constraint belongs to: its own scopeRef if capability-scoped, else the capability its source doc owns. */
async function constraintCapabilityRefTx(
  tx: Tx,
  projectId: string,
  constraint: typeof decisions.$inferSelect,
  doc: typeof sourceDocuments.$inferSelect | undefined,
): Promise<string | null> {
  if (constraint.scopeKind === "capability") return constraint.scopeRef;
  if (!doc) return null;
  const docNode = (
    await tx
      .select()
      .from(graphNodes)
      .where(
        and(
          eq(graphNodes.projectId, projectId),
          eq(graphNodes.kind, "doc"),
          eq(graphNodes.ref, `${doc.tool}:${doc.externalId}`),
        ),
      )
      .limit(1)
  )[0];
  if (!docNode) return null;
  const owns = (
    await tx
      .select()
      .from(graphEdges)
      .where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.fromId, docNode.id), eq(graphEdges.kind, "owns")))
      .limit(1)
  )[0];
  if (!owns) return null;
  const capNode = (
    await tx
      .select()
      .from(graphNodes)
      .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.id, owns.toId), eq(graphNodes.kind, "capability")))
      .limit(1)
  )[0];
  return capNode?.ref ?? null;
}

/** Queue an informational drift Slack DM to the constraint owner (rule-vs-rule, links both ways). */
async function enqueueDriftAlertTx(
  tx: Tx,
  orgId: string,
  input: {
    projectId: string;
    conflictId: string;
    surface: string;
    doc: typeof sourceDocuments.$inferSelect;
    constraintText: string;
    engText: string;
    engAuthorLogin: string | null;
  },
): Promise<void> {
  const recipientId = input.doc.ownerMemberId ?? input.doc.registeredBy;
  const recipient = recipientId
    ? (await tx.select().from(members).where(eq(members.id, recipientId)).limit(1))[0]
    : undefined;
  if (!recipient?.slackUserId) {
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      action: "digest.skipped",
      entityKind: "conflict",
      entityId: input.conflictId,
      payload: { reason: recipient ? "no_slack_user" : "no_recipient", kind: "drift_alert" },
    });
    return;
  }
  await tx
    .insert(writebacks)
    .values({
      orgId,
      projectId: input.projectId,
      connectionId: null,
      tool: "slack",
      kind: "drift_alert",
      targetRef: recipient.slackUserId,
      payload: {
        conflictId: input.conflictId,
        surface: input.surface,
        constraint: { ruleText: input.constraintText, docTitle: input.doc.title, docUrl: input.doc.url },
        eng: { ruleText: input.engText, author: input.engAuthorLogin },
      },
      dedupeKey: `drift:${input.conflictId}`,
    })
    .onConflictDoNothing();
}

/**
 * When an engineering decision reaches `binding`, open a `drift` conflict against every active-doc,
 * binding product constraint governing the same surface — unless this decision IS the constraint's
 * intended implementation (same feature tag, F7 suppression). Mirror of reconcileCandidateTx, reversed.
 * Runs in the same tx as the binding transition.
 */
export async function openDriftForEngDecisionTx(
  tx: Tx,
  orgId: string,
  eng: {
    decisionId: string;
    projectId: string;
    scopeKind: string;
    scopeRef: string;
    ruleText: string;
    authorMemberId: string;
    capabilityRef: string | null;
  },
): Promise<Array<{ conflictId: string; constraintDecisionId: string }>> {
  if (eng.scopeKind !== "surface") return []; // only surface-scoped eng decisions co-locate with constraints
  const surface = eng.scopeRef;
  const capRefs = new Set(await surfaceCapabilitiesTx(tx, eng.projectId, surface));
  const constraints = await tx
    .select()
    .from(decisions)
    .where(
      and(eq(decisions.projectId, eng.projectId), eq(decisions.origin, "document"), eq(decisions.status, "binding")),
    );
  const engLogin =
    (await tx.select({ l: members.githubLogin }).from(members).where(eq(members.id, eng.authorMemberId)).limit(1))[0]
      ?.l ?? null;
  const opened: Array<{ conflictId: string; constraintDecisionId: string }> = [];
  for (const c of constraints) {
    const governs =
      (c.scopeKind === "surface" && c.scopeRef === surface) ||
      (c.scopeKind === "capability" && capRefs.has(c.scopeRef));
    if (!governs) continue;
    // Resolve the constraint's doc + capability for suppression + the DM recipient.
    const cv = (
      await tx
        .select()
        .from(decisionVersions)
        .where(and(eq(decisionVersions.decisionId, c.id), eq(decisionVersions.version, c.currentVersion)))
        .limit(1)
    )[0];
    const docId = (cv?.provenance as { documentId?: string } | null)?.documentId;
    const doc = docId
      ? (await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, docId)).limit(1))[0]
      : undefined;
    if (!doc || doc.state !== "active") continue; // only active-doc constraints drift
    // Implementation suppression: the eng decision is tagged with the constraint's own feature.
    if (eng.capabilityRef) {
      const constraintCap = await constraintCapabilityRefTx(tx, eng.projectId, c, doc);
      if (constraintCap && constraintCap === eng.capabilityRef) continue;
    }
    const inserted = (
      await tx
        .insert(conflicts)
        .values({
          orgId,
          projectId: eng.projectId,
          constraintDecisionId: c.id,
          engDecisionId: eng.decisionId,
          surface,
          kind: "drift",
          status: "open",
        })
        .onConflictDoNothing()
        .returning()
    )[0];
    if (!inserted) continue; // already open — never re-notify
    await writeAudit(tx, {
      orgId,
      projectId: eng.projectId,
      action: "conflict.opened",
      entityKind: "conflict",
      entityId: inserted.id,
      payload: { kind: "drift", surface, constraintDecisionId: c.id, engDecisionId: eng.decisionId },
    });
    await enqueueDriftAlertTx(tx, orgId, {
      projectId: eng.projectId,
      conflictId: inserted.id,
      surface,
      doc,
      constraintText: cv?.ruleText ?? "",
      engText: eng.ruleText,
      engAuthorLogin: engLogin,
    });
    // Inbox item to the eng author: their decision is now in tension with a ratified constraint.
    await notifyConflictTx(tx, orgId, {
      projectId: eng.projectId,
      memberId: eng.authorMemberId,
      conflictId: inserted.id,
    });
    opened.push({ conflictId: inserted.id, constraintDecisionId: c.id });
  }
  return opened;
}

/**
 * Backstop: when a governs edge is confirmed for `capabilityRef`, a binding eng decision on one of the
 * capability's (now-)governed surfaces may not have tripped drift at bind time. Re-scan those surfaces.
 */
export async function openDriftForConfirmedCapabilityTx(
  tx: Tx,
  orgId: string,
  projectId: string,
  capabilityRef: string,
): Promise<void> {
  const surfaces = await capabilitySurfacesTx(tx, projectId, capabilityRef);
  for (const surface of surfaces) {
    const engs = await tx
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.projectId, projectId),
          eq(decisions.scopeKind, "surface"),
          eq(decisions.scopeRef, surface),
          eq(decisions.status, "binding"),
        ),
      );
    for (const e of engs) {
      if (e.origin === "document") continue;
      const ev = (
        await tx
          .select()
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, e.id), eq(decisionVersions.version, e.currentVersion)))
          .limit(1)
      )[0];
      await openDriftForEngDecisionTx(tx, orgId, {
        decisionId: e.id,
        projectId,
        scopeKind: e.scopeKind,
        scopeRef: e.scopeRef,
        ruleText: ev?.ruleText ?? "",
        authorMemberId: (ev?.proposedBy as string | null) ?? "",
        capabilityRef: (ev?.provenance as { capabilityRef?: string } | null)?.capabilityRef ?? null,
      });
    }
  }
}

/** Briefing token budget; constraints may consume at most 15% of it (PRD §14). No tokenizer dep. */
export const BRIEFING_TOKEN_BUDGET = 2000;
const CONSTRAINT_BUDGET = Math.floor(BRIEFING_TOKEN_BUDGET * 0.15);

/** One constraint's briefing line, for both token accounting and the `⚠ [ratified · doc]` render. */
export function constraintLine(c: ScopedConstraint): string {
  return `⚠ [ratified · ${c.docTitle ?? "PRD"}] ${c.ruleText} (impact ${c.impact})${c.conflictOpen ? " · conflict open" : ""}`;
}

/**
 * Apply the 15% briefing cap: keep highest-impact constraints until the token budget is exhausted,
 * truncating lowest-impact-first, and report how many were dropped. Input must be impact-desc sorted.
 */
export function capConstraints(constraints: ScopedConstraint[]): { shown: ScopedConstraint[]; overflow: number } {
  const shown: ScopedConstraint[] = [];
  let spent = 0;
  for (const c of constraints) {
    const cost = estimateTokens(constraintLine(c));
    if (shown.length > 0 && spent + cost > CONSTRAINT_BUDGET) break;
    shown.push(c);
    spent += cost;
  }
  return { shown, overflow: constraints.length - shown.length };
}

/* ── Phase P: project principles (TOMASP "meta-decision") ── */

// Principles are binding decisions with decisionType="principle" — the team's standing decision
// criteria ("server-side business logic → Ruby"). Few by design: small budget + hard item cap.
const PRINCIPLE_BUDGET = Math.floor(BRIEFING_TOKEN_BUDGET * 0.1);
const PRINCIPLE_MAX = 5;

export function principleLine(ruleText: string): string {
  return `◆ [principle] ${ruleText}`;
}

/** Binding project principles, impact-ranked, budget/item-capped for the session-start briefing. */
export async function projectPrinciples(
  orgId: string,
  projectId: string,
): Promise<{ principles: Array<{ line: string; impact: number }>; overflow: number }> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.projectId, projectId),
          eq(decisions.decisionType, "principle"),
          eq(decisions.status, "binding"),
        ),
      );
    rows.sort((a, b) => b.impact - a.impact);
    const principles: Array<{ line: string; impact: number }> = [];
    let spent = 0;
    for (const d of rows) {
      if (principles.length >= PRINCIPLE_MAX) break;
      const v = (
        await tx
          .select()
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, d.id), eq(decisionVersions.version, d.currentVersion)))
          .limit(1)
      )[0];
      const line = principleLine(v?.ruleText ?? "");
      const cost = estimateTokens(line);
      if (principles.length > 0 && spent + cost > PRINCIPLE_BUDGET) break;
      principles.push({ line, impact: d.impact });
      spent += cost;
    }
    return { principles, overflow: rows.length - principles.length };
  });
}

/** The GET /briefing backend: in-scope constraints, ranked + 15%-capped, with an overflow count. */
export async function briefingConstraints(
  orgId: string,
  projectId: string,
  repoId: string,
): Promise<{ constraints: Array<ScopedConstraint & { line: string }>; overflow: number }> {
  const all = await constraintsInScope(orgId, projectId, repoId);
  const { shown, overflow } = capConstraints(all);
  return { constraints: shown.map((c) => ({ ...c, line: constraintLine(c) })), overflow };
}

/**
 * The get_product_context({scope}) backend. scope is a capability ref, a canonical surface id, or free
 * text; returns the full constraint set (no budget cap — this is the pull path) + governed surfaces.
 */
export async function getProductContext(
  orgId: string,
  projectId: string,
  scope: string,
  embedders?: RetrievalEmbedders,
): Promise<{
  scope: string;
  constraints: ScopedConstraint[];
  governedSurfaces: string[];
}> {
  const FREE_TEXT_CAP = 30;
  // Phase 1 tx: structural branches complete here; the free-text branch only gathers candidates
  // (semantic scoring is HTTP and must happen outside any transaction — embeddings.ts:10-12).
  const phase1 = await withOrg(orgId, async (tx) => {
    const isCapability = scope.startsWith("feature:") || scope.startsWith("metric:");
    const isSurface = /^(http:|proto:|gql:|pkg:)/.test(scope);
    const decRows = await tx
      .select()
      .from(decisions)
      .where(
        and(eq(decisions.projectId, projectId), eq(decisions.origin, "document"), eq(decisions.status, "binding")),
      );

    if (isCapability || isSurface) {
      let governedSurfaces: string[];
      let matched: typeof decRows;
      if (isCapability) {
        governedSurfaces = await capabilitySurfacesTx(tx, projectId, scope);
        matched = decRows.filter((d) => d.scopeKind === "capability" && d.scopeRef === scope);
      } else {
        const capRefs = await surfaceCapabilitiesTx(tx, projectId, scope);
        governedSurfaces = [scope];
        matched = decRows.filter(
          (d) =>
            (d.scopeKind === "surface" && d.scopeRef === scope) ||
            (d.scopeKind === "capability" && capRefs.includes(d.scopeRef)),
        );
      }
      const constraints: ScopedConstraint[] = [];
      for (const d of matched) {
        const detail = await constraintDetailTx(tx, d);
        if (detail) constraints.push(detail);
      }
      constraints.sort((a, b) => b.impact - a.impact);
      return { structural: true as const, result: { scope, constraints, governedSurfaces } };
    }

    // Free text: batched substring pass (was an N+1 per-decision version fetch).
    const needle = scope.toLowerCase();
    const versions =
      decRows.length > 0
        ? await tx
            .select()
            .from(decisionVersions)
            .where(
              inArray(
                decisionVersions.decisionId,
                decRows.map((d) => d.id),
              ),
            )
        : [];
    const textByKey = new Map(versions.map((v) => [`${v.decisionId}:${v.version}`, v.ruleText]));
    const substringIds = new Set(
      decRows
        .filter((d) => `${d.scopeRef} ${textByKey.get(`${d.id}:${d.currentVersion}`) ?? ""}`.toLowerCase().includes(needle))
        .map((d) => d.id),
    );
    return { structural: false as const, candidateIds: new Set(decRows.map((d) => d.id)), substringIds };
  });
  if (phase1.structural) return phase1.result;

  // Semantic union restricted to the constraint corpus (candidateIds) — HTTP outside any tx.
  const scores = await semanticDecisionScores(orgId, projectId, scope, embedders, phase1.candidateIds);
  const matchedIds = new Set(phase1.substringIds);
  if (scores) {
    const semantic = [...scores.entries()]
      .filter(([id, s]) => !matchedIds.has(id) && s >= MIN_QUERY_SIM)
      .sort((a, b) => b[1] - a[1])
      .slice(0, SEMANTIC_TOP_K);
    for (const [id] of semantic) matchedIds.add(id);
  }

  // Phase 2 tx: resolve constraint details for the matched set. Sort stays impact-desc (contract).
  return withOrg(orgId, async (tx) => {
    const matched =
      matchedIds.size > 0
        ? await tx.select().from(decisions).where(inArray(decisions.id, [...matchedIds]))
        : [];
    const constraints: ScopedConstraint[] = [];
    for (const d of matched) {
      const detail = await constraintDetailTx(tx, d);
      if (detail) constraints.push(detail);
    }
    constraints.sort((a, b) => b.impact - a.impact);
    return { scope, constraints: constraints.slice(0, FREE_TEXT_CAP), governedSurfaces: [] };
  });
}

/* ───────────────────────────── Tier-2 reconcile (the hard gate) ───────────────────────────── */

/**
 * Reconcile a set of changed contract surfaces against the ledger. A contract change
 * with no binding decision is a violation (PR check fails). Also surfaces stale dependents.
 */
export async function reconcile(
  orgId: string,
  projectId: string,
  contractSurfaces: string[],
): Promise<{
  ok: boolean;
  violations: string[];
  staleDependents: Array<{ surface: string; consumers: string[] }>;
  confirmedGovernsEdges: Array<{ surface: string; capabilityRef: string }>;
  openConflicts: Array<{
    conflictId: string;
    surface: string;
    kind: string;
    constraintRuleText: string;
    engRuleText: string;
    docTitle: string | null;
    docUrl: string | null;
  }>;
}> {
  return withOrg(orgId, async (tx) => {
    const violations: string[] = [];
    const staleDependents: Array<{ surface: string; consumers: string[] }> = [];
    for (const surface of contractSurfaces) {
      const d = (
        await tx
          .select()
          .from(decisions)
          .where(and(eq(decisions.projectId, projectId), eq(decisions.scopeRef, surface)))
          .limit(1)
      )[0];
      if (!d || d.status !== "binding") violations.push(surface);
      const deps = await tx
        .select()
        .from(dependencyEdges)
        .where(and(eq(dependencyEdges.producedSurface, surface), eq(dependencyEdges.active, true)));
      if (deps.length > 0) {
        staleDependents.push({ surface, consumers: [...new Set(deps.map((e) => e.consumerRepoId))] });
      }
    }
    // v3: a surface shipping in a checked PR confirms its prospective capability mapping, and the
    // capability's constraints recompute their impact (they may now reach consumers' briefings).
    const confirmed = await confirmGovernsEdgesForSurfacesTx(tx, projectId, contractSurfaces);
    for (const ref of new Set(confirmed.map((c) => c.capabilityRef))) {
      await recomputeCapabilityImpactTx(tx, projectId, ref);
      // Backstop: a newly-confirmed edge may place an already-binding eng decision under this
      // capability's constraints — scan for drift that bind-time detection couldn't have seen.
      await openDriftForConfirmedCapabilityTx(tx, orgId, projectId, ref);
    }
    // v3 enforcement (FR-PR-1): open conflicts on the changed surfaces — the PR gate warns/blocks on
    // these. Computed after the confirm loop so drift opened by this very reconcile is included.
    const openConflicts: Array<{
      conflictId: string;
      surface: string;
      kind: string;
      constraintRuleText: string;
      engRuleText: string;
      docTitle: string | null;
      docUrl: string | null;
    }> = [];
    if (contractSurfaces.length > 0) {
      const rows = await tx
        .select()
        .from(conflicts)
        .where(
          and(
            eq(conflicts.projectId, projectId),
            eq(conflicts.status, "open"),
            inArray(conflicts.surface, contractSurfaces),
          ),
        );
      for (const k of rows) {
        const detail = await constraintDetailTx(
          tx,
          (await tx.select().from(decisions).where(eq(decisions.id, k.constraintDecisionId)).limit(1))[0]!,
        );
        let engRuleText = "";
        if (k.engDecisionId) {
          const ed = (await tx.select().from(decisions).where(eq(decisions.id, k.engDecisionId)).limit(1))[0];
          const ev = ed
            ? (
                await tx
                  .select()
                  .from(decisionVersions)
                  .where(and(eq(decisionVersions.decisionId, ed.id), eq(decisionVersions.version, ed.currentVersion)))
                  .limit(1)
              )[0]
            : undefined;
          engRuleText = ev?.ruleText ?? "";
        }
        openConflicts.push({
          conflictId: k.id,
          surface: k.surface,
          kind: k.kind,
          constraintRuleText: detail?.ruleText ?? "",
          engRuleText,
          docTitle: detail?.docTitle ?? null,
          docUrl: detail?.docUrl ?? null,
        });
      }
    }
    return {
      ok: violations.length === 0,
      violations,
      staleDependents,
      confirmedGovernsEdges: confirmed.map((c) => ({ surface: c.surface, capabilityRef: c.capabilityRef })),
      openConflicts,
    };
  });
}

/**
 * Retrieval for query(): the agent synthesizes the answer; the core only returns rows.
 * Hybrid ranking: substring hits always included and first; cosine adds semantic neighbors when
 * embeddings are available (null ⇒ substring-only, the additive-layer doctrine). Rejected decisions
 * are excluded outright; superseded stay substring-matchable (history questions) but never semantic.
 */
export async function queryLedger(
  orgId: string,
  projectId: string,
  q: string,
  opts?: { scope?: string; embedders?: RetrievalEmbedders },
): Promise<{ decisions: unknown[]; changes: unknown[]; answeredQuestions: unknown[] }> {
  const needle = q.toLowerCase();
  const gathered = await withOrg(orgId, async (tx) => {
    const ds = (await tx.select().from(decisions).where(eq(decisions.projectId, projectId))).filter(
      (d) => d.status !== "rejected",
    );
    const versions =
      ds.length > 0
        ? await tx
            .select()
            .from(decisionVersions)
            .where(
              inArray(
                decisionVersions.decisionId,
                ds.map((d) => d.id),
              ),
            )
        : [];
    const textByKey = new Map(versions.map((v) => [`${v.decisionId}:${v.version}`, v.ruleText]));
    const decRows = ds.map((d) => ({
      id: d.id,
      scopeRef: d.scopeRef,
      scopeKind: d.scopeKind,
      status: d.status,
      ruleText: textByKey.get(`${d.id}:${d.currentVersion}`) ?? "",
      // v3: mark product constraints so the agent can distinguish ratified PRD rules from
      // engineering decisions when it synthesizes the answer.
      origin: d.origin,
      isConstraint: d.origin === "document",
      constraintKind: d.constraintKind,
    }));
    const changes = (
      await tx
        .select()
        .from(changeFeedEntries)
        .where(eq(changeFeedEntries.projectId, projectId))
        .orderBy(desc(changeFeedEntries.createdAt))
        .limit(20)
    ).filter((c) => `${c.summary} ${c.surface ?? ""}`.toLowerCase().includes(needle));
    const answeredQuestions = (
      await tx
        .select()
        .from(questions)
        .where(and(eq(questions.projectId, projectId), eq(questions.status, "answered")))
    ).filter((qq) => qq.body.toLowerCase().includes(needle));
    return { decRows, changes, answeredQuestions };
  });

  const substringIds = new Set(
    gathered.decRows.filter((r) => `${r.scopeRef} ${r.ruleText}`.toLowerCase().includes(needle)).map((r) => r.id),
  );
  // HTTP happens here, outside any transaction (embeddings.ts:10-12 rule).
  const scores = await semanticDecisionScores(orgId, projectId, q, opts?.embedders);
  let ranked = hybridRank(gathered.decRows, substringIds, scores);
  if (opts?.scope) {
    // Scope boost, not a filter: rows on the asked-about scope float to the top.
    ranked = [...ranked.filter((r) => r.scopeRef === opts.scope), ...ranked.filter((r) => r.scopeRef !== opts.scope)];
  }
  return { decisions: ranked, changes: gathered.changes, answeredQuestions: gathered.answeredQuestions };
}
