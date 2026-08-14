/**
 * Compiled decision pack — the ledger's settled knowledge rendered as a per-project SKILL.md.
 *
 * The briefing (session start) is a token-capped ranked list; the pack is the uncapped, durable
 * counterpart: a generated skill file agents load on demand. Rendering is deterministic — same
 * ledger state ⇒ same body ⇒ same hash — so the hash doubles as the staleness signal the CLI
 * compares against `/briefing`'s `pack.hash`. Open/proposed decisions are deliberately excluded:
 * they churn per-session and already live in the inbox/briefing.
 *
 * Doctrine: rendering is pure templating over listDecisions() — no LLM, no extra queries, no
 * queue. The pack is recomputed on every read; at ledger scale (hundreds of rows) that is cheaper
 * than any dirty-tracking machinery would be.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import { projects } from "../db/schema.js";
import { listDecisions } from "./ledger-service.js";

export type PackDecision = Awaited<ReturnType<typeof listDecisions>>[number];

export interface PackCounts {
  principles: number;
  binding: number;
  constraints: number;
  superseded: number;
}

const SUPERSEDED_SHOWN = 10;

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Stable ordering everywhere: impact desc → proposedAt asc → id. Keeps the hash deterministic. */
function stableSort(rows: PackDecision[]): PackDecision[] {
  return [...rows].sort(
    (a, b) =>
      b.impact - a.impact || a.proposedAt.getTime() - b.proposedAt.getTime() || a.id.localeCompare(b.id),
  );
}

function renderDecision(d: PackDecision): string {
  const lines = [`- ${d.ruleText}${d.impact > 0 ? ` _(impact ${d.impact})_` : ""}`];
  if (d.rationale) lines.push(`  - Why: ${d.rationale}`);
  if (d.alternatives && d.alternatives.length > 0) lines.push(`  - Rejected: ${d.alternatives.join("; ")}`);
  if (d.reviewAt) lines.push(`  - Review by: ${d.reviewAt.toISOString().slice(0, 10)}${d.dueForReview ? " ⚠ due" : ""}`);
  lines.push(`  - _(lockstep:${shortId(d.id)} v${d.version})_`);
  return lines.join("\n");
}

/**
 * Pure, deterministic render. `generatedAt` lives in the metadata comment OUTSIDE the hashed body,
 * so re-rendering identical ledger state always reproduces the same hash.
 */
export function renderDecisionPack(input: {
  projectName: string;
  decisions: PackDecision[];
}): { body: string; packHash: string; counts: PackCounts } {
  const principles = stableSort(
    input.decisions.filter((d) => d.status === "binding" && d.decisionType === "principle"),
  );
  const binding = stableSort(
    input.decisions.filter(
      (d) => d.status === "binding" && d.origin !== "document" && d.decisionType !== "principle",
    ),
  );
  const constraints = stableSort(input.decisions.filter((d) => d.status === "binding" && d.origin === "document"));
  const superseded = input.decisions
    .filter((d) => d.status === "superseded" && d.supersededById)
    .sort((a, b) => b.proposedAt.getTime() - a.proposedAt.getTime() || a.id.localeCompare(b.id))
    .slice(0, SUPERSEDED_SHOWN);

  const parts: string[] = [`# ${input.projectName} — decision pack`, ""];

  parts.push("## Principles", "");
  if (principles.length === 0) parts.push("_None yet._", "");
  else {
    for (const d of principles) parts.push(renderDecision(d));
    parts.push("");
  }

  parts.push("## Binding decisions", "");
  if (binding.length === 0) parts.push("_None yet._", "");
  else {
    // Grouped by scope so an agent working on a surface can scan its section directly.
    const groups = new Map<string, PackDecision[]>();
    for (const d of binding) {
      const key = `${d.scopeKind}: ${d.scopeRef}`;
      groups.set(key, [...(groups.get(key) ?? []), d]);
    }
    for (const key of [...groups.keys()].sort()) {
      parts.push(`### ${key}`, "");
      for (const d of groups.get(key)!) parts.push(renderDecision(d));
      parts.push("");
    }
  }

  parts.push("## Product constraints (ratified)", "");
  if (constraints.length === 0) parts.push("_None._", "");
  else {
    const groups = new Map<string, PackDecision[]>();
    for (const d of constraints) groups.set(d.scopeRef, [...(groups.get(d.scopeRef) ?? []), d]);
    for (const key of [...groups.keys()].sort()) {
      parts.push(`### ${key}`, "");
      for (const d of groups.get(key)!) parts.push(renderDecision(d));
      parts.push("");
    }
  }

  parts.push("## No longer true", "");
  if (superseded.length === 0) parts.push("_Nothing superseded recently._", "");
  else {
    for (const d of superseded) {
      parts.push(`- ~~${d.ruleText}~~ → superseded by lockstep:${shortId(d.supersededById!)}`);
    }
    parts.push("");
  }

  const body = parts.join("\n");
  const packHash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  return {
    body,
    packHash,
    counts: {
      principles: principles.length,
      binding: binding.length,
      constraints: constraints.length,
      superseded: superseded.length,
    },
  };
}

function frontmatter(projectName: string): string {
  return [
    "---",
    "name: lockstep-decisions",
    `description: Compiled decision pack for ${projectName} — settled rules, principles, and ratified product constraints. Consult before making or judging architectural decisions. Generated by Lockstep; do not edit — refresh with \`lockstep pack\` or the refresh_decision_pack tool.`,
    "---",
    "",
  ].join("\n");
}

async function gatherAndRender(
  orgId: string,
  projectId: string,
): Promise<{ projectName: string; body: string; packHash: string; counts: PackCounts }> {
  const projectName = await withOrg(orgId, async (tx) => {
    const p = (await tx.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1))[0];
    return p?.name ?? "project";
  });
  const all = await listDecisions(orgId, projectId);
  return { projectName, ...renderDecisionPack({ projectName, decisions: all }) };
}

/** The GET /decision-pack backend: gather → render → wrap with frontmatter + metadata comment. */
export async function getDecisionPack(
  orgId: string,
  projectId: string,
): Promise<{ markdown: string; packHash: string; generatedAt: string; counts: PackCounts }> {
  const { projectName, body, packHash, counts } = await gatherAndRender(orgId, projectId);
  const generatedAt = new Date().toISOString();
  const markdown = `${frontmatter(projectName)}<!-- lockstep-pack hash=${packHash} generated=${generatedAt} -->\n\n${body}`;
  return { markdown, packHash, generatedAt, counts };
}

/** Hash-only variant for the /briefing staleness field — same render path, body discarded. */
export async function getDecisionPackHash(orgId: string, projectId: string): Promise<string> {
  return (await gatherAndRender(orgId, projectId)).packHash;
}
