/**
 * #6 embedding-based fusion/supersession — core's only AI seam. Voyage AI embeddings over decision
 * ruleText, cached per decision (current version) in `decision_embeddings`, cosine computed in
 * TypeScript (deliberately NOT pgvector: the sole comparison is among <10 scope-mates).
 *
 * Failure posture: `embedTexts` NEVER throws — null means "no embeddings available" and the caller
 * (fileProposedDecision's scope scan) falls back to Jaccard wholesale, i.e. exactly the pre-#6
 * behavior. Unset VOYAGE_API_KEY ⇒ always null ⇒ CI and self-hosts without a key are unaffected.
 *
 * Tx safety: prepareScopeSimilarity does its HTTP call OUTSIDE any transaction — a read-only tx to
 * gather mates + cache, the Voyage call in the open, then a short write tx to upsert the cache.
 */
import { and, eq, inArray } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import { decisions, decisionVersions, decisionEmbeddings, ingestArtifacts } from "../db/schema.js";
import { env } from "../env.js";

export const EMBED_MODEL = "voyage-3.5-lite";
/**
 * Cosine thresholds — STARTING POINTS, tuned from the `similarity: {method, score}` audit payloads
 * (every fuse/supersede outcome records which path fired and its score). Voyage cosine clusters
 * high, so these do NOT mirror the Jaccard 0.6/0.4 pair (which stays untouched on the fallback path).
 */
export const EMBED_FUSE_MIN = 0.85;
export const EMBED_SUPERSEDE_MAX = 0.6;

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const TIMEOUT_MS = 10_000;

export type Embedder = (texts: string[]) => Promise<number[][] | null>;

/** Batched Voyage call. Returns null (never throws) when the key is unset or the call fails. */
async function voyageEmbed(texts: string[], inputType: "document" | "query"): Promise<number[][] | null> {
  if (!env.VOYAGE_API_KEY || texts.length === 0) return null;
  try {
    const res = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.VOYAGE_API_KEY}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts, input_type: inputType }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> };
    if (!data.data || data.data.length !== texts.length) return null;
    const out: number[][] = new Array(texts.length);
    for (const d of data.data) out[d.index] = d.embedding;
    return out.every(Boolean) ? out : null;
  } catch {
    return null;
  }
}

export const embedTexts: Embedder = (texts) => voyageEmbed(texts, "document");
/** Query-side embeddings (Voyage's asymmetric convention) — used by retrieval, never cached. */
export const embedQueryTexts: Embedder = (texts) => voyageEmbed(texts, "query");

/**
 * Single writer for the mutable embedding cache (the sanctioned append-only deviation): update in
 * place when a row exists (version/model are staleness markers, not part of the key), insert otherwise.
 */
