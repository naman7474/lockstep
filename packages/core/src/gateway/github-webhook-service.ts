/**
 * GitHub webhook (gateway): PR-merge events drive the ledger — the system observes reality (merged
 * code) instead of trusting only developer-laptop hooks. v1 handles pull_request closed+merged; push
 * events are deferred (force-push handling + dedupe against the same merge commit buy little).
 *
 * Tenant resolution: payload.installation.id → github_installations → org (NEVER trust names alone).
 * withSystem note: rls.ts says "never call from a user-influenced path" — this handler is a
 * deliberate, documented expansion of that set: the payload is HMAC-verified against
 * GITHUB_WEBHOOK_SECRET before any lookup, and installation.id (not user input) picks the org.
 */
import { and, eq } from "drizzle-orm";
import { withSystem, withOrg } from "../db/rls.js";
import { githubInstallations, repos, projects, members, changeFeedEntries } from "../db/schema.js";
import { listPrFiles as realListPrFiles, getFile as realGetFile } from "../auth/github.js";
import { projectArchived } from "../auth/permissions.js";
import { extractSurfaces, isContractSurface } from "../ledger/surface-extract.js";
import { recordChange } from "../ledger/ledger-service.js";

export interface GitHubWebhookDeps {
  listPrFiles: typeof realListPrFiles;
  getFile: typeof realGetFile;
}

/** Cap on files fetched per PR — keeps handling synchronous and under GitHub's 10s delivery timeout. */
const MAX_FILES_FETCHED = 20;
const MAX_SURFACES = 10;

interface PrPayload {
  action?: string;
  installation?: { id?: number };
  repository?: { full_name?: string };
  sender?: { id?: number; login?: string };
  pull_request?: {
    number?: number;
    title?: string;
    merged?: boolean;
    merge_commit_sha?: string;
    merged_by?: { id?: number; login?: string } | null;
  };
}

export async function processGitHubEvent(
  event: string,
  payload: PrPayload,
  deps?: Partial<GitHubWebhookDeps>,
): Promise<{ handled: boolean; changes: number; skipped?: string }> {
  const listPrFiles = deps?.listPrFiles ?? realListPrFiles;
  const getFile = deps?.getFile ?? realGetFile;

  const pr = payload.pull_request;
  if (event !== "pull_request" || payload.action !== "closed" || !pr?.merged || !pr.merge_commit_sha) {
    return { handled: false, changes: 0 };
  }
  const installationId = payload.installation?.id;
  const fullName = payload.repository?.full_name;
  if (!installationId || !fullName) return { handled: false, changes: 0, skipped: "no installation/repository" };

  // Resolve tenant + repos + actor under withSystem (see header note).
  const resolved = await withSystem(async (tx) => {
    const install = (
      await tx
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, installationId))
        .limit(1)
    )[0];
    if (!install) return null;
    const orgId = install.orgId;

    const remote = `github.com/${fullName.toLowerCase()}`;
    const candidates = await tx.select().from(repos).where(and(eq(repos.orgId, orgId), eq(repos.gitRemote, remote)));
    const live: Array<{ repoId: string; projectId: string }> = [];
    for (const r of candidates) {
      const proj = (await tx.select().from(projects).where(eq(projects.id, r.projectId)).limit(1))[0];
      if (proj && !projectArchived(proj.settings)) live.push({ repoId: r.id, projectId: r.projectId });
    }
    if (live.length === 0) return { orgId, live: [], memberId: null };

    // Actor: prefer merged_by, fall back to sender; id first, then login.
    const actor = pr.merged_by ?? payload.sender;
    let member =
      actor?.id !== undefined
        ? (
            await tx
              .select()
              .from(members)
              .where(and(eq(members.orgId, orgId), eq(members.githubUserId, actor.id)))
              .limit(1)
          )[0]
        : undefined;
    if (!member && actor?.login) {
      member = (
        await tx
          .select()
          .from(members)
          .where(and(eq(members.orgId, orgId), eq(members.githubLogin, actor.login)))
          .limit(1)
      )[0];
    }
    return { orgId, live, memberId: member?.id ?? null };
  });
  if (!resolved) return { handled: true, changes: 0, skipped: "unknown installation" };
  if (resolved.live.length === 0) return { handled: true, changes: 0, skipped: "repo not connected" };
  // No member ⇒ skip (v1): createdBy feeds sender-exclusion + provenance; no synthetic system member.
  if (!resolved.memberId) return { handled: true, changes: 0, skipped: "actor is not a member" };

  // Fetch changed files + extract surfaces (HTTP outside any transaction).
  const [owner, repoName] = fullName.split("/") as [string, string];
  const files = await listPrFiles(installationId, owner, repoName, pr.number ?? 0);
  const contractFiles = files
    .filter((f) => f.status !== "removed" && isContractSurface(f.filename))
    .slice(0, MAX_FILES_FETCHED);
  const surfaces = new Set<string>();
  for (const f of contractFiles) {
    if (surfaces.size >= MAX_SURFACES) break;
    const file = await getFile(installationId, owner, repoName, f.filename, pr.merge_commit_sha).catch(() => null);
    if (!file) continue;
    for (const s of extractSurfaces(f.filename, file.content)) surfaces.add(s);
  }
  if (surfaces.size === 0) return { handled: true, changes: 0, skipped: "no contract surfaces" };

  const summary = `PR #${pr.number} merged: ${pr.title ?? ""}`.trim();
  let changes = 0;
  for (const target of resolved.live) {
    for (const surface of [...surfaces].slice(0, MAX_SURFACES)) {
      const diffHash = `${pr.merge_commit_sha}:${surface}`;
      // Redelivery dedupe: the same merge commit never records the same surface change twice.
      const seen = await withOrg(resolved.orgId, (tx) =>
        tx
          .select({ id: changeFeedEntries.id })
          .from(changeFeedEntries)
          .where(
            and(
              eq(changeFeedEntries.repoId, target.repoId),
              eq(changeFeedEntries.surface, surface),
              eq(changeFeedEntries.diffHash, diffHash),
            ),
          )
          .limit(1),
      );
      if (seen.length > 0) continue;
      await recordChange(resolved.orgId, {
        projectId: target.projectId,
        repoId: target.repoId,
        memberId: resolved.memberId,
        summary,
        surface,
        // The merge commit is real shipped code — record a VERIFIED contract row for the surface
        // (verificationStatus "verified", verifiedAgainst "git-diff"), unlike laptop-hook asserts.
        contractDelta: { kind: "pr-merge", prNumber: pr.number ?? null },
        riskTier: "owned",
        verified: true,
        verifiedAgainst: "git-diff",
        diffHash,
      });
      changes++;
    }
  }
  return { handled: true, changes };
}
