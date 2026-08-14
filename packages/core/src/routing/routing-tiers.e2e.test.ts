/**
 * Tiered routing (gateway) against real Postgres. The contract:
 *  - walled ⇒ active project_members ONLY (the visibility-leak fix), incl. targeted deliveries;
 *  - shared ⇒ project_members ∪ session members, org-wide fallback only when that union is empty;
 *  - change fan-out keys the inbox on the CONSUMER repo's own project and resolves its recipients;
 *  - readInbox defense-in-depth: a walled project's items read empty for non-members.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { withSystem, withOrg } from "../db/rls.js";
import { orgs, principals, members, projects, repos, projectMembers, sessions, dependencyEdges } from "../db/schema.js";
import { fanoutToProjectTx, resolveProjectRecipientsTx } from "./routing-engine.js";
import { askQuestion, createTask, recordChange } from "../ledger/ledger-service.js";
import { readInbox, peekInbox } from "../inbox/inbox-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 990_000_000;
const uid = (): number => ++seq;

async function setup(opts?: { visibility?: "shared" | "walled" }) {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `Route-${n}` }).returning());
    const mk = async (tag: string) => {
      const p = one(
        await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `${tag}-${n}` }).returning(),
      );
      return one(
        await tx
          .insert(members)
          .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `${tag}-${n}` })
          .returning(),
      );
    };
    const sender = await mk("sender");
    const insider = await mk("insider");
    const outsider = await mk("outsider");
    const proj = one(
      await tx
        .insert(projects)
        .values({
          orgId: org.id,
          name: `route-${n}`,
          createdBy: sender.id,
          settings: opts?.visibility ? { visibility: opts.visibility } : null,
        })
        .returning(),
    );
    const repo = one(
      await tx
        .insert(repos)
        .values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/route/${n}`, defaultBranch: "main" })
        .returning(),
    );
    return { orgId: org.id, projectId: proj.id, repoId: repo.id, sender, insider, outsider };
  });
}

const addProjectMember = (s: { orgId: string; projectId: string }, memberId: string, login: string) =>
  withSystem((tx) =>
    tx.insert(projectMembers).values({
      orgId: s.orgId,
      projectId: s.projectId,
      memberId,
      invitedGithubLogin: login,
      role: "member",
      status: "active",
    }),
  );

const addSession = (s: { orgId: string; projectId: string; repoId: string }, memberId: string) =>
  withSystem(async (tx) => {
    const repo = one(await tx.select().from(repos).where(eq(repos.id, s.repoId)));
    await tx.insert(sessions).values({
      orgId: s.orgId,
      memberId,
      repoId: s.repoId,
      projectId: s.projectId,
      gitRemote: repo.gitRemote,
      vendor: "claude",
    });
  });

test("walled project: only active project members receive fan-out; outsiders read empty", async () => {
  const s = await setup({ visibility: "walled" });
  await addProjectMember(s, s.insider.id, s.insider.githubLogin!);
  // outsider has a session (would qualify on a shared project) — walls must still exclude them
  await addSession(s, s.outsider.id);

  await askQuestion(s.orgId, { projectId: s.projectId, memberId: s.sender.id, body: "walled q" });

  const insiderView = await readInbox(s.orgId, { memberId: s.insider.id, repoId: s.repoId, projectId: s.projectId });
  assert.equal(insiderView.questions.length, 1);
  const outsiderView = await readInbox(s.orgId, { memberId: s.outsider.id, repoId: s.repoId, projectId: s.projectId });
  assert.equal(outsiderView.unread, 0, "no delivery to non-members of a walled project");

  // Defense-in-depth: even a pre-existing item reads empty for a walled non-member.
  await withOrg(s.orgId, (tx) =>
    fanoutToProjectTx(tx, s.orgId, {
      projectId: s.projectId,
      refId: crypto.randomUUID(),
      kind: "question",
      senderMemberId: s.sender.id,
    }),
  );
  const peek = await peekInbox(s.orgId, { memberId: s.outsider.id, repoId: s.repoId, projectId: s.projectId });
  assert.equal(peek.unread, 0);
});

test("walled project: a delegated task to a non-member is skipped; to a member it lands", async () => {
  const s = await setup({ visibility: "walled" });
  await addProjectMember(s, s.insider.id, s.insider.githubLogin!);

  await createTask(s.orgId, { projectId: s.projectId, memberId: s.sender.id, title: "t1", to: s.outsider.githubLogin! });
  const outsiderView = await readInbox(s.orgId, { memberId: s.outsider.id, repoId: s.repoId, projectId: s.projectId });
  assert.equal(outsiderView.unread, 0, "walled delegation to a non-member does not deliver");

  await createTask(s.orgId, { projectId: s.projectId, memberId: s.sender.id, title: "t2", to: s.insider.githubLogin! });
  const insiderView = await readInbox(s.orgId, { memberId: s.insider.id, repoId: s.repoId, projectId: s.projectId });
  assert.equal(insiderView.tasks.length, 1);
});

test("shared project: project members ∪ session members; uninvolved org members excluded", async () => {
  const s = await setup();
  await addProjectMember(s, s.insider.id, s.insider.githubLogin!);
  const recipients = await withOrg(s.orgId, (tx) => resolveProjectRecipientsTx(tx, s.orgId, s.projectId));
  assert.deepEqual(
    recipients.map((r) => r.memberId).sort(),
    [s.insider.id].sort(),
    "with a non-empty tier set, uninvolved org members are not recipients",
  );

  await addSession(s, s.outsider.id);
  const withSess = await withOrg(s.orgId, (tx) => resolveProjectRecipientsTx(tx, s.orgId, s.projectId));
  const tiers = new Map(withSess.map((r) => [r.memberId, r.tier]));
  assert.equal(tiers.get(s.insider.id), "project-member");
  assert.equal(tiers.get(s.outsider.id), "session-active");
});

test("shared project with no members/sessions falls back to all org members (delivery never stops)", async () => {
  const s = await setup();
  const recipients = await withOrg(s.orgId, (tx) => resolveProjectRecipientsTx(tx, s.orgId, s.projectId));
  assert.equal(recipients.length, 3, "sender + insider + outsider via org fallback");
  assert.ok(recipients.every((r) => r.tier === "org-fallback"));

  await askQuestion(s.orgId, { projectId: s.projectId, memberId: s.sender.id, body: "fallback q" });
  const view = await readInbox(s.orgId, { memberId: s.outsider.id, repoId: s.repoId, projectId: s.projectId });
  assert.equal(view.questions.length, 1);
});

test("change fan-out: consumer-project members get the item in the CONSUMER project's inbox", async () => {
  const s = await setup(); // producer project
  const n = uid();
  const consumer = await withSystem(async (tx) => {
    const proj = one(
      await tx.insert(projects).values({ orgId: s.orgId, name: `consumer-${n}`, createdBy: s.insider.id }).returning(),
    );
    const repo = one(
      await tx
        .insert(repos)
        .values({ orgId: s.orgId, projectId: proj.id, gitRemote: `github.com/route/c-${n}`, defaultBranch: "main" })
        .returning(),
    );
    return { projectId: proj.id, repoId: repo.id };
  });
  await addProjectMember({ orgId: s.orgId, projectId: consumer.projectId }, s.insider.id, s.insider.githubLogin!);
  const surface = `http:GET /route/${n}`;
  await withOrg(s.orgId, (tx) =>
    tx.insert(dependencyEdges).values({
      orgId: s.orgId,
      projectId: consumer.projectId,
      consumerRepoId: consumer.repoId,
      producedRepoId: s.repoId,
      producedSurface: surface,
      source: "manifest",
      active: true,
    }),
  );

  await recordChange(s.orgId, {
    projectId: s.projectId,
    repoId: s.repoId,
    memberId: s.sender.id,
    summary: "changed the surface",
    surface,
    contractDelta: { kind: "modified" },
  });

  const view = await readInbox(s.orgId, {
    memberId: s.insider.id,
    repoId: consumer.repoId,
    projectId: consumer.projectId,
  });
  assert.equal(view.changes.length, 1, "consumer-project member sees the change in the consumer project inbox");

  // The outsider is neither a member of nor has sessions in the consumer project — nothing lands.
  const outsiderView = await readInbox(s.orgId, {
    memberId: s.outsider.id,
    repoId: consumer.repoId,
    projectId: consumer.projectId,
  });
  assert.equal(outsiderView.unread, 0);
});
