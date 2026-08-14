import { and, eq, inArray } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import {
  inboxes,
  inboxItems,
  changeFeedEntries,
  questions,
  tasks,
  decisions,
  decisionVersions,
  conflicts,
  repos,
  members,
  projects,
} from "../db/schema.js";
import { withSystem } from "../db/rls.js";
import { projectVisibility, getProjectRoleTx } from "../auth/permissions.js";

/**
 * Defense-in-depth for walled projects (gateway): even if an inbox item was delivered before the
 * member lost access (or by a pre-tiering fan-out), a non-member of a walled project reads empty.
 */
async function walledAndNotMemberTx(tx: Tx, projectId: string, memberId: string): Promise<boolean> {
  const project = (await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (projectVisibility(project?.settings) !== "walled") return false;
  return (await getProjectRoleTx(tx, projectId, memberId)) === null;
}

export interface InboxView {
  unread: number;
  changes: Array<{ id: string; summary: string; surface: string | null; riskTier: string; impact: number }>;
  questions: Array<{ id: string; body: string; scopeRef: string | null; urgent: boolean; status: string }>;
  tasks: Array<{ id: string; title: string; runState: string; status: string }>;
  decisions: Array<{ id: string; scopeRef: string; ruleText: string; status: string; impact: number }>;
  // v3 drift: the eng author's own decisions now in tension with a ratified product constraint.
  conflicts: Array<{ id: string; surface: string; constraintRuleText: string; engRuleText: string }>;
}

/** Current-version rule text for a decision id (best-effort). */
async function ruleTextTx(tx: Tx, id: string): Promise<string> {
  const d = (await tx.select().from(decisions).where(eq(decisions.id, id)).limit(1))[0];
  if (!d) return "";
  const v = (
    await tx.select().from(decisionVersions).where(and(eq(decisionVersions.decisionId, id), eq(decisionVersions.version, d.currentVersion))).limit(1)
  )[0];
  return v?.ruleText ?? "";
}

/**
 * Read a session's inbox — return unread items WITHOUT marking them as read.
 * Items stay unread until explicitly acknowledged via ackInbox.
 */
export async function readInbox(
  orgId: string,
  ctx: { memberId: string; repoId: string; projectId: string },
): Promise<InboxView> {
  return withOrg(orgId, async (tx) => {
    if (await walledAndNotMemberTx(tx, ctx.projectId, ctx.memberId))
      return { unread: 0, changes: [], questions: [], tasks: [], decisions: [], conflicts: [] };
    const inbox = (
      await tx
        .select()
        .from(inboxes)
        .where(
          and(eq(inboxes.memberId, ctx.memberId), eq(inboxes.repoId, ctx.repoId), eq(inboxes.projectId, ctx.projectId)),
        )
        .limit(1)
    )[0];
    if (!inbox) return { unread: 0, changes: [], questions: [], tasks: [], decisions: [], conflicts: [] };

    const items = await tx
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.inboxId, inbox.id), eq(inboxItems.state, "unread")));

    const changeIds = items.filter((i) => i.kind === "change").map((i) => i.refId);
    const questionIds = items.filter((i) => i.kind === "question").map((i) => i.refId);
    const taskIds = items.filter((i) => i.kind === "task").map((i) => i.refId);
    const decisionIds = items.filter((i) => i.kind === "decision").map((i) => i.refId);
    const conflictIds = items.filter((i) => i.kind === "conflict").map((i) => i.refId);

    const changeRows = changeIds.length
      ? await tx.select().from(changeFeedEntries).where(inArray(changeFeedEntries.id, changeIds))
      : [];

    const questionRows = questionIds.length
      ? await tx.select().from(questions).where(inArray(questions.id, questionIds))
      : [];

    const taskRows = taskIds.length ? await tx.select().from(tasks).where(inArray(tasks.id, taskIds)) : [];

    const decisionRows: Array<{ id: string; scopeRef: string; ruleText: string; status: string; impact: number }> = [];
    if (decisionIds.length) {
      const ds = await tx.select().from(decisions).where(inArray(decisions.id, decisionIds));
      for (const d of ds) {
        const v = (
          await tx
            .select()
            .from(decisionVersions)
            .where(and(eq(decisionVersions.decisionId, d.id), eq(decisionVersions.version, d.currentVersion)))
            .limit(1)
        )[0];
        decisionRows.push({ id: d.id, scopeRef: d.scopeRef, ruleText: v?.ruleText ?? "", status: d.status, impact: d.impact });
      }
    }

    const conflictRows: Array<{ id: string; surface: string; constraintRuleText: string; engRuleText: string }> = [];
    if (conflictIds.length) {
      const cs = await tx.select().from(conflicts).where(inArray(conflicts.id, conflictIds));
      for (const c of cs) {
        if (c.status !== "open") continue; // only surface still-open drift
        conflictRows.push({
          id: c.id,
          surface: c.surface,
          constraintRuleText: await ruleTextTx(tx, c.constraintDecisionId),
          engRuleText: c.engDecisionId ? await ruleTextTx(tx, c.engDecisionId) : "",
        });
      }
    }

    return {
      unread: items.length,
      changes: changeRows.map((c) => ({
        id: c.id,
        summary: c.summary,
        surface: c.surface,
        riskTier: c.riskTier,
        impact: c.impact,
      })),
      questions: questionRows.map((q) => ({
        id: q.id,
        body: q.body,
        scopeRef: q.scopeRef,
        urgent: q.urgent,
        status: q.status,
      })),
      tasks: taskRows.map((t) => ({ id: t.id, title: t.title, runState: t.runState, status: t.status })),
      decisions: decisionRows,
      conflicts: conflictRows,
    };
  });
}

