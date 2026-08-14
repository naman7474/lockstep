#!/usr/bin/env node
import { runInit, runStatus, runDoctor } from "./init.js";
import { runLogin } from "./login.js";
import { runConnect, runInvite } from "./connect.js";
import type { Scope } from "./adapters/types.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (n: string): boolean => argv.includes(`--${n}`);
const val = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function help(): void {
  console.log(`lockstep — keep your team's coding agents in sync

usage: lockstep <command>

  login [--api <url>] [--dev --dev-id <n> --dev-login <handle>]
                                                    authenticate; --api saves your server (once), --dev for testing
  init  [--vendor claude|all] [--scope project|user] [--dry-run]
                                                    wire up hooks + MCP + skill for the detected agent(s)
  connect [--project <name>]                        link this repo to a Lockstep project (creates one if needed)
  onboard [--project <name>]                        one step: init + connect (for a teammate joining a repo)
  scan  [--json] [--apply] [--dry-run]              scan the repo → propose lockstep.yaml (produces + graph-resolved consumes)
  sync                                              push lockstep.yaml (produces + consumes) to the graph, no rescan
  pack  [--check] [--dry-run]                       write the compiled decision pack skill (--check: exit 1 if stale)
  invite <github-handle>                            invite a teammate to this repo's project
  status                                            show auth + config health
  doctor                                            diagnose vendor config
  mcp                                               run the per-session MCP server (used by agents)
  capture --event <E>                               hook entrypoint (used by hooks)              [P6]
`);
}

function notYet(name: string, phase: string): never {
  console.error(`\`lockstep ${name}\` is not implemented yet (arrives in ${phase}).`);
  process.exit(2);
}

async function main(): Promise<void> {
  switch (cmd) {
    case "login": {
      // Remember the server so the user never has to export anything again.
      const api = val("api") ?? process.env.LOCKSTEP_API_URL;
      if (api) {
        const { setApiUrl } = await import("./config.js");
        setApiUrl(api);
      }
      if (has("dev")) {
        const id = Number(val("dev-id") ?? "0");
        const login = val("dev-login") ?? "";
        if (!id || !login) {
          console.error("usage: lockstep login --dev --dev-id <n> --dev-login <handle>");
          process.exit(1);
        }
        return runLogin({ dev: { id, login } });
      }
      return runLogin({});
    }
    case "init":
      return runInit({
        vendor: val("vendor"),
        scope: (val("scope") as Scope) ?? "project",
        dryRun: has("dry-run"),
      });
    case "connect":
      return runConnect({ org: val("org"), project: val("project") });
    case "onboard": {
      // One-step teammate onboarding: wire the repo (init) then link it (connect).
      await runInit({ vendor: val("vendor"), scope: (val("scope") as Scope) ?? "project", dryRun: has("dry-run") });
      if (has("dry-run")) return;
      await runConnect({ org: val("org"), project: val("project") });
      // Best-effort: seed the compiled decision pack now that the repo is connected. Never fatal.
      try {
        const { runPack } = await import("./pack.js");
        await runPack({});
      } catch {
        /* pack requires a reachable core with /decision-pack — the session-start nudge covers it */
      }
      console.log("\nOnboarded. Run `lockstep scan` to propose this repo's dependencies.");
      return;
    }
    case "scan": {
      const { runScan } = await import("./scan.js");
      return runScan({ json: has("json"), apply: has("apply"), dryRun: has("dry-run") });
    }
    case "sync": {
      const { runSync } = await import("./scan.js");
      return runSync();
    }
    case "pack": {
      const { runPack } = await import("./pack.js");
      return runPack({ check: has("check"), dryRun: has("dry-run") });
    }
    case "invite": {
      const handle = argv[1];
      if (!handle) {
        console.error("usage: lockstep invite <github-handle>");
        process.exit(1);
      }
      return runInvite(handle);
    }
    case "status":
      return runStatus();
    case "doctor":
      return runDoctor();
    case "mcp": {
      const { runMcpServer } = await import("./mcp/server.js");
      await runMcpServer();
      return;
    }
    case "capture": {
      const { runCapture } = await import("./capture/index.js");
      await runCapture(val("event") ?? "PostToolUse");
      return;
    }
    case "statusline": {
      const { runStatusLine } = await import("./statusline.js");
      await runStatusLine();
      return;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      return help();
    default:
      console.error(`unknown command: ${cmd}\n`);
      help();
      process.exit(1);
  }
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
