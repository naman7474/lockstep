import type { ManagedHook, McpServerSpec } from "./merge.js";

// Uses the globally-installed `lockstep` bin. (When the package is published to npm,
// an installer flag can switch these to `npx @lockstep/cli` for zero-install teammates.)
export const mcpSpec = (vendor: string): McpServerSpec => ({
  command: "lockstep",
  args: ["mcp"],
  env: { LOCKSTEP_VENDOR: vendor },
});

export const captureHooks: ManagedHook[] = [
  { event: "SessionStart", matcher: "*", args: ["capture", "--event", "SessionStart"], timeout: 20 },
  {
    event: "PostToolUse",
    matcher: "Edit|Write|MultiEdit|NotebookEdit",
    args: ["capture", "--event", "PostToolUse"],
    timeout: 30,
  },
  { event: "Stop", matcher: "*", args: ["capture", "--event", "Stop"], timeout: 45 },
];

export const SKILL_MD = `---
name: lockstep
description: Keep this repo's coding agents in lockstep — read the shared ledger before coding, publish changes after.
---

# Lockstep

This project uses Lockstep to coordinate multiple developers' coding agents on the same codebase.

## On session start
- Call \`inbox\` to see what changed, what's newly binding, and what's delegated to you.
- Call \`decisions\` to load the binding rules for the areas you'll touch. A rule may cite an external source (e.g. a Slack thread) — it was distilled from a human decision and confirmed by a teammate; treat it exactly like any other binding decision.
- The briefing leads with **project principles** (\`decisionType: principle\`) — the team's standing
  decision criteria ("server-side business logic → X"). Apply them when making or judging decisions;
  a choice that a principle already settles needs no fresh deliberation, just cite the principle.
- If you see open questions or tasks in the inbox, tell the user about them.

## Before coding a shared/contract surface
- Call \`query\` to check the ledger for existing decisions/contracts (answer instantly if known).
- Before changing or removing an endpoint/RPC, call \`consumers\` with its canonical surface ID
  (e.g. \`http:POST /auth/session\`) to see who depends on it — answer "does anyone use this?" from
  the graph instead of pinging a human. A high consumer count means high blast radius: log a decision.
- Respect any \`binding\` decision in scope.

## Decisions vs changes — the most important distinction
- A **change** is a routine event (you edited some files). It is captured automatically — you do NOT
  log it. Never call \`propose_decision\` just because you edited code.
- A **decision** is a durable **rule** or **architectural choice** that shapes future work
  (e.g. "auth tokens are JWT, 15-min expiry"; "we standardize on Postgres"; "rename POST /login to
  POST /session across the org"). These are the hero of Lockstep.
- **Whenever you (or the user) make a real decision like that, you MUST log it** with
  \`propose_decision\` — set \`decisionType\` to \`rule\` or \`architecture\`. If you're unsure whether
  something is a decision, ask: "will this constrain how others build later?" If yes, log it.
- A decision is more than its verdict — record the deliberation too (this is what makes the ledger
  readable a year later):
  - \`rationale\`: WHY, in one or two sentences (the constraint or trade-off that drove it).
  - \`alternatives\`: the options considered and rejected, when any were discussed.
  - \`reviewAt\` (ISO date): only when the decision is explicitly temporary ("revisit after the
    migration", "review in 30 days"). If the revisit point is an event with no date, ask the user
    for a date or omit it — never invent one.

## After making a change
- Summarize the change and call \`notify\` (include a contract delta for interface changes).
- For any surface you call, record the dependency with \`register_dependency\`.

## Coordinating
- Use \`ask\` for code/repo questions (set \`urgent\` if you're blocked).
- Use \`delegate\` / \`complete\` for handoffs.

## Incoming messages
- When you see a "[Lockstep]" notification, inform the user about the pending message(s).
- The user decides whether to respond — don't auto-answer on their behalf.

## Decision pack (compiled ledger knowledge)
- \`.claude/skills/lockstep-decisions/SKILL.md\` is the **generated** compiled index of this project's
  binding decisions, principles, and ratified product constraints — the uncapped counterpart to the
  session briefing. Consult it before making or judging architectural decisions.
- It is a build artifact: NEVER edit it by hand. When the session briefing says the pack is stale or
  missing, call \`refresh_decision_pack\` (or tell the user to run \`lockstep pack\`).

## First-run onboarding & keeping the manifest current
- If this repo has no \`lockstep.yaml\` (or you've added/removed routes or outbound service calls), run the
  \`/lockstep-setup\` skill. It scans the repo, auto-fills \`produces\`, and resolves \`consumes\` against the
  team's dependency graph — always human-approved. Do NOT hand-edit \`lockstep.yaml\` yourself; \`/lockstep-setup\` is the only writer.
`;