/**
 * Acknowledge inbox items — mark them as read. Call this after the user has seen the messages.
 * If itemIds is empty, marks ALL unread items of the CURRENT repo's inbox as read.
 *
 * Member-wide ack (IMPROVEMENTS #5): fan-out replicates a ping into one inbox per (member, repo),
 * so the same question used to nag from every folder's session until each cleared it separately.
 * Acking a refId now clears it across ALL of this member's inboxes in the project. The ack-all
 * form first reads the CURRENT repo's unread refIds — it only clears member-wide what this session
 * actually saw, so an item delivered exclusively to another repo's inbox (e.g. a change event for
 * that consumer repo) is never blind-cleared. Returns the total rows updated across inboxes.
 */
export async function ackInbox(
  orgId: string,
  ctx: { memberId: string; repoId: string; projectId: string },
  itemIds?: string[],
): Promise<{ acknowledged: number }> {
  return withOrg(orgId, async (tx) => {
    const memberInboxes = await tx
      .select()
      .from(inboxes)
      .where(and(eq(inboxes.memberId, ctx.memberId), eq(inboxes.projectId, ctx.projectId)));
    const current = memberInboxes.find((i) => i.repoId === ctx.repoId);
    if (!current) return { acknowledged: 0 };
    const allInboxIds = memberInboxes.map((i) => i.id);

    let refIds = itemIds ?? [];
    if (refIds.length === 0) {
      // Ack-all: the refIds this session's inbox actually holds unread.
      const unread = await tx
        .select({ refId: inboxItems.refId })
        .from(inboxItems)
        .where(and(eq(inboxItems.inboxId, current.id), eq(inboxItems.state, "unread")));
      refIds = [...new Set(unread.map((r) => r.refId))];
      if (refIds.length === 0) return { acknowledged: 0 };
    }

    const result = await tx
      .update(inboxItems)
      .set({ state: "read" })
      .where(
        and(inArray(inboxItems.inboxId, allInboxIds), eq(inboxItems.state, "unread"), inArray(inboxItems.refId, refIds)),
      )
      .returning();
    return { acknowledged: result.length };
  });
}

export interface InboxPeek {
  unread: number;
  questions: number;
  tasks: number;
  changes: number;
  decisions: number;
  conflicts: number;
}

/**
 * Peek at a session's inbox — return unread counts without marking anything as read.
 * Used for mid-session "you have N new messages" notifications.
 */
export async function peekInbox(
  orgId: string,
  ctx: { memberId: string; repoId: string; projectId: string },
): Promise<InboxPeek> {
  return withOrg(orgId, async (tx) => {
    if (await walledAndNotMemberTx(tx, ctx.projectId, ctx.memberId))
      return { unread: 0, questions: 0, tasks: 0, changes: 0, decisions: 0, conflicts: 0 };
    const inbox = (
      await tx
        .select()
        .from(inboxes)
        .where(
          and(eq(inboxes.memberId, ctx.memberId), eq(inboxes.repoId, ctx.repoId), eq(inboxes.projectId, ctx.projectId)),
        )
        .limit(1)
    )[0];
    if (!inbox) return { unread: 0, questions: 0, tasks: 0, changes: 0, decisions: 0, conflicts: 0 };

    const items = await tx
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.inboxId, inbox.id), eq(inboxItems.state, "unread")));

    return {
      unread: items.length,
      questions: items.filter((i) => i.kind === "question").length,
      tasks: items.filter((i) => i.kind === "task").length,
      changes: items.filter((i) => i.kind === "change").length,
      decisions: items.filter((i) => i.kind === "decision").length,
      conflicts: items.filter((i) => i.kind === "conflict").length,
    };
  });
}

/**
 * Peek inbox by principal + git remote — no session needed.
 * Resolves remote → repo → project → member → inbox, then returns unread counts.
 * Used by the status line which doesn't have a session ID.
 */
export async function peekInboxByRemote(
  principalId: string,
  gitRemote: string,
): Promise<InboxPeek> {
  return withSystem(async (tx) => {
    const repo = (await tx.select().from(repos).where(eq(repos.gitRemote, gitRemote)).limit(1))[0];
    if (!repo) return { unread: 0, questions: 0, tasks: 0, changes: 0, decisions: 0, conflicts: 0 };

    const member = (
      await tx
        .select()
        .from(members)
        .where(and(eq(members.orgId, repo.orgId), eq(members.principalId, principalId)))
        .limit(1)
    )[0];
    if (!member) return { unread: 0, questions: 0, tasks: 0, changes: 0, decisions: 0, conflicts: 0 };
    if (await walledAndNotMemberTx(tx, repo.projectId, member.id))
      return { unread: 0, questions: 0, tasks: 0, changes: 0, decisions: 0, conflicts: 0 };

    const inbox = (
      await tx
        .select()
        .from(inboxes)
        .where(
          and(eq(inboxes.memberId, member.id), eq(inboxes.repoId, repo.id), eq(inboxes.projectId, repo.projectId)),
        )
        .limit(1)
    )[0];
    if (!inbox) return { unread: 0, questions: 0, tasks: 0, changes: 0, decisions: 0, conflicts: 0 };

    const items = await tx
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.inboxId, inbox.id), eq(inboxItems.state, "unread")));

    return {
      unread: items.length,
      questions: items.filter((i) => i.kind === "question").length,
      tasks: items.filter((i) => i.kind === "task").length,
      changes: items.filter((i) => i.kind === "change").length,
      decisions: items.filter((i) => i.kind === "decision").length,
      conflicts: items.filter((i) => i.kind === "conflict").length,
    };
  });
}
