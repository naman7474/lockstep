/**
 * Semantic retrieval: hybrid ranking against real Postgres with INJECTED fake embedders — no
 * network, no key. The contract: cosine is an additive layer (null ⇒ pure substring, exactly the
 * pre-feature behavior); substring hits always outrank semantic-only hits; embed-on-miss heals the
 * cache for agent-authored decisions; rejected decisions never surface.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withSystem, withOrg } from "../db/rls.js";
import { orgs, principals, members, projects, decisionEmbeddings } from "../db/schema.js";
import { proposeDecision, rejectDecision, confirmDecision, fileProposedDecision, queryLedger, getProductContext } from "./ledger-service.js";
import type { Embedder } from "./embeddings.js";
import type { RetrievalEmbedders } from "./retrieval.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 980_000_000;
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `Retr-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `u-${n}` }).returning());
    const m = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `u-${n}` })
        .returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "retr", createdBy: m.id }).returning());
    return { orgId: org.id, projectId: proj.id, memberId: m.id };
  });
}

/** Rules/queries about JWTs share one direction; everything else is orthogonal. */
const byTopic: Embedder = async (texts) => texts.map((t) => (/jwt|json web token/i.test(t) ? [1, 0, 0] : [0, 1, 0]));
const topical: RetrievalEmbedders = { doc: byTopic, query: byTopic };
const dead: RetrievalEmbedders = { doc: async () => null, query: async () => null };

type QueryRow = { id: string; ruleText: string; match: "exact" | "semantic"; score: number | null };

const propose = (s: { orgId: string; projectId: string; memberId: string }, ruleText: string, scopeRef: string) =>
  proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "surface",
    scopeRef,
    ruleText,
    baseVersion: 0,
  });

test("a paraphrase is found semantically where substring misses, and embed-on-miss heals the cache", async () => {
  const s = await setup();
  // "jwt" is NOT a substring of this rule — only the topic embedder can connect them.
  const d = await propose(s, "Use JSON Web Tokens that lapse after a quarter hour.", "http:POST /retr/auth");
  const res = await queryLedger(s.orgId, s.projectId, "jwt", { embedders: topical });
  const rows = res.decisions as QueryRow[];
  const hit = rows.find((r) => r.id === d.decisionId);
  assert.ok(hit, "semantic hit returned");
  assert.equal(hit!.match, "semantic");
  assert.ok(hit!.score! >= 0.99);

  // Agent-authored decisions were never embedded by the fusion path — the query healed the cache.
  const cache = await withOrg(s.orgId, (tx) =>
    tx.select().from(decisionEmbeddings).where(eq(decisionEmbeddings.decisionId, d.decisionId)),
  );
  assert.equal(cache.length, 1, "embed-on-miss upserted the vector");
});

test("null embedders ⇒ pure substring behavior (the additive-layer doctrine)", async () => {
  const s = await setup();
  await propose(s, "Use JSON Web Tokens that lapse after a quarter hour.", "http:POST /retr/auth");
  const semantic = await queryLedger(s.orgId, s.projectId, "jwt", { embedders: dead });
  assert.equal((semantic.decisions as QueryRow[]).length, 0, "no substring match, no embeddings, no result");
  const exact = await queryLedger(s.orgId, s.projectId, "json web tokens", { embedders: dead });
  const rows = exact.decisions as QueryRow[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.match, "exact");
});

test("substring hits rank ahead of higher-cosine semantic hits; scope boosts to front", async () => {
  const s = await setup();
  const exact = await propose(s, "JWT tokens expire after 15 minutes.", "http:POST /retr/a");
  const sem = await propose(s, "Use JSON Web Tokens that lapse after a quarter hour.", "http:POST /retr/b");
  const res = await queryLedger(s.orgId, s.projectId, "jwt", { embedders: topical });
  const rows = res.decisions as QueryRow[];
  assert.equal(rows[0]!.id, exact.decisionId, "exact first even though both score cosine 1");
  assert.equal(rows[0]!.match, "exact");
  assert.equal(rows[1]!.id, sem.decisionId);
  assert.equal(rows[1]!.match, "semantic");

  const boosted = await queryLedger(s.orgId, s.projectId, "jwt", { embedders: topical, scope: "http:POST /retr/b" });
  assert.equal((boosted.decisions as QueryRow[])[0]!.id, sem.decisionId, "scope boost floats its rows to the top");
});

test("rejected decisions never surface, even on exact substring", async () => {
  const s = await setup();
  const d = await propose(s, "JWT tokens expire after 15 minutes.", "http:POST /retr/auth");
  await rejectDecision(s.orgId, d.decisionId, s.memberId);
  const res = await queryLedger(s.orgId, s.projectId, "jwt", { embedders: topical });
  assert.equal((res.decisions as QueryRow[]).length, 0);
});

test("cache is warm on the second query — doc embedder is not called again", async () => {
  const s = await setup();
  await propose(s, "Use JSON Web Tokens that lapse after a quarter hour.", "http:POST /retr/auth");
  let docCalls = 0;
  let docTexts = 0;
  const countingDoc: Embedder = async (texts) => {
    docCalls++;
    docTexts += texts.length;
    return byTopic(texts);
  };
  const embedders: RetrievalEmbedders = { doc: countingDoc, query: byTopic };
  await queryLedger(s.orgId, s.projectId, "jwt", { embedders });
  assert.equal(docCalls, 1);
  assert.equal(docTexts, 1, "only the one missing decision was embedded");
  await queryLedger(s.orgId, s.projectId, "jwt", { embedders });
  assert.equal(docCalls, 1, "second query rides the cache — no doc embedding spent");
});

test("getProductContext free-text branch gains semantic hits; structural branch is untouched", async () => {
  const s = await setup();
  const filed = await fileProposedDecision(s.orgId, {
    projectId: s.projectId,
    scopeKind: "surface",
    scopeRef: "http:POST /retr/session",
    ruleText: "Sessions must use JSON Web Tokens across all clients.",
    provenance: { source: "notion", evidence: [{ externalId: "x", quote: "q" }] },
    connectionId: randomUUID(),
    externalId: randomUUID(),
    contentHash: randomUUID(),
    confidence: 90,
    origin: "document",
    constraintKind: "behavioral",
  });
  await confirmDecision(s.orgId, filed.decisionId, s.memberId);

  const free = await getProductContext(s.orgId, s.projectId, "jwt", topical);
  assert.equal(free.constraints.length, 1, "semantic free-text hit on the constraint corpus");
  assert.match(free.constraints[0]!.ruleText, /JSON Web Tokens/);

  const structural = await getProductContext(s.orgId, s.projectId, "http:POST /retr/session", topical);
  assert.equal(structural.constraints.length, 1);
  assert.deepEqual(structural.governedSurfaces, ["http:POST /retr/session"]);

  const withoutEmbeddings = await getProductContext(s.orgId, s.projectId, "jwt", dead);
  assert.equal(withoutEmbeddings.constraints.length, 0, "no embeddings ⇒ substring-only, unchanged behavior");
});
