/**
 * `lockstep pack` — write the compiled decision pack (a generated, per-developer skill file).
 *
 * The pack is a BUILD ARTIFACT, not source: it's regenerated from the ledger and gitignored via a
 * sidecar `.gitignore` (so a committed copy can never be clobbered by `git pull` — IMPROVEMENTS #1).
 * Writers are exactly two: this command and the `refresh_decision_pack` MCP tool. The capture hook
 * stays read-only — it only nudges when the local pack's hash trails the ledger.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyFile } from "./adapters/fsutil.js";
import { registerSession } from "./mcp/session.js";
import { call } from "./mcp/api.js";

export const PACK_DIR = [".claude", "skills", "lockstep-decisions"] as const;

export function packPath(cwd: string): string {
  return join(cwd, ...PACK_DIR, "SKILL.md");
}

/** The embedded hash from the local pack's metadata comment; null when absent/unreadable. */
export function readLocalPackHash(cwd: string): string | null {
  try {
    const m = /<!-- lockstep-pack hash=([0-9a-f]+) /.exec(readFileSync(packPath(cwd), "utf8"));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface PackResp {
  markdown: string;
  packHash: string;
  generatedAt: string;
  counts: { principles: number; binding: number; constraints: number; superseded: number };
}

/** Full overwrite (sanctioned for generated skills) + a `*` .gitignore sidecar. Idempotent via applyFile. */
export async function writeDecisionPack(cwd: string, markdown: string, dryRun: boolean): Promise<string[]> {
  return [
    await applyFile(packPath(cwd), () => markdown, dryRun),
    await applyFile(join(cwd, ...PACK_DIR, ".gitignore"), () => "*\n", dryRun),
  ];
}

export async function runPack(opts: { check?: boolean; dryRun?: boolean }): Promise<void> {
  const vendor = process.env.LOCKSTEP_VENDOR ?? "cli";
  const session = await registerSession(vendor);
  const p = await call<PackResp>("GET", "/decision-pack", session.sessionId);
  const cwd = process.cwd();

  if (opts.check) {
    const local = readLocalPackHash(cwd);
    if (local === p.packHash) {
      console.log(`✓ decision pack ${p.packHash} is current`);
      return;
    }
    console.error(
      local
        ? `✗ decision pack is stale (local ${local}, ledger ${p.packHash}) — run \`lockstep pack\``
        : `✗ no decision pack installed — run \`lockstep pack\``,
    );
    process.exit(1);
  }

  for (const line of await writeDecisionPack(cwd, p.markdown, opts.dryRun ?? false)) console.log(line);
  console.log(
    `decision pack ${p.packHash} — ${p.counts.binding} binding, ${p.counts.principles} principle(s), ${p.counts.constraints} constraint(s)`,
  );
}
