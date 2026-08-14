import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { withOrg } from "../../db/rls.js";
import { projectMembers, projects } from "../../db/schema.js";
import { writeAudit } from "../../audit/audit-service.js";
import { workerAuthed, ensureMember, requireProductLayer, ensureProjectVisible, canReadProject, requireProjectRole } from "../guards.js";
import { getProjectRoleTx } from "../../auth/permissions.js";
import { setMemberSlackId } from "../../auth/auth-service.js";
import { claimDueJobs, completeJob } from "../../ledger/jobs-service.js";
import {
  registerDocument,
  listDocuments,
  getDocument,
  setDocumentState,
  requestResync,
  unregisterDocument,
  getDocumentWork,
  upsertDocumentsFromSweep,
  fileDocCandidates,
  pendingWritebacks,
  markWritebackDone,
  listStateMappings,
  setStateMapping,
  setStatusProperty,
  listRatifications,
  projectCounts,
  type SweptDoc,
  type DocCandidateItem,
} from "../../documents/document-service.js";
import { listConflicts, dismissConflict, resolveConflict } from "../../documents/reconcile-service.js";
import { listFeatures, getFeature, confirmGovernsEdge, rejectGovernsEdge } from "../../documents/features-service.js";
import { ratifyDecision } from "../../ledger/ledger-service.js";
import { expireConstraints } from "../../ledger/expiry-job.js";
import { enqueueWeeklyDigests } from "../../documents/weekly-digest.js";