export async function upsertEmbeddingsTx(
  tx: Tx,
  orgId: string,
  rows: Array<{ decisionId: string; version: number; embedding: number[]; existingId?: string }>,
): Promise<void> {
  for (const r of rows) {
    if (r.existingId) {
      await tx
        .update(decisionEmbeddings)
        .set({ version: r.version, model: EMBED_MODEL, embedding: r.embedding, updatedAt: new Date() })
        .where(eq(decisionEmbeddings.id, r.existingId));
    } else {
      await tx.insert(decisionEmbeddings).values({
        orgId,
        decisionId: r.decisionId,
        version: r.version,
        model: EMBED_MODEL,
        embedding: r.embedding,
      });
    }
  }
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Pre-pass for fileProposedDecision's scope scan: cosine scores of the incoming ruleText against
 * every live scope-mate. Null ⇒ caller uses Jaccard wholesale. A mate missing from the map (e.g.
 * created between this pre-pass and the main tx) falls back to Jaccard individually — race-safe.
 *
 * Lazy cache with zero eager hooks: no ruleText write path computes embeddings; this sole reader
 * embeds what is missing or version-stale and upserts the cache. Deduped items (already-seen
 * (connectionId, externalId, contentHash)) short-circuit BEFORE any embedding call.
 */
export async function prepareScopeSimilarity(
  orgId: string,
  input: {
    projectId: string;
    scopeRef: string;
    ruleText: string;
    dedupe?: { connectionId: string; externalId: string; contentHash: string };
  },
  embedder: Embedder = embedTexts,
): Promise<Map<string, number> | null> {
  if (!env.VOYAGE_API_KEY && embedder === embedTexts) return null; // cheap out — no key, no HTTP, pure Jaccard

  // 1) read-only: dedupe short-circuit + scope-mates + their current ruleTexts + cached vectors.
  const gathered = await withOrg(orgId, async (tx) => {
    if (input.dedupe) {
      const seen = (
        await tx
          .select({ id: ingestArtifacts.id })
          .from(ingestArtifacts)
          .where(
            and(
              eq(ingestArtifacts.connectionId, input.dedupe.connectionId),
              eq(ingestArtifacts.externalId, input.dedupe.externalId),
              eq(ingestArtifacts.contentHash, input.dedupe.contentHash),
            ),
          )
          .limit(1)
      )[0];
      if (seen) return null; // re-seen unit — fileProposedDecision will dedupe, don't spend an embed
    }
    const mates = (
      await tx
        .select()
        .from(decisions)
        .where(and(eq(decisions.projectId, input.projectId), eq(decisions.scopeRef, input.scopeRef)))
    ).filter((m) => m.status !== "rejected" && m.status !== "superseded");
    if (mates.length === 0) return { mates: [], cached: [] as (typeof decisionEmbeddings.$inferSelect)[] };
    const rows: Array<{ id: string; version: number; ruleText: string }> = [];
    for (const m of mates) {
      const v = (
        await tx
          .select({ ruleText: decisionVersions.ruleText })
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, m.id), eq(decisionVersions.version, m.currentVersion)))
          .limit(1)
      )[0];
      rows.push({ id: m.id, version: m.currentVersion, ruleText: v?.ruleText ?? "" });
    }
    const cached = await tx
      .select()
      .from(decisionEmbeddings)
      .where(
        inArray(
          decisionEmbeddings.decisionId,
          rows.map((r) => r.id),
        ),
      );
    return { mates: rows, cached };
  });
  if (gathered === null) return null; // deduped — no scoring needed
  if (gathered.mates.length === 0) return new Map();

  const cacheByDecision = new Map(gathered.cached.map((c) => [c.decisionId, c]));
  const fresh = (id: string, version: number) => {
    const c = cacheByDecision.get(id);
    return c && c.version === version && c.model === EMBED_MODEL ? (c.embedding as number[]) : null;
  };
  const toEmbed = gathered.mates.filter((m) => !fresh(m.id, m.version));

  // 2) OUTSIDE any tx: one batched call — the new ruleText + every missing/stale mate.
  const vectors = await embedder([input.ruleText, ...toEmbed.map((m) => m.ruleText)]);
  if (!vectors) return null; // no key / outage / shape mismatch → Jaccard wholesale
  const incoming = vectors[0]!;
  const mateVec = new Map<string, number[]>();
  toEmbed.forEach((m, i) => mateVec.set(m.id, vectors[i + 1]!));

  // 3) short write tx: upsert the cache for what we just embedded.
  if (toEmbed.length > 0) {
    await withOrg(orgId, async (tx) => {
      await upsertEmbeddingsTx(
        tx,
        orgId,
        toEmbed.map((m) => ({
          decisionId: m.id,
          version: m.version,
          embedding: mateVec.get(m.id)!,
          existingId: cacheByDecision.get(m.id)?.id,
        })),
      );
    });
  }

  const scores = new Map<string, number>();
  for (const m of gathered.mates) {
    const vec = mateVec.get(m.id) ?? fresh(m.id, m.version);
    if (vec) scores.set(m.id, cosine(incoming, vec));
  }
  return scores;
}
