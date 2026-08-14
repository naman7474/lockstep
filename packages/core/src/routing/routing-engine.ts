import { and, eq } from "drizzle-orm";
import { members, dependencyEdges, repos, projects, projectMembers, sessions, inboxes, inboxItems } from "../db/schema.js";
import { projectVisibility, getProjectRoleTx } from "../auth/permissions.js";
import type { Tx } from "../db/rls.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

async function ensureInbox(
  tx: Tx,
  orgId: string,
  memberId: string,
  repoId: string,
  projectId: string,
): Promise<string> {
  const existing = (
    await tx
      .select()
      .from(inboxes)
      .where(and(eq(inboxes.memberId, memberId), eq(inboxes.repoId, repoId), eq(inboxes.projectId, projectId)))
      .limit(1)
  )[0];
  if (existing) return existing.id;
  return one(await tx.insert(inboxes).values({ orgId, memberId, repoId, projectId }).returning()).id;
}

export type RecipientTier = "project-member" | "session-active" | "org-fallback";

/**
 * Tiered recipient resolution (gateway) — replaces the old "every org member" fan-out:
 *  - walled project ⇒ active project_members ONLY, always (the visibility-leak fix; empty is correct).
 *  - shared project ⇒ project_members ∪ members with a session in the project ("involved").
 *  - shared with an EMPTY union ⇒ all org members (today's behavior) — for most existing orgs
 *    project_members holds only the creator, and delivery must never silently stop.
 */
export async function resolveProjectRecipientsTx(
  tx: Tx,
  orgId: string,
  projectId: string,
): Promise<Array<{ memberId: string; tier: RecipientTier }>> {
  const project = (await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  const walled = projectVisibility(project?.settings) === "walled";

  const out = new Map<string, RecipientTier>();
  const pm = await tx
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.status, "active")));
  for (const r of pm) if (r.memberId) out.set(r.memberId, "project-member");
  if (walled) return [...out].map(([memberId, tier]) => ({ memberId, tier }));

  const sess = await tx
    .selectDistinct({ memberId: sessions.memberId })
    .from(sessions)
    .where(eq(sessions.projectId, projectId));
  for (const s of sess) if (!out.has(s.memberId)) out.set(s.memberId, "session-active");

  if (out.size === 0) {
    const orgMembers = await tx.select({ id: members.id }).from(members).where(eq(members.orgId, orgId));
    for (const m of orgMembers) out.set(m.id, "org-fallback");
  }
  return [...out].map(([memberId, tier]) => ({ memberId, tier }));
}

/** Walled projects deliver only to active project members; shared projects never block a target. */
async function deliverableTx(tx: Tx, projectId: string, memberId: string): Promise<boolean> {
  const project = (await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (projectVisibility(project?.settings) !== "walled") return true;
  return (await getProjectRoleTx(tx, projectId, memberId)) !== null;
}

export interface FanoutArgs {
  projectId: string;
  changeId: string;
  surface: string;
  senderRepoId: string;
  senderMemberId: string;
}

/**
 * Fan a published change out to the inboxes of repos that CONSUME the changed surface
 * (dependency graph), excluding the sender. Recipients are resolved per CONSUMER repo's own
 * project (tiered), and the inbox is keyed on the consumer project — a cross-project consumer's
 * members read it from their own project's sessions. Runs in the caller's transaction.
 */
export async function fanoutChangeTx(tx: Tx, orgId: string, args: FanoutArgs): Promise<number> {
  const edges = await tx
    .select()
    .from(dependencyEdges)
    .where(and(eq(dependencyEdges.producedSurface, args.surface), eq(dependencyEdges.active, true)));
  const consumerRepoIds = [...new Set(edges.map((e) => e.consumerRepoId))].filter((r) => r !== args.senderRepoId);
  if (consumerRepoIds.length === 0) return 0;

  const recipientsByProject = new Map<string, Array<{ memberId: string; tier: RecipientTier }>>();
  let delivered = 0;
  for (const repoId of consumerRepoIds) {
    const repo = (await tx.select().from(repos).where(eq(repos.id, repoId)).limit(1))[0];
    if (!repo) continue;
    let recipients = recipientsByProject.get(repo.projectId);
    if (!recipients) {
      recipients = await resolveProjectRecipientsTx(tx, orgId, repo.projectId);
      recipientsByProject.set(repo.projectId, recipients);
    }
    for (const r of recipients) {
      if (r.memberId === args.senderMemberId) continue;
      const inboxId = await ensureInbox(tx, orgId, r.memberId, repoId, repo.projectId);
      await tx
        .insert(inboxItems)
        .values({
          orgId,
          inboxId,
          kind: "change",
          refId: args.changeId,
          reason: { surface: args.surface, consumerRepoId: repoId, tier: r.tier },
        })
        .onConflictDoNothing();
      delivered++;
    }
  }
  return delivered;
}

export interface ProjectFanoutArgs {
  projectId: string;
  refId: string;
  kind: "question" | "task" | "decision";
  senderMemberId: string;
  reason?: unknown;
  /** For tasks: deliver only to this member (if set). */
  targetMemberId?: string | null;
}

/**
 * Fan a question/task/decision out to the project's tiered recipients (excluding the sender).
 * Each recipient gets one item per repo in the project. A targeted delivery (delegated task)
 * bypasses the tiers on shared projects but still requires membership on walled ones.
 */
export async function fanoutToProjectTx(tx: Tx, orgId: string, args: ProjectFanoutArgs): Promise<number> {
  const projectRepos = await tx.select().from(repos).where(eq(repos.projectId, args.projectId));
  if (projectRepos.length === 0) return 0;

  let targets: Array<{ memberId: string; tier: RecipientTier | "targeted" }>;
  if (args.targetMemberId) {
    targets = (await deliverableTx(tx, args.projectId, args.targetMemberId))
      ? [{ memberId: args.targetMemberId, tier: "targeted" }]
      : [];
  } else {
    targets = (await resolveProjectRecipientsTx(tx, orgId, args.projectId)).filter(
      (r) => r.memberId !== args.senderMemberId,
    );
  }

  let delivered = 0;
  for (const t of targets) {
    for (const repo of projectRepos) {
      const inboxId = await ensureInbox(tx, orgId, t.memberId, repo.id, args.projectId);
      const baseReason = (args.reason ?? {}) as Record<string, unknown>;
      await tx
        .insert(inboxItems)
        .values({
          orgId,
          inboxId,
          kind: args.kind,
          refId: args.refId,
          reason: { ...baseReason, tier: t.tier },
        })
        .onConflictDoNothing();
      delivered++;
    }
  }
  return delivered;
}

/**
 * Deliver a `conflict` inbox item to one member (the eng decision's author) across every repo they're
 * in for the project — "your decision is now in tension with a ratified product constraint" (v3 drift).
 */
export async function notifyConflictTx(
  tx: Tx,
  orgId: string,
  args: { projectId: string; memberId: string; conflictId: string },
): Promise<void> {
  if (!args.memberId) return;
  if (!(await deliverableTx(tx, args.projectId, args.memberId))) return;
  const projectRepos = await tx.select().from(repos).where(eq(repos.projectId, args.projectId));
  for (const repo of projectRepos) {
    const inboxId = await ensureInbox(tx, orgId, args.memberId, repo.id, args.projectId);
    await tx
      .insert(inboxItems)
      .values({ orgId, inboxId, kind: "conflict", refId: args.conflictId, reason: null })
      .onConflictDoNothing();
  }
}