/** v3 product layer: documents, state mappings, ratifications, conflicts, write-backs. */
export async function documentRoutes(app: FastifyInstance): Promise<void> {
  /* ─── Worker endpoints (service-token auth) ─── */

  app.get("/internal/documents/work", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    return { work: await getDocumentWork() };
  });

  // Expiry sweep (FR-CORE-11): flip past-due launch gates binding → expired. Called on the worker tick.
  app.post("/internal/expiry/run", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    return expireConstraints();
  });

  // Weekly operator digest: enqueue per-project Slack summaries (idempotent per ISO week).
  app.post("/internal/digests/weekly/run", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    return enqueueWeeklyDigests();
  });

  // Gateway scheduler: the worker's fast loop claims due jobs (lease + SKIP LOCKED) and executes
  // each kind via the existing /internal endpoints above, then completes (reschedules) here.
  app.post("/internal/jobs/claim", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    return { jobs: await claimDueJobs() };
  });

  app.post("/internal/jobs/:id/complete", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    const { id } = req.params as { id: string };
    const b = req.body as { ok?: boolean; error?: string };
    if (typeof b?.ok !== "boolean") return reply.code(400).send({ error: "ok required" });
    return completeJob(id, b.ok, b.error);
  });

  app.post("/internal/documents/upsert", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    const b = req.body as { connectionId?: string; docs?: SweptDoc[] };
    if (!b?.connectionId || !Array.isArray(b?.docs)) {
      return reply.code(400).send({ error: "connectionId, docs[] required" });
    }
    return { results: await upsertDocumentsFromSweep(b.connectionId, b.docs) };
  });

  app.post("/internal/documents/:id/candidates", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    const { id } = req.params as { id: string };
    const b = req.body as {
      items?: DocCandidateItem[];
      docContentHash?: string;
      extractedAnchorKeys?: string[];
      currentSections?: Array<{ anchorKey: string; headingPath: string[]; snippet: string }>;
    };
    if (!Array.isArray(b?.items)) return reply.code(400).send({ error: "items[] required" });
    return fileDocCandidates(id, b.items, b.docContentHash, b.extractedAnchorKeys, b.currentSections);
  });

  app.get("/internal/writebacks/pending", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    return { writebacks: await pendingWritebacks() };
  });

  app.post("/internal/writebacks/:id/done", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    const { id } = req.params as { id: string };
    const b = req.body as { ok?: boolean; resultRef?: string };
    await markWritebackDone(id, Boolean(b?.ok), b?.resultRef);
    return { ok: true };
  });

  /* ─── Documents (member-facing, product-layer gated) ─── */

  app.get("/orgs/:orgId/projects/:projectId/documents", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    if (!(await canReadProject(req, reply, orgId, projectId))) return;
    if (!(await requireProductLayer(reply, orgId, projectId))) return;
    return listDocuments(orgId, projectId);
  });

  app.post("/orgs/:orgId/projects/:projectId/documents", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    if (!(await ensureProjectVisible(reply, orgId, projectId, memberId))) return;
    if (!(await requireProductLayer(reply, orgId, projectId))) return;
    const b = req.body as { url?: string };
    if (!b?.url) return reply.code(400).send({ error: "url required" });
    return registerDocument(orgId, { projectId, memberId, url: b.url });
  });

  app.get("/orgs/:orgId/projects/:projectId/documents/:docId", async (req, reply) => {
    const { orgId, projectId, docId } = req.params as { orgId: string; projectId: string; docId: string };
    if (!(await canReadProject(req, reply, orgId, projectId))) return;
    if (!(await requireProductLayer(reply, orgId, projectId))) return;
    return getDocument(orgId, docId);
  });

  app.post("/orgs/:orgId/projects/:projectId/documents/:docId/state", async (req, reply) => {
    const { orgId, docId } = req.params as { orgId: string; projectId: string; docId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    const b = req.body as { state?: string };
    if (!b?.state) return reply.code(400).send({ error: "state required" });
    return setDocumentState(orgId, docId, memberId, b.state);
  });

  app.post("/orgs/:orgId/projects/:projectId/documents/:docId/resync", async (req, reply) => {
    const { orgId, docId } = req.params as { orgId: string; projectId: string; docId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    return requestResync(orgId, docId, memberId);
  });

  app.delete("/orgs/:orgId/projects/:projectId/documents/:docId", async (req, reply) => {
    const { orgId, docId } = req.params as { orgId: string; projectId: string; docId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    return unregisterDocument(orgId, docId, memberId);
  });

  /* ─── Ratifications queue ─── */

  app.get("/orgs/:orgId/projects/:projectId/ratifications", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    if (!(await ensureProjectVisible(reply, orgId, projectId, memberId))) return;
    if (!(await requireProductLayer(reply, orgId, projectId))) return;
    return listRatifications(orgId, projectId, memberId);
  });

  app.post("/orgs/:orgId/decisions/:id/ratify", async (req, reply) => {
    const { orgId, id } = req.params as { orgId: string; id: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    const b = req.body as { ruleText?: string } | undefined;
    return ratifyDecision(orgId, id, memberId, b);
  });

  /* ─── State mappings (admin) ─── */

  app.get("/orgs/:orgId/projects/:projectId/connections/:connectionId/state-mappings", async (req, reply) => {
    const { orgId, projectId, connectionId } = req.params as { orgId: string; projectId: string; connectionId: string };
    if (!(await canReadProject(req, reply, orgId, projectId))) return;
    return listStateMappings(orgId, projectId, connectionId);
  });

  app.post("/orgs/:orgId/projects/:projectId/connections/:connectionId/state-mappings", async (req, reply) => {
    const { orgId, projectId, connectionId } = req.params as { orgId: string; projectId: string; connectionId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    if (!(await requireProjectRole(reply, orgId, projectId, memberId, ["owner", "pm"]))) return;
    const b = req.body as { containerRef?: string; sourceValue?: string; canonicalState?: string };
    if (!b?.containerRef || !b?.sourceValue || !b?.canonicalState) {
      return reply.code(400).send({ error: "containerRef, sourceValue, canonicalState required" });
    }
    return setStateMapping(orgId, {
      projectId,
      connectionId,
      containerRef: b.containerRef,
      sourceValue: b.sourceValue,
      canonicalState: b.canonicalState,
      memberId,
    });
  });

  app.post("/orgs/:orgId/projects/:projectId/connections/:connectionId/state-mappings/property", async (req, reply) => {
    const { orgId, projectId, connectionId } = req.params as { orgId: string; projectId: string; connectionId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    if (!(await requireProjectRole(reply, orgId, projectId, memberId, ["owner", "pm"]))) return;
    const b = req.body as { containerRef?: string; statusProperty?: string };
    if (!b?.containerRef || !b?.statusProperty) {
      return reply.code(400).send({ error: "containerRef, statusProperty required" });
    }
    return setStatusProperty(orgId, {
      projectId,
      connectionId,
      containerRef: b.containerRef,
      statusProperty: b.statusProperty,
      memberId,
    });
  });

  /* ─── Features (reconciliation) ─── */

  app.get("/orgs/:orgId/projects/:projectId/features", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    if (!(await canReadProject(req, reply, orgId, projectId))) return;
    if (!(await requireProductLayer(reply, orgId, projectId))) return;
    return listFeatures(orgId, projectId);
  });

  app.get("/orgs/:orgId/projects/:projectId/features/:ref", async (req, reply) => {
    const { orgId, projectId, ref } = req.params as { orgId: string; projectId: string; ref: string };
    if (!(await canReadProject(req, reply, orgId, projectId))) return;
    if (!(await requireProductLayer(reply, orgId, projectId))) return;
    const feature = await getFeature(orgId, projectId, decodeURIComponent(ref));
    if (!feature) return reply.code(404).send({ error: "feature not found" });
    return feature;
  });

  app.post("/orgs/:orgId/projects/:projectId/graph/edges/:id/confirm", async (req, reply) => {
    const { orgId, projectId, id } = req.params as { orgId: string; projectId: string; id: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    return confirmGovernsEdge(orgId, projectId, id, memberId);
  });

  app.post("/orgs/:orgId/projects/:projectId/graph/edges/:id/reject", async (req, reply) => {
    const { orgId, projectId, id } = req.params as { orgId: string; projectId: string; id: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    return rejectGovernsEdge(orgId, projectId, id, memberId);
  });

  /* ─── Conflicts ─── */

  app.get("/orgs/:orgId/projects/:projectId/conflicts", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    if (!(await canReadProject(req, reply, orgId, projectId))) return;
    const { status } = req.query as { status?: string };
    return { conflicts: await listConflicts(orgId, projectId, status) };
  });

  // Resolve an open drift/pre-approval conflict: holds (constraint wins) | dismiss (false positive).
  app.post("/orgs/:orgId/conflicts/:id/resolve", async (req, reply) => {
    const { orgId, id } = req.params as { orgId: string; id: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    const b = req.body as { resolution?: string; reason?: string };
    if (b?.resolution !== "holds" && b?.resolution !== "dismiss") {
      return reply.code(400).send({ error: "resolution must be holds | dismiss" });
    }
    return resolveConflict(orgId, id, memberId, { resolution: b.resolution, reason: b.reason });
  });

  // Back-compat alias for the Phase A dismiss route.
  app.post("/orgs/:orgId/conflicts/:id/dismiss", async (req, reply) => {
    const { orgId, id } = req.params as { orgId: string; id: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    const b = req.body as { reason?: string } | undefined;
    return dismissConflict(orgId, id, memberId, b?.reason);
  });

  /* ─── Counts, roles, settings ─── */

  app.get("/orgs/:orgId/projects/:projectId/counts", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    if (!(await canReadProject(req, reply, orgId, projectId))) return;
    return projectCounts(orgId, projectId);
  });

  app.post("/orgs/:orgId/projects/:projectId/members/:projectMemberId/role", async (req, reply) => {
    const { orgId, projectId, projectMemberId } = req.params as {
      orgId: string;
      projectId: string;
      projectMemberId: string;
    };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    const b = req.body as { role?: string };
    if (!b?.role || !["owner", "pm", "member"].includes(b.role)) {
      return reply.code(400).send({ error: "role must be owner | pm | member" });
    }
    return withOrg(orgId, async (tx) => {
      if ((await getProjectRoleTx(tx, projectId, memberId)) !== "owner") {
        return reply.code(403).send({ error: "only owners can change roles" });
      }
      const pm = (
        await tx
          .select()
          .from(projectMembers)
          .where(and(eq(projectMembers.id, projectMemberId), eq(projectMembers.projectId, projectId)))
          .limit(1)
      )[0];
      if (!pm) return reply.code(404).send({ error: "project member not found" });
      await tx.update(projectMembers).set({ role: b.role! }).where(eq(projectMembers.id, projectMemberId));
      await writeAudit(tx, {
        orgId,
        projectId,
        actorMemberId: memberId,
        action: "member.role_changed",
        entityKind: "project_member",
        entityId: projectMemberId,
        payload: { role: b.role },
      });
      return { ok: true };
    });
  });

  // Owner-only per-project feature flags (merge patch), e.g. {"productLayer":{"enabled":true}}.
  app.post("/orgs/:orgId/projects/:projectId/settings", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    const patch = req.body as Record<string, unknown>;
    if (!patch || typeof patch !== "object") return reply.code(400).send({ error: "settings object required" });
    return withOrg(orgId, async (tx) => {
      if ((await getProjectRoleTx(tx, projectId, memberId)) !== "owner") {
        return reply.code(403).send({ error: "only owners can change settings" });
      }
      const p = (await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
      if (!p) return reply.code(404).send({ error: "project not found" });
      const settings = { ...((p.settings ?? {}) as Record<string, unknown>), ...patch };
      await tx.update(projects).set({ settings }).where(eq(projects.id, projectId));
      await writeAudit(tx, {
        orgId,
        projectId,
        actorMemberId: memberId,
        action: "project.settings_updated",
        entityKind: "project",
        entityId: projectId,
        payload: patch,
      });
      return { ok: true, settings };
    });
  });

  // Link (or clear) a member's Slack user id — the manual path that lights up the whole Slack loop
  // (digests/alerts/buttons all resolve through members.slack_user_id). Owners/PMs link anyone; a
  // member may link themselves. :memberId is the org member id (members.id).
  app.post("/orgs/:orgId/projects/:projectId/members/:memberId/slack", async (req, reply) => {
    const { orgId, projectId, memberId } = req.params as { orgId: string; projectId: string; memberId: string };
    const actorId = await ensureMember(req, reply, orgId);
    if (!actorId) return;
    const b = req.body as { slackUserId?: string | null };
    const slackUserId = b?.slackUserId ? String(b.slackUserId).trim() : null;
    const role = await withOrg(orgId, (tx) => getProjectRoleTx(tx, projectId, actorId));
    if (actorId !== memberId && role !== "owner" && role !== "pm") {
      return reply.code(403).send({ error: "only owners/PMs can link another member" });
    }
    await setMemberSlackId(orgId, memberId, slackUserId, actorId);
    return { ok: true };
  });
}
