/**
 * Gateway event drain against a faked EventsClient + StubConnector — no network, no LLM (injected
 * recall/extract). The contract: threads re-fetch at sweep granularity and file as proposals;
 * vanished threads complete as done (retries can't resurrect them); a failed batch releases its
 * events for retry; a connector-less batch fails its events.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { drainEvents, type EventsClient } from "./events.js";
import { StubConnector } from "./connectors/StubConnector.js";
import type { PendingEventBatch, ProposedItem } from "./client.js";
import type { Extraction } from "./distill/rubric.js";

const CHANNEL = "C_STUB";
const ROOT_TS = "1699000001.0001"; // the decision thread in StubConnector.sample()

function batch(events: PendingEventBatch["events"], over: Partial<PendingEventBatch> = {}): PendingEventBatch {
  return {
    orgId: "org-1",
    connectionId: "conn-1",
    tool: "slack",
    entity: "org-1",
    connectedAccountId: "acct-1",
    events,
    ...over,
  };
}

function fakeClient(batches: PendingEventBatch[], opts: { postFails?: boolean } = {}) {
  const done: Array<{ ids: string[]; ok: boolean }> = [];
  const posted: ProposedItem[][] = [];
  const ls: EventsClient = {
    getPendingEvents: async () => batches,
    markEventsDone: async (ids, ok) => {
      done.push({ ids, ok });
    },
    postProposed: async (items) => {
      if (opts.postFails) throw new Error("core down");
      posted.push(items);
      return { filed: items.length, deduped: 0 };
    },
  };
  return { ls, done, posted };
}

const alwaysRecall = async () => true;
const fakeExtract = async (id: string, text: string): Promise<Extraction> => ({
  is_decision: true,
  decision_type: "rule",
  finality: "agreed",
  rule_text: text.includes("JWT") ? "Auth tokens are JWT with 15-minute expiry." : "other",
  rationale: "stateless",
  alternatives_considered: [],
  decided_by: ["@alice"],
  scope_hint: "http:POST /auth/session",
  surface_candidates: ["http:POST /auth/session"],
  review_hint: "",
  confidence: 0.9,
  evidence: [{ externalId: id, quote: "lock it" }],
});

test("claimed thread events re-fetch, distill, file, and complete as done", async () => {
  const ev = { id: "e1", projectId: "proj-1", sourceRef: CHANNEL, threadKey: `${CHANNEL}/${ROOT_TS}`, threadTs: ROOT_TS };
  const { ls, done, posted } = fakeClient([batch([ev])]);
  const res = await drainEvents(ls, {
    fetcherFor: () => new StubConnector(),
    recallFn: alwaysRecall,
    extractFn: fakeExtract,
  });
  assert.equal(res.processed, 1);
  assert.equal(res.proposed, 1);
  assert.equal(res.failed, 0);
  assert.equal(posted[0]!.length, 1);
  assert.equal(posted[0]![0]!.externalId, `${CHANNEL}/${ROOT_TS}`, "sweep-identical unit key");
  assert.equal(posted[0]![0]!.projectId, "proj-1", "routes to the allowlist row's project");
  assert.deepEqual(done, [{ ids: ["e1"], ok: true }]);
});

test("a vanished thread is done (not retried); a missing connector fails the batch", async () => {
  const gone = { id: "e2", projectId: "p", sourceRef: CHANNEL, threadKey: `${CHANNEL}/404.0`, threadTs: "404.0" };
  const { ls, done, posted } = fakeClient([batch([gone])]);
  const res = await drainEvents(ls, { fetcherFor: () => new StubConnector(), recallFn: alwaysRecall, extractFn: fakeExtract });
  assert.equal(res.processed, 1);
  assert.equal(posted.length, 0, "nothing filed for a deleted thread");
  assert.deepEqual(done, [{ ids: ["e2"], ok: true }]);

  const { ls: ls2, done: done2 } = fakeClient([batch([gone], { connectedAccountId: null })]);
  const res2 = await drainEvents(ls2, {
    fetcherFor: (b) => (b.connectedAccountId ? new StubConnector() : null),
    recallFn: alwaysRecall,
    extractFn: fakeExtract,
  });
  assert.equal(res2.failed, 1);
  assert.deepEqual(done2, [{ ids: ["e2"], ok: false }]);
});

test("a filing failure releases the batch's events for retry", async () => {
  const ev = { id: "e3", projectId: "p", sourceRef: CHANNEL, threadKey: `${CHANNEL}/${ROOT_TS}`, threadTs: ROOT_TS };
  const { ls, done } = fakeClient([batch([ev])], { postFails: true });
  const res = await drainEvents(ls, { fetcherFor: () => new StubConnector(), recallFn: alwaysRecall, extractFn: fakeExtract });
  assert.equal(res.processed, 0);
  assert.equal(res.failed, 1);
  assert.deepEqual(done, [{ ids: ["e3"], ok: false }]);
});
