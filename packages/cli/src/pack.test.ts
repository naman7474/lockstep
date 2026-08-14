/**
 * Decision-pack write mechanics: idempotent full overwrite via applyFile, the `*` .gitignore
 * sidecar (the pack is a per-developer build artifact), and the hash round-trip the SessionStart
 * staleness nudge depends on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDecisionPack, readLocalPackHash, packPath } from "./pack.js";

const PACK = (hash: string) =>
  `---\nname: lockstep-decisions\ndescription: test pack\n---\n\n<!-- lockstep-pack hash=${hash} generated=2026-08-14T00:00:00.000Z -->\n\n# proj — decision pack\n`;

test("writeDecisionPack: writes SKILL.md + gitignore sidecar; second write is unchanged", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lockstep-pack-"));
  const first = await writeDecisionPack(cwd, PACK("aabbccdd00112233"), false);
  assert.equal(first.filter((r) => r.startsWith("wrote")).length, 2);
  assert.equal(readFileSync(packPath(cwd), "utf8"), PACK("aabbccdd00112233"));
  assert.equal(readFileSync(join(cwd, ".claude", "skills", "lockstep-decisions", ".gitignore"), "utf8"), "*\n");

  const second = await writeDecisionPack(cwd, PACK("aabbccdd00112233"), false);
  assert.ok(second.every((r) => r.startsWith("unchanged")), "identical content is a no-op");

  const updated = await writeDecisionPack(cwd, PACK("ffff000011112222"), false);
  assert.ok(updated[0]!.startsWith("wrote"), "new content rewrites the skill");
});

test("writeDecisionPack: dry run touches nothing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lockstep-pack-"));
  const res = await writeDecisionPack(cwd, PACK("aabbccdd00112233"), true);
  assert.ok(res.every((r) => r.startsWith("would write")));
  assert.ok(!existsSync(packPath(cwd)));
});

test("readLocalPackHash: round-trips the metadata comment; null when missing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lockstep-pack-"));
  assert.equal(readLocalPackHash(cwd), null);
  await writeDecisionPack(cwd, PACK("aabbccdd00112233"), false);
  assert.equal(readLocalPackHash(cwd), "aabbccdd00112233");
});
