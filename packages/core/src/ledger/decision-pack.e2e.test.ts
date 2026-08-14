/**
 * Decision pack: deterministic render (unit) + ledger round-trips against real Postgres (e2e).
 * The contract: same ledger state ⇒ same body ⇒ same hash (generatedAt excluded); binding
 * transitions move decisions between sections and change the hash; orgs never leak.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withSystem } from "../db/rls.js";
import { orgs, principals, members, projects } from "../db/schema.js";
import { proposeDecision, confirmDecision, fileProposedDecision } from "./ledger-service.js";
import type { Embedder } from "./embeddings.js";
import { renderDecisionPack, getDecisionPack, getDecisionPackHash, type PackDecision } from "./decision-pack.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 970_000_000;
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `Pack-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `u-${n}` }).returning());
    const m = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `u-${n}` })
        .returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "pack", createdBy: m.id }).returning());
    return { orgId: org.id, projectId: proj.id, memberId: m.id };
  });
}

function mkDecision(over: Partial<PackDecision>): PackDecision {
  return {
    id: randomUUID(),
    scopeKind: "surface",
    scopeRef: "http:POST /x",
    status: "binding",
    origin: "agent",
    version: 1,
    ruleText: "rule",
    provenance: null,
    decisionType: "rule",
    impact: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    rationale: null,
    alternatives: null,
    reviewAt: null,
    dueForReview: false,
    supersededById: null,
    supersedes: [],
    proposedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

test("render: deterministic — shuffled input, identical body and hash", () => {
  const ds = [
    mkDecision({ ruleText: "A", scopeRef: "http:GET /a", impact: 2 }),
    mkDecision({ ruleText: "B", scopeRef: "http:GET /b", rationale: "why B", alternatives: ["alt1", "alt2"] }),
    mkDecision({ ruleText: "P", decisionType: "principle" }),
    mkDecision({ ruleText: "C", origin: "document" }),
    mkDecision({ ruleText: "old", status: "superseded", supersededById: randomUUID() }),
  ];
  const a = renderDecisionPack({ projectName: "proj", decisions: ds });
  const b = renderDecisionPack({ projectName: "proj", decisions: [...ds].reverse() });
  assert.equal(a.body, b.body);
  assert.equal(a.packHash, b.packHash);
  assert.deepEqual(a.counts, { principles: 1, binding: 2, constraints: 1, superseded: 1 });
});

test("render: section membership and content", () => {
  const { body } = renderDecisionPack({
    projectName: "proj",
    decisions: [
      mkDecision({ ruleText: "Server logic goes in Ruby", decisionType: "principle" }),
      mkDecision({
        ruleText: "Sessions use JWT",
        rationale: "stateless scaling",
        alternatives: ["server sessions"],
        reviewAt: new Date("2026-09-01T00:00:00Z"),
      }),
      mkDecision({ ruleText: "Checkout must support UPI", origin: "document" }),
      mkDecision({ ruleText: "Old cookie auth", status: "superseded", supersededById: "abcd1234-x" }),
      mkDecision({ ruleText: "never shown", status: "proposed" }),
      mkDecision({ ruleText: "never shown either", status: "open" }),
    ],
  });
  assert.match(body, /## Principles\n\n- Server logic goes in Ruby/);
  assert.match(body, /### surface: http:POST \/x\n\n- Sessions use JWT/);
  assert.match(body, /Why: stateless scaling/);
  assert.match(body, /Rejected: server sessions/);
  assert.match(body, /Review by: 2026-09-01/);
  assert.match(body, /## Product constraints \(ratified\)[\s\S]*Checkout must support UPI/);
  assert.match(body, /~~Old cookie auth~~ → superseded by lockstep:abcd1234/);
  assert.ok(!body.includes("never shown"), "open/proposed decisions are excluded");
});

test("render: any decision change changes the hash", () => {
  const base = [mkDecision({ ruleText: "Sessions use JWT" })];
  const h1 = renderDecisionPack({ projectName: "p", decisions: base }).packHash;
  const h2 = renderDecisionPack({
    projectName: "p",
    decisions: [mkDecision({ ...base[0]!, version: 2, ruleText: "Sessions use JWT v2" })],
  }).packHash;
  assert.notEqual(h1, h2);
});

test("e2e: bind → appears; supersede → moves to 'No longer true' and hash changes; briefing hash matches", async () => {
  const s = await setup();
  await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "surface",
    scopeRef: "http:POST /pack/auth",
    ruleText: "Auth tokens are JWT with 15-minute expiry.",
    baseVersion: 0,
    rationale: "stateless services",
    alternatives: ["server-side sessions"],
  });
  const p1 = await getDecisionPack(s.orgId, s.projectId);
  assert.match(p1.markdown, /Auth tokens are JWT with 15-minute expiry\./);
  assert.match(p1.markdown, /Why: stateless services/);
  assert.equal(p1.counts.binding, 1);
  assert.equal(await getDecisionPackHash(s.orgId, s.projectId), p1.packHash, "hash-only variant agrees");
  assert.match(p1.markdown, new RegExp(`<!-- lockstep-pack hash=${p1.packHash} `));

  // Orthogonal-topic proposal on the same scope records a supersedes hint; confirming it flips the old one.
  const byTopic: Embedder = async (texts) => texts.map((t) => (/jwt|json web token/i.test(t) ? [1, 0, 0] : [0, 1, 0]));
  const filed = await fileProposedDecision(
    s.orgId,
    {
      projectId: s.projectId,
      scopeKind: "surface",
      scopeRef: "http:POST /pack/auth",
      ruleText: "Rate-limit login attempts to five per minute.",
      provenance: { source: "slack", evidence: [{ externalId: "x", quote: "q" }] },
      connectionId: randomUUID(),
      externalId: randomUUID(),
      contentHash: randomUUID(),
      confidence: 90,
    },
    byTopic,
  );
  await confirmDecision(s.orgId, filed.decisionId, s.memberId);
  const p2 = await getDecisionPack(s.orgId, s.projectId);
  assert.notEqual(p2.packHash, p1.packHash, "binding transition changes the hash");
  assert.match(p2.markdown, /~~Auth tokens are JWT with 15-minute expiry\.~~/);
  assert.match(p2.markdown, /Rate-limit login attempts to five per minute\./);
  assert.equal(p2.counts.superseded, 1);
});

test("e2e: principles section + org isolation", async () => {
  const s = await setup();
  await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "project",
    scopeRef: "project:pack",
    ruleText: "Prefer boring technology.",
    baseVersion: 0,
    decisionType: "principle",
  });
  const p = await getDecisionPack(s.orgId, s.projectId);
  assert.match(p.markdown, /## Principles\n\n- Prefer boring technology\./);
  assert.equal(p.counts.principles, 1);

  const other = await setup();
  const otherPack = await getDecisionPack(other.orgId, other.projectId);
  assert.ok(!otherPack.markdown.includes("Prefer boring technology"), "org B's pack lacks org A's decisions");
  assert.equal(otherPack.counts.binding + otherPack.counts.principles, 0);
});
