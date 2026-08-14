/**
 * Semantic retrieval over the decision ledger — cosine ranking layered ON TOP of the existing
 * substring matching, never replacing it.
 *
 * Doctrine (same as fusion, embeddings.ts): embeddings are a strictly-optional enhancement. When
 * `semanticDecisionScores` returns null (no VOYAGE_API_KEY, outage, empty corpus) callers keep the
 * pure substring behavior byte-identical to before. Substring hits always rank ahead of
 * semantic-only hits — an exact token match beats a fuzzy neighbor.
 *
 * Coverage self-heals: the fusion path only ever embedded scope-mates of ingested decisions, so
 * agent-authored decisions had no vectors. Each retrieval request embeds up to MAX_EMBED_ON_MISS
 * missing/stale corpus rows (highest-impact first) and upserts them into the shared cache —
 * the same read-tx → HTTP-outside-tx → short-write-tx shape as prepareScopeSimilarity.
 */
import { and, eq, inArray } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import { decisions, decisionVersions, decisionEmbeddings } from "../db/schema.js";
import { env } from "../env.js";
import {
  EMBED_MODEL,
  cosine,
  embedTexts,
  embedQueryTexts,
  upsertEmbeddingsTx,
  type Embedder,
} from "./embeddings.js";

/** Starting points — tune from real query telemetry, like EMBED_FUSE_MIN. */
export const SEMANTIC_TOP_K = 12;
export const MIN_QUERY_SIM = 0.45;
export const MAX_EMBED_ON_MISS = 64;

export interface RetrievalEmbedders {
  doc: Embedder;
  query: Embedder;
}

const DEFAULT_EMBEDDERS: RetrievalEmbedders = { doc: embedTexts, query: embedQueryTexts };

/**
 * Cosine scores of `queryText` against the project's live decisions (status ∉ {rejected, superseded}),
 * optionally restricted to `candidateIds`. Null ⇒ caller stays on pure substring.
 */
export async function semanticDecisionScores(
  orgId: string,
  projectId: string,
  queryText: string,
  embedders: RetrievalEmbedders = DEFAULT_EMBEDDERS,
  candidateIds?: Set<string>,
): Promise<Map<string, number> | null> {
  if (!env.VOYAGE_API_KEY && embedders === DEFAULT_EMBEDDERS) return null; // cheap out — no key, no HTTP

  // 1) read-only: live candidates + their current ruleTexts (batched) + cached vectors.
  const gathered = await withOrg(orgId, async (tx) => {
    const ds = (await tx.select().from(decisions).where(eq(decisions.projectId, projectId))).filter(
      (d) =>
        d.status !== "rejected" &&
        d.status !== "superseded" &&
        (candidateIds === undefined || candidateIds.has(d.id)),
    );
    if (ds.length === 0) return { rows: [], cached: [] as (typeof decisionEmbeddings.$inferSelect)[] };
    const versions = await tx
      .select()
      .from(decisionVersions)
      .where(
        inArray(
          decisionVersions.decisionId,
          ds.map((d) => d.id),
        ),
      );
    const textByKey = new Map(versions.map((v) => [`${v.decisionId}:${v.version}`, v.ruleText]));
    const rows = ds.map((d) => ({
      id: d.id,
      version: d.currentVersion,
      impact: d.impact,
      ruleText: textByKey.get(`${d.id}:${d.currentVersion}`) ?? "",
    }));
    const cached = await tx
      .select()
      .from(decisionEmbeddings)
      .where(
        inArray(
          decisionEmbeddings.decisionId,
          rows.map((r) => r.id),
        ),
      );
    return { rows, cached };
  });
  if (gathered.rows.length === 0) return new Map();

  const cacheByDecision = new Map(gathered.cached.map((c) => [c.decisionId, c]));
  const fresh = (id: string, version: number): number[] | null => {
    const c = cacheByDecision.get(id);
    return c && c.version === version && c.model === EMBED_MODEL ? (c.embedding as number[]) : null;
  };
  const missing = gathered.rows
    .filter((r) => !fresh(r.id, r.version) && r.ruleText.length > 0)
    .sort((a, b) => b.impact - a.impact)
    .slice(0, MAX_EMBED_ON_MISS);

  // 2) OUTSIDE any tx: two calls — asymmetric input_type means query and docs can't share one batch.
  const queryVec = await embedders.query([queryText]);
  if (!queryVec) return null;
  const docVecs = missing.length > 0 ? await embedders.doc(missing.map((m) => m.ruleText)) : [];
  const missVec = new Map<string, number[]>();
  if (docVecs) missing.forEach((m, i) => missVec.set(m.id, docVecs[i]!));

  // 3) short write tx: heal the cache with what we just embedded.
  if (docVecs && missing.length > 0) {
    await withOrg(orgId, async (tx) => {
      await upsertEmbeddingsTx(
        tx,
        orgId,
        missing.map((m) => ({
          decisionId: m.id,
          version: m.version,
          embedding: missVec.get(m.id)!,
          existingId: cacheByDecision.get(m.id)?.id,
        })),
      );
    });
  }

  const scores = new Map<string, number>();
  for (const r of gathered.rows) {
    const vec = missVec.get(r.id) ?? fresh(r.id, r.version);
    if (vec) scores.set(r.id, cosine(queryVec[0]!, vec));
  }
  return scores;
}

/**
 * Hybrid ranking: every substring hit is kept and ranks first (marked "exact"); semantic-only hits
 * need score ≥ MIN_QUERY_SIM and at most SEMANTIC_TOP_K are added, best first.
 */
export function hybridRank<T extends { id: string }>(
  rows: T[],
  substringIds: Set<string>,
  scores: Map<string, number> | null,
): Array<T & { match: "exact" | "semantic"; score: number | null }> {
  const exact = rows
    .filter((r) => substringIds.has(r.id))
    .map((r) => ({ ...r, match: "exact" as const, score: scores?.get(r.id) ?? null }));
  if (!scores) return exact;
  const semantic = rows
    .filter((r) => !substringIds.has(r.id) && (scores.get(r.id) ?? 0) >= MIN_QUERY_SIM)
    .map((r) => ({ ...r, match: "semantic" as const, score: scores.get(r.id)! }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SEMANTIC_TOP_K);
  return [...exact, ...semantic];
}
