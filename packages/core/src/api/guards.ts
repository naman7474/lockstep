import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withSystem, withOrg } from "../db/rls.js";
import { members, projects } from "../db/schema.js";
import { productLayerEnabled } from "../documents/document-service.js";
import { getProjectRoleTx, projectVisibility } from "../auth/permissions.js";
import { env } from "../env.js";

/** Gate the worker endpoints on the shared ingest service token (timing-safe compare). */
export function workerAuthed(req: FastifyRequest, reply: FastifyReply): boolean {
  const expected = env.LOCKSTEP_INGEST_TOKEN;
  const got = req.headers["x-lockstep-ingest-token"];
  // sha256 both sides → constant length → timingSafeEqual never throws and leaks nothing.
  const matches =
    Boolean(expected) &&
    typeof got === "string" &&
    timingSafeEqual(createHash("sha256").update(got).digest(), createHash("sha256").update(expected!).digest());
  if (!matches) {
    reply.code(401).send({ error: "ingest token required" });
    return false;
  }
  return true;
}

/** Resolve the caller's member id in an org (principal must be a member), else 401/403. */
export async function ensureMember(req: FastifyRequest, reply: FastifyReply, orgId: string): Promise<string | null> {
  const p = req.principal;
  if (!p) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  const memberId = await withSystem(async (tx) => {
    const m = (
      await tx
        .select()
        .from(members)
        .where(and(eq(members.orgId, orgId), eq(members.principalId, p.id)))
        .limit(1)
    )[0];
    return m?.id ?? null;
  });
  if (!memberId) {
    reply.code(403).send({ error: "not a member of this org" });
    return null;
  }
  return memberId;
}

/** v3 product layer is per-project opt-in (projects.settings.productLayer.enabled), else 403. */
export async function requireProductLayer(reply: FastifyReply, orgId: string, projectId: string): Promise<boolean> {
  const enabled = await withOrg(orgId, async (tx) => {
    const p = (await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
    return p ? productLayerEnabled(p.settings) : false;
  });
  if (!enabled) {
    reply.code(403).send({ error: "feature_disabled" });
    return false;
  }
  return true;
}

/** Boolean product-layer check (no reply) — for endpoints that degrade silently rather than 403. */
export async function productLayerOn(orgId: string, projectId: string): Promise<boolean> {
  return withOrg(orgId, async (tx) => {
    const p = (await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
    return p ? productLayerEnabled(p.settings) : false;
  });
}

/**
 * #2 per-project read gate. A "shared" project (default) is readable by any org member (unchanged
 * behavior); a "walled" project requires an active project_members row. Call AFTER ensureMember,
 * passing the resolved memberId. Returns true when visible, else sends 403 and returns false.
 */
export async function ensureProjectVisible(
  reply: FastifyReply,
  orgId: string,
  projectId: string,
  memberId: string,
): Promise<boolean> {
  const visible = await withOrg(orgId, async (tx) => {
    const p = (await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
    if (!p) return false;
    if (projectVisibility(p.settings) === "shared") return true;
    return (await getProjectRoleTx(tx, projectId, memberId)) !== null;
  });
  if (!visible) {
    reply.code(403).send({ error: "project_forbidden" });
    return false;
  }
  return true;
}

/** ensureMember + ensureProjectVisible for project READ routes that don't need the memberId. */
export async function canReadProject(
  req: FastifyRequest,
  reply: FastifyReply,
  orgId: string,
  projectId: string,
): Promise<boolean> {
  const memberId = await ensureMember(req, reply, orgId);
  if (!memberId) return false;
  return ensureProjectVisible(reply, orgId, projectId, memberId);
}

/**
 * Project WRITE gate: require the caller to hold one of `roles` (owner|pm|member) in the project.
 * getProjectRoleTx returns null for non-project-members, so this also walls writes on walled AND
 * shared projects (there is no shared bypass — a write role is a write role). Call after ensureMember.
 */
export async function requireProjectRole(
  reply: FastifyReply,
  orgId: string,
  projectId: string,
  memberId: string,
  roles: string[],
): Promise<boolean> {
  const ok = await withOrg(orgId, async (tx) => {
    const role = await getProjectRoleTx(tx, projectId, memberId);
    return role !== null && roles.includes(role);
  });
  if (!ok) {
    reply.code(403).send({ error: "insufficient_role" });
    return false;
  }
  return true;
}
