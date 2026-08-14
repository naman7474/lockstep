import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveSession, type SessionContext } from "../session-context.js";
import {
  proposeDecision,
  ackDecision,
  listDecisions,
  registerDependency,
  recordChange,
  listConsumers,
  listProjectSurfaces,
  syncProducedSurfaces,
  queryLedger,
  askQuestion,
  answerQuestion,
  createTask,
  completeTask,
  reconcile,
  briefingConstraints,
  projectPrinciples,
  getProductContext,
} from "../../ledger/ledger-service.js";
import { getDecisionPack, getDecisionPackHash } from "../../ledger/decision-pack.js";
import { whoowns, refreshOwnership } from "../../graph/ownership-service.js";
import { readInbox, peekInbox, ackInbox, peekInboxByRemote } from "../../inbox/inbox-service.js";
import { productLayerOn } from "../guards.js";

/** Resolve the session context from the x-lockstep-session header (set by the MCP server). */
async function ctx(req: FastifyRequest, reply: FastifyReply): Promise<SessionContext | null> {
  const p = req.principal;
  if (!p) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  const sid = req.headers["x-lockstep-session"];
  if (!sid || typeof sid !== "string") {
    reply.code(400).send({ error: "x-lockstep-session header required" });
    return null;
  }
  const c = await resolveSession(p, sid);
  if (!c) {
    reply.code(403).send({ error: "invalid session" });
    return null;
  }
  return c;
}