export const SETUP_SKILL_MD = `---
name: lockstep-setup
description: Bootstrap and maintain this repo's lockstep.yaml — auto-fill produces, graph-resolve consumes, human-approved.
trigger: /lockstep-setup
---

# /lockstep-setup

Run-once onboarding (and re-run maintenance) that generates this repo's \`lockstep.yaml\` — the manifest
that declares what surfaces this repo **produces** (its served routes/RPCs) and **consumes** (the surfaces
it calls on other repos). This is the concrete first-run step \`lockstep init\` does NOT do.

## Why this is the only place the manifest is written
The raw capture hook is read-only and must stay that way. This skill is the **single sanctioned writer**
of \`lockstep.yaml\`, and every write is proposed to the human first. You (the agent) never hand-edit the
file — you run \`lockstep scan\`, present its proposal, get approval, then let \`--apply\` write it.

## How consumes are resolved (don't guess URLs)
Lockstep is a graph. \`lockstep scan\` detects this repo's outbound calls (\`fetch\`/\`axios\`/gRPC clients) and
**matches them against the produced-surface catalog of the other repos in the project.** A call that
matches a sibling's produce is a real dependency (the producer is named); one that matches nothing is
external. The deterministic catalog does the resolving — your job is judgment on the fuzzy leftovers and
driving the human approval.

## What You Must Do When Invoked

Follow these steps in order.

### 1. Preconditions
Make sure the repo is connected: if \`lockstep status\` shows it isn't, tell the user to run
\`lockstep connect\` first (without a connection, \`produces\` still works but \`consumes\` can't be resolved
against the graph).

### 2. Scan
Run \`lockstep scan --json\` and read the proposal. It has:
- \`produces\` (+ \`newProduces\`) — served surfaces, deterministic. Safe to accept as-is.
- \`consumes\` (+ \`newConsumes\`) — outbound calls **matched to a sibling repo** (\`producer\` named). High confidence.
- \`review\` — client/import hints that could map to a sibling's surfaces. Ask the user which (if any) apply.
- \`unmatched\` — outbound calls with no producer in the graph (external, e.g. Stripe, or a service not yet onboarded). Don't add these unless the user says so.

### 3. Present for approval
Show the user a concise diff: the new produces, the matched consumes (with producer repos), and any
\`review\`/\`unmatched\` items that need a human call. Ask explicitly before writing — especially for
anything from \`review\`/\`unmatched\`.

### 4. Apply
On approval, run \`lockstep scan --apply\`. This merge-preserves any existing manual entries, writes
\`lockstep.yaml\` (+ a \`.lockstep.bak\`), and syncs the produces/consumes to the graph. For anything the
user chose from \`review\`/\`unmatched\`, add those surface IDs to \`consumes\` in \`lockstep.yaml\` and re-run
\`lockstep scan --apply\` (it re-syncs).

### 5. Offer next steps
Suggest committing \`lockstep.yaml\` so teammates get the same graph, and (if not connected yet)
\`lockstep connect\`. Shared config to commit: \`.mcp.json\`, \`CLAUDE.md\`, \`.claude/skills\`.
\`.claude/settings.local.json\` (hooks + statusline) is personal and auto-gitignored — each teammate
runs \`lockstep onboard\` to get their own.

## Maintenance (re-run anytime)
Re-running \`lockstep scan\` diffs current code surfaces against \`lockstep.yaml\` and shows only the delta
(e.g. "new outbound call to \`http:GET /inventory/:sku\` — add to consumes?"). Approve the delta the same way.
`;

export const CLAUDE_BLOCK = `## Lockstep (team coordination)
IMPORTANT: On session start, BEFORE doing anything else, call \`inbox\` and \`decisions\`. If there are any open questions, tasks, or changes, you MUST tell the user immediately — do not skip this. Example: "You have 1 new question from a teammate: [question text]". Then proceed with the user's request.
Before coding a shared/contract surface, \`query\` the ledger and obey binding decisions. After a change, summarize it, \`register_dependency\` for surfaces you call, and \`notify\`. IMPORTANT: a routine code change is captured automatically — do NOT log it as a decision. But whenever you or the user make a durable **rule or architectural choice** that will constrain future work, you MUST record it with \`propose_decision\` (\`decisionType: rule | architecture | principle\`) — include \`rationale\` (why) and \`alternatives\` (what was rejected) when known, and \`reviewAt\` (ISO date) when the decision is explicitly temporary. Project principles (\`decisionType: principle\`) are the team's standing decision criteria — apply them when judging new decisions. Ask code/repo questions with \`ask\` (urgent if blocking). When you see a "[Lockstep]" notification, inform the user about pending messages. If this repo has no \`lockstep.yaml\` (or you changed its routes/outbound calls), run the \`/lockstep-setup\` skill to (re)generate it — never hand-edit \`lockstep.yaml\`. The \`lockstep-decisions\` skill is the generated compiled decision pack — consult it for settled rules, never edit it, and call \`refresh_decision_pack\` when the briefing says it's stale. See the \`lockstep\` skill for detail.`;
