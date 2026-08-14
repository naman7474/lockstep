import type { FastifyInstance } from "fastify";
import { workerAuthed, ensureMember, ensureProjectVisible, canReadProject, requireProjectRole } from "../guards.js";
import {
  listWork,
  setWatermark,
  finalizeConnection,
  createConnection,
  listConnections,
  initiateConnection,
  checkConnection,
  listConnectionSources,
  addAllowlist,
  listAllowlist,
} from "../../ingest/ingest-service.js";
import {
  fileProposedDecision,
  confirmDecision,
  rejectDecision,
  setDecisionReview,
  listDecisions,
  listProvenancesForProject,
} from "../../ledger/ledger-service.js";
import { eq } from "drizzle-orm";
import { withOrg } from "../../db/rls.js";
import { projects } from "../../db/schema.js";
import { deriveGraph, listGraph, addNode, addEdge } from "../../graph/graph-service.js";
import { reconcileSlackMembersByEmail } from "../../auth/auth-service.js";
import { claimPendingEvents, completeEvents } from "../../ingest/ingest-events-service.js";

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  /* ─── Worker endpoints (service-token auth) ─── */

  // The worker pulls all sweepable work (active connections + enabled allowlist + watermarks).
  app.get("/ingest/work", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    return { work: await listWork() };
  });

  // The worker files distilled proposed decisions (idempotent per content hash).
  app.post("/ingest/proposed-decisions", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    const b = req.body as {
      items?: Array<{
        orgId: string;
        projectId: string;
        scopeKind: string;
        scopeRef: string;
        ruleText: string;
        decisionType?: string;
        provenance: unknown;
        connectionId: string;
        externalId: string;
        contentHash: string;
        confidence?: number;
        rationale?: string;
        alternatives?: string[];
        reviewAt?: string | null;
      }>;
    };
    const items = b?.items ?? [];
    const results = [];
    for (const it of items) {
      const reviewAt = it.reviewAt ? new Date(it.reviewAt) : null;
      const r = await fileProposedDecision(it.orgId, {
        projectId: it.projectId,
        scopeKind: it.scopeKind,
        scopeRef: it.scopeRef,
        ruleText: it.ruleText,
        decisionType: it.decisionType,
        provenance: it.provenance,
        connectionId: it.connectionId,
        externalId: it.externalId,
        contentHash: it.contentHash,
        confidence: it.confidence,
        rationale: it.rationale,
        alternatives: it.alternatives,
        reviewAt: reviewAt && !Number.isNaN(reviewAt.getTime()) ? reviewAt : null,
      });
      results.push(r);
    }
    return {
      filed: results.filter((r) => !r.deduped && !r.fused).length,
      fused: results.filter((r) => r.fused).length,
      deduped: results.filter((r) => r.deduped).length,
    };
  });

  app.post("/ingest/watermark", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    const b = req.body as { orgId?: string; connectionId?: string; sourceRef?: string; cursor?: string };
    if (!b?.orgId || !b?.connectionId || !b?.sourceRef || b.cursor === undefined) {
      return reply.code(400).send({ error: "orgId, connectionId, sourceRef, cursor required" });
    }
    await setWatermark(b.orgId, b.connectionId, b.sourceRef, b.cursor);
    return { ok: true };
  });

  // Gateway: the worker's fast loop claims Slack-event units (lease + attempts) and acks them.
  app.get("/ingest/events/pending", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    return { batches: await claimPendingEvents() };
  });

  app.post("/ingest/events/done", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    const b = req.body as { ids?: string[]; ok?: boolean };
    if (!Array.isArray(b?.ids) || typeof b?.ok !== "boolean")
      return reply.code(400).send({ error: "ids[] + ok required" });
    return completeEvents(b.ids, b.ok);
  });

  // The worker hands over a Slack workspace's users (id + email from a Composio users-list call) so
  // core can auto-link members.slack_user_id by email — only filling nulls (never clobbering a manual link).
  app.post("/internal/slack/reconcile-members", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    const b = req.body as { orgId?: string; users?: Array<{ slackUserId: string; email: string | null }> };
    if (!b?.orgId || !Array.isArray(b.users)) return reply.code(400).send({ error: "orgId + users[] required" });
    return reconcileSlackMembersByEmail(b.orgId, b.users);
  });

  // The worker marks a connection active once Composio OAuth has completed.
  app.post("/ingest/connections/:id/finalize", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    const { id } = req.params as { id: string };
    const b = req.body as { connectedAccountId?: string };
    if (!b?.connectedAccountId) return reply.code(400).send({ error: "connectedAccountId required" });
    await finalizeConnection(id, b.connectedAccountId);
    return { ok: true };
  });

  /* ─── Admin + review endpoints (principal + org membership) ─── */

  app.post("/orgs/:orgId/projects/:projectId/connections", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    if (!(await requireProjectRole(reply, orgId, projectId, memberId, ["owner", "pm"]))) return;
    const b = req.body as { tool?: string };
    const tool = b?.tool ?? "slack";
    // #10: connections are org-level (entity = org id, set in the service). The project path segment
    // provides the permission context only — any project owner/pm may connect the org's workspace.
    return createConnection(orgId, { tool, createdBy: memberId });
  });

  app.get("/orgs/:orgId/projects/:projectId/connections", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    if (!(await canReadProject(req, reply, orgId, projectId))) return;
    return { connections: await listConnections(orgId) }; // #10: org-wide, whichever project page asks
  });

  // Dashboard-driven OAuth: start the Composio authorize flow server-side (the API key never leaves core).
  app.post("/orgs/:orgId/projects/:projectId/connections/:id/initiate", async (req, reply) => {
    const { orgId, projectId, id } = req.params as { orgId: string; projectId: string; id: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    if (!(await requireProjectRole(reply, orgId, projectId, memberId, ["owner", "pm"]))) return;
    const b = req.body as { callbackUrl?: string };
    if (!b?.callbackUrl) return reply.code(400).send({ error: "callbackUrl required" });
    return initiateConnection(orgId, id, b.callbackUrl);
  });

  // Poll status when the user returns from the authorize page — flips to active once Composio confirms.
  app.get("/orgs/:orgId/projects/:projectId/connections/:id/status", async (req, reply) => {
    const { orgId, projectId, id } = req.params as { orgId: string; projectId: string; id: string };
    if (!(await canReadProject(req, reply, orgId, projectId))) return;
    return checkConnection(orgId, id);
  });

  // Connectable sources (Slack channels / Notion databases) for the dashboard picker.
  app.get("/orgs/:orgId/projects/:projectId/connections/:id/sources", async (req, reply) => {
    const { orgId, projectId, id } = req.params as { orgId: string; projectId: string; id: string };
    if (!(await canReadProject(req, reply, orgId, projectId))) return;
    return { sources: await listConnectionSources(orgId, id) };
  });

  app.post("/orgs/:orgId/projects/:projectId/allowlist", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    if (!(await requireProjectRole(reply, orgId, projectId, memberId, ["owner", "pm"]))) return;
    const b = req.body as { connectionId?: string; sourceKind?: string; sourceRef?: string; sourceName?: string };
    if (!b?.connectionId || !b?.sourceRef) return reply.code(400).send({ error: "connectionId, sourceRef required" });
    return addAllowlist(orgId, {
      projectId,
      connectionId: b.connectionId,
      sourceKind: b.sourceKind ?? "channel",
      sourceRef: b.sourceRef,
      sourceName: b.sourceName,
    });
  });

  app.get("/orgs/:orgId/projects/:projectId/allowlist", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    if (!(await canReadProject(req, reply, orgId, projectId))) return;
    return { allowlist: await listAllowlist(orgId, projectId) };
  });

  // Review queue: proposed (ingested) decisions awaiting human confirmation. Document constraints
  // (origin=document) have their own queue — the Ratifications tab — and are excluded here.
  app.get("/orgs/:orgId/projects/:projectId/proposed", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    if (!(await ensureProjectVisible(reply, orgId, projectId, memberId))) return;
    const decisions = (await listDecisions(orgId, projectId, undefined, { status: "proposed" })).filter(
      (d) => d.origin !== "document",
    );
    const provs = await listProvenancesForProject(orgId, projectId);
    // Phase J staleness (TOMASP timebox): flag proposals older than the project's window. Computed
    // server-side so the web queue and the Slack digest agree on one source of truth.
    const proj = await withOrg(orgId, async (tx) =>
      (await tx.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId)).limit(1))[0],
    );
    const staleDays = (proj?.settings as { staleProposalDays?: number } | null)?.staleProposalDays ?? 7;
    const now = Date.now();
    return {
      decisions: decisions.map((d) => {
        const ageDays = Math.floor((now - new Date(d.proposedAt).getTime()) / 86400000);
        return { ...d, provenances: provs[d.id] ?? [], ageDays, stale: ageDays >= staleDays };
      }),
    };
  });

  app.post("/orgs/:orgId/decisions/:id/confirm", async (req, reply) => {
    const { orgId, id } = req.params as { orgId: string; id: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    const b = req.body as
      | {
          ruleText?: string;
          scopeKind?: string;
          scopeRef?: string;
          rationale?: string;
          alternatives?: string[];
          reviewAt?: string | null;
        }
      | undefined;
    let reviewAt: Date | null | undefined;
    if (b?.reviewAt !== undefined) {
      reviewAt = b.reviewAt === null || b.reviewAt === "" ? null : new Date(b.reviewAt);
      if (reviewAt && Number.isNaN(reviewAt.getTime()))
        return reply.code(400).send({ error: "reviewAt must be an ISO date or null" });
    }
    return confirmDecision(orgId, id, memberId, b ? { ...b, reviewAt } : undefined);
  });

  // Phase J review tripwire: set (or snooze) / clear a binding decision's reviewAt. "Due" itself is
  // computed at query time — this is the only mutation, and it's human-attributed in the audit log.
  app.post("/orgs/:orgId/decisions/:id/review", async (req, reply) => {
    const { orgId, id } = req.params as { orgId: string; id: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    const b = req.body as { reviewAt?: string | null } | undefined;
    if (b?.reviewAt === undefined) return reply.code(400).send({ error: "reviewAt required (ISO date or null)" });
    const reviewAt = b.reviewAt === null || b.reviewAt === "" ? null : new Date(b.reviewAt);
    if (reviewAt && Number.isNaN(reviewAt.getTime()))
      return reply.code(400).send({ error: "reviewAt must be an ISO date or null" });
    return setDecisionReview(orgId, id, memberId, reviewAt);
  });

  // Human decision search: "what did we decide about X?" over the ledger, with filters.
  app.get("/orgs/:orgId/projects/:projectId/decisions/search", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    if (!(await ensureProjectVisible(reply, orgId, projectId, memberId))) return;
    const { q, status, origin, from, to } = req.query as {
      q?: string;
      status?: string;
      origin?: string;
      from?: string;
      to?: string;
    };
    let list = await listDecisions(orgId, projectId, undefined, { status, origin });
    if (q && q.trim()) {
      const needle = q.toLowerCase();
      list = list.filter((d) => {
        const prov = JSON.stringify(d.provenance ?? "").toLowerCase();
        return `${d.ruleText} ${d.scopeRef}`.toLowerCase().includes(needle) || prov.includes(needle);
      });
    }
    if (from) list = list.filter((d) => new Date(d.createdAt).getTime() >= new Date(from).getTime());
    if (to) list = list.filter((d) => new Date(d.createdAt).getTime() <= new Date(to).getTime());
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { decisions: list };
  });

  app.post("/orgs/:orgId/decisions/:id/reject", async (req, reply) => {
    const { orgId, id } = req.params as { orgId: string; id: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    return rejectDecision(orgId, id, memberId);
  });

  /* ─── Org graph ─── */

  app.get("/orgs/:orgId/projects/:projectId/graph", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    if (!(await ensureProjectVisible(reply, orgId, projectId, memberId))) return;
    return listGraph(orgId, projectId);
  });

  app.post("/orgs/:orgId/projects/:projectId/graph/derive", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    if (!(await requireProjectRole(reply, orgId, projectId, memberId, ["owner", "pm"]))) return;
    return deriveGraph(orgId, projectId);
  });

  app.post("/orgs/:orgId/projects/:projectId/graph/nodes", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    if (!(await requireProjectRole(reply, orgId, projectId, memberId, ["owner", "pm"]))) return;
    const b = req.body as { kind?: string; ref?: string; label?: string };
    if (!b?.kind || !b?.ref) return reply.code(400).send({ error: "kind, ref required" });
    return addNode(orgId, { projectId, kind: b.kind, ref: b.ref, label: b.label });
  });

  app.post("/orgs/:orgId/projects/:projectId/graph/edges", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    if (!(await requireProjectRole(reply, orgId, projectId, memberId, ["owner", "pm"]))) return;
    const b = req.body as { fromId?: string; toId?: string; kind?: string };
    if (!b?.fromId || !b?.toId) return reply.code(400).send({ error: "fromId, toId required" });
    return addEdge(orgId, { projectId, fromId: b.fromId, toId: b.toId, kind: b.kind });
  });
}