export async function ledgerRoutes(app: FastifyInstance): Promise<void> {
  // notify(summary, contract_delta, scope, risk_tier)
  app.post("/changes", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as {
      summary?: string;
      surface?: string;
      contractDelta?: unknown;
      riskTier?: string;
      verified?: boolean;
      verifiedAgainst?: string;
      diffHash?: string;
      capabilityRef?: string;
    };
    if (!b?.summary) return reply.code(400).send({ error: "summary required" });
    return recordChange(c.orgId, {
      projectId: c.projectId,
      repoId: c.repoId,
      memberId: c.memberId,
      summary: b.summary,
      surface: b.surface,
      contractDelta: b.contractDelta,
      riskTier: b.riskTier,
      verified: b.verified,
      verifiedAgainst: b.verifiedAgainst,
      diffHash: b.diffHash,
      capabilityRef: b.capabilityRef,
    });
  });

  // propose_decision(rule, scope, base_version)
  app.post("/decisions", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as {
      scopeKind?: string;
      scopeRef?: string;
      ruleText?: string;
      baseVersion?: number;
      decisionType?: string;
      provenance?: unknown;
      capabilityRef?: string;
      rationale?: string;
      alternatives?: string[];
      reviewAt?: string;
    };
    if (!b?.scopeKind || !b?.scopeRef || !b?.ruleText || b.baseVersion === undefined) {
      return reply.code(400).send({ error: "scopeKind, scopeRef, ruleText, baseVersion required" });
    }
    let reviewAt: Date | undefined;
    if (b.reviewAt !== undefined) {
      reviewAt = new Date(b.reviewAt);
      if (Number.isNaN(reviewAt.getTime())) return reply.code(400).send({ error: "reviewAt must be an ISO date" });
    }
    return proposeDecision(c.orgId, {
      projectId: c.projectId,
      memberId: c.memberId,
      scopeKind: b.scopeKind,
      scopeRef: b.scopeRef,
      ruleText: b.ruleText,
      baseVersion: b.baseVersion,
      decisionType: b.decisionType,
      provenance: b.provenance,
      capabilityRef: b.capabilityRef,
      rationale: b.rationale,
      alternatives: b.alternatives,
      reviewAt,
    });
  });

  // ack_decision(decision_id, version, verdict?)
  app.post("/decisions/:id/ack", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { id } = req.params as { id: string };
    const b = req.body as { version?: number; verdict?: string };
    if (b?.version === undefined) return reply.code(400).send({ error: "version required" });
    return ackDecision(c.orgId, id, b.version, c.memberId, b.verdict ?? "ack");
  });

  // decisions(scope)
  app.get("/decisions", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { scope } = req.query as { scope?: string };
    return { decisions: await listDecisions(c.orgId, c.projectId, scope) };
  });

  // briefing — ranked, 15%-budget-capped product constraints in scope for this repo (session start),
  // plus project principles (Phase P). The product-layer gate silences only the CONSTRAINTS —
  // principles are engineering meta-decisions and flow regardless.
  app.get("/briefing", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const p = await projectPrinciples(c.orgId, c.projectId);
    // Additive staleness signal: the current compiled decision-pack hash. The CLI compares it to
    // the locally-written pack's embedded hash and nudges (read-only) when they diverge.
    const pack = { hash: await getDecisionPackHash(c.orgId, c.projectId) };
    if (!(await productLayerOn(c.orgId, c.projectId)))
      return { constraints: [], overflow: 0, principles: p.principles, principlesOverflow: p.overflow, pack };
    const b = await briefingConstraints(c.orgId, c.projectId, c.repoId);
    return { ...b, principles: p.principles, principlesOverflow: p.overflow, pack };
  });

  // decision-pack — the compiled per-project SKILL.md (settled decisions only, uncapped).
  // Written to disk by `lockstep pack` / the refresh_decision_pack MCP tool, never by hooks.
  app.get("/decision-pack", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    return getDecisionPack(c.orgId, c.projectId);
  });

  // get_product_context(scope) — pull-based depth: full constraint set for a capability/surface/text.
  // Principles ride along uncapped (the pull path) — same product-layer carve-out as /briefing.
  app.get("/product-context", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { scope } = req.query as { scope?: string };
    if (!scope) return reply.code(400).send({ error: "scope query param required" });
    const p = await projectPrinciples(c.orgId, c.projectId);
    if (!(await productLayerOn(c.orgId, c.projectId)))
      return { scope, constraints: [], governedSurfaces: [], principles: p.principles };
    const full = await getProductContext(c.orgId, c.projectId, scope);
    return { ...full, principles: p.principles };
  });

  // register_dependency(consumer, produced_surface)
  app.post("/dependencies", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as { producedSurface?: string; producedRepoId?: string; source?: string };
    if (!b?.producedSurface) return reply.code(400).send({ error: "producedSurface required" });
    return registerDependency(c.orgId, {
      projectId: c.projectId,
      memberId: c.memberId,
      consumerRepoId: c.repoId,
      producedSurface: b.producedSurface,
      producedRepoId: b.producedRepoId ?? null,
      source: b.source,
    });
  });

  // consumers(surface) — "does anyone use this endpoint?" answered from the usage graph
  app.get("/consumers", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { surface } = req.query as { surface?: string };
    if (!surface) return reply.code(400).send({ error: "surface query param required" });
    return listConsumers(c.orgId, c.projectId, surface, c.repoId);
  });

  // surfaces — the project's produced-surface catalog; `lockstep scan` matches outbound calls against it
  app.get("/surfaces", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const surfaces = await listProjectSurfaces(c.orgId, c.projectId);
    return { surfaces };
  });

  // surfaces (sync) — register the surfaces THIS repo produces, so the catalog above stays complete
  app.post("/surfaces", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as { surfaces?: string[] };
    if (!Array.isArray(b?.surfaces)) return reply.code(400).send({ error: "surfaces array required" });
    return syncProducedSurfaces(c.orgId, {
      projectId: c.projectId,
      repoId: c.repoId,
      memberId: c.memberId,
      surfaces: b.surfaces,
    });
  });

  // inbox()
  app.get("/inbox", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    return readInbox(c.orgId, { memberId: c.memberId, repoId: c.repoId, projectId: c.projectId });
  });

  // inbox/peek — unread counts without marking as read
  app.get("/inbox/peek", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    return peekInbox(c.orgId, { memberId: c.memberId, repoId: c.repoId, projectId: c.projectId });
  });

  // inbox/peek/me — sessionless peek by principal + git remote (for status line)
  app.get("/inbox/peek/me", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const { remote } = req.query as { remote?: string };
    if (!remote) return reply.code(400).send({ error: "remote query param required" });
    return peekInboxByRemote(p.id, remote);
  });

  // inbox/ack — mark items as read (explicit acknowledgment)
  app.post("/inbox/ack", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as { itemIds?: string[] } | undefined;
    return ackInbox(c.orgId, { memberId: c.memberId, repoId: c.repoId, projectId: c.projectId }, b?.itemIds);
  });

  // query(question, scope?) — scope is a rank boost, not a filter
  app.post("/query", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as { question?: string; scope?: string };
    if (!b?.question) return reply.code(400).send({ error: "question required" });
    return queryLedger(c.orgId, c.projectId, b.question, { scope: b.scope });
  });

  // whoowns(path)
  app.get("/owners", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { path } = req.query as { path?: string };
    if (!path) return reply.code(400).send({ error: "path required" });
    return { owners: await whoowns(c.orgId, c.repoId, path) };
  });

  // ask(question, scope?, urgent?)
  app.post("/questions", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as { question?: string; scope?: string; urgent?: boolean };
    if (!b?.question) return reply.code(400).send({ error: "question required" });
    return askQuestion(c.orgId, {
      projectId: c.projectId,
      memberId: c.memberId,
      body: b.question,
      scopeRef: b.scope,
      urgent: b.urgent,
    });
  });

  // answer(question_id, response)
  app.post("/questions/:id/answer", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { id } = req.params as { id: string };
    const b = req.body as { response?: string };
    if (!b?.response) return reply.code(400).send({ error: "response required" });
    return answerQuestion(c.orgId, id, c.memberId, b.response);
  });

  // delegate(to, task, refs)
  app.post("/tasks", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as { to?: string; task?: string; refs?: unknown };
    if (!b?.task) return reply.code(400).send({ error: "task required" });
    return createTask(c.orgId, { projectId: c.projectId, memberId: c.memberId, title: b.task, to: b.to, refs: b.refs });
  });

  // complete(task_id, note)
  app.post("/tasks/:id/complete", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { id } = req.params as { id: string };
    return completeTask(c.orgId, id, c.memberId);
  });

  // Tier-2 reconcile (PR check) — verify changed contract surfaces against the ledger
  app.post("/reconcile", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as { contractSurfaces?: string[] };
    if (!Array.isArray(b?.contractSurfaces)) return reply.code(400).send({ error: "contractSurfaces[] required" });
    return reconcile(c.orgId, c.projectId, b.contractSurfaces);
  });

  // ingest CODEOWNERS (onboarding/dev; in prod the core fetches it via the GitHub App)
  app.post("/codeowners/refresh", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as { content?: string; sha?: string };
    if (!b?.content) return reply.code(400).send({ error: "content required" });
    return refreshOwnership(c.orgId, c.repoId, b.content, b.sha ?? "manual");
  });
}
