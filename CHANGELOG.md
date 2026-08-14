# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

**Versioning policy:** Lockstep is a monorepo released as a single unit. The root,
`@lockstep/core`, `@lockstep/web`, `lockstep-cli`, and `@lockstep/pr-check` packages
share one version number, tagged on this repository (e.g. `v0.1.0`). The `lockstep-cli`
package is the only one published to npm; its npm version tracks the repo version.

## [Unreleased]

## [0.2.0] - 2026-08-14

### Added

- **Compiled decision packs** — `GET /decision-pack` renders the project's settled knowledge
  (principles, binding decisions with rationale/alternatives, ratified constraints, superseded
  lineage) as a deterministic, hash-stamped `SKILL.md`. Delivered by the new `lockstep pack`
  command and `refresh_decision_pack` MCP tool as a gitignored per-developer build artifact; the
  session briefing carries `pack.hash` and the SessionStart hook nudges (read-only) when stale.
- **Semantic retrieval** — `query` and `get_product_context`'s free-text path now layer cosine
  ranking (Voyage, reusing the fusion embedding cache with embed-on-miss) over substring matching.
  Substring hits always rank first; without `VOYAGE_API_KEY` behavior is unchanged. `POST /query`
  now honors the `scope` param as a rank boost; rejected decisions no longer surface.
- **GitHub webhook** (`POST /webhooks/github`) — PR-merge events record *verified* (`git-diff`)
  contract changes per extracted surface, deduped per merge commit, resolved by installation id.
- **Slack Events ingress** (`POST /webhooks/slack/events`) — live message events enqueue
  thread-level units (allowlist-gated); the worker's new fast loop (default 60s) distills them in
  near-real-time. The 15-min sweep remains cursor authority and backstop.
- **Persistent scheduler** (`scheduled_jobs`, migration 0008) — expiry, weekly digests, and the
  writeback drain run on leased, per-kind cadences claimed by the worker (`FOR UPDATE SKIP LOCKED`).
- Dashboard **"Sign in with GitHub"** (web OAuth), so the hosted instance is self-serve instead of requiring a pasted CLI token.
- `lockstep.yaml` manifest to declare the surfaces a repo produces and consumes.
- `consumers` tool / `GET /consumers` — "does anyone use this surface?", answered from the usage graph.

### Changed

- **Tiered inbox routing** — fan-out no longer targets every org member. Walled projects deliver
  strictly to active project members (fixes items leaking to non-members, including targeted
  tasks/conflicts and `readInbox`/`peekInbox` defense-in-depth); shared projects deliver to
  project members ∪ session-involved members, falling back org-wide only when that union is empty.
  Change fan-out now keys the inbox on the *consumer* repo's own project.
- Writebacks drain on their own 5-minute schedule — previously they only drained when document
  work existed, so orgs without doc connections never delivered digests (bug fix).
- `workerAuthed` now compares the ingest token in constant time.
- License changed from MIT to Apache-2.0.
- Capture records *changes*, not decisions — decisions are logged explicitly and typed (`rule` | `architecture`).
- Surfaces use canonical vendor-neutral IDs (`http:`, `proto:`, `gql:`) so changes route to their consumers.
- Decisions and changes carry an impact score (blast radius) that ranks the session briefing and drives binding.

### Fixed

- Cross-service teammates now join a project via invite instead of silently getting a separate workspace; `lockstep invite` resolves the project by git remote.

## [0.1.0] - 2026-06-23

First public release.

### Added

- **Capture (Tier-1)** — Claude Code `PostToolUse`/`SessionEnd` hooks diff the working
  tree, classify changed files as contract surfaces or owned, and publish to the ledger
  with a risk tier.
- **Routing** — dependency-graph fan-out: a contract change notifies every repo that
  registered a dependency on the changed surface, delivered to its inbox.
- **Replay** — `SessionStart` injects unread changes, binding decisions, and open
  questions into the agent as `additionalContext`.
- **Decision ledger** — append-only, content-addressable (CAS) versioned decisions with a
  propose/acknowledge workflow; owner-scoped decisions bind immediately, shared ones bind
  on acknowledgement.
- **Reconciliation gate (Tier-2)** — GitHub Action that fails a PR when a changed contract
  surface has no binding decision.
- **Ownership graph** — CODEOWNERS parser, auto-ingested on connect.
- **MCP server** — per-session, 12 tools (notify, inbox, ack, query, ask, answer,
  delegate, complete, propose_decision, ack_decision, register_dependency, decisions,
  whoowns).
- **CLI** (`lockstep-cli`) — `login` (GitHub device flow + dev mode), `init`, `connect`,
  `invite`, `capture`, `status`, `doctor`; OS-keychain token storage with encrypted file
  fallback.
- **Dashboard** — Next.js UI for decisions, contracts, dependencies, activity, members,
  questions, and tasks.
- **Backend** — Fastify 5 API on PostgreSQL (Drizzle ORM), 26-table schema with
  row-level-security tenant isolation and append-only enforcement; runs self-hosted via
  `docker compose` or managed on Railway.
- **Project hygiene** — CI (build, typecheck, lint, test on Node 20 & 22), ESLint +
  Prettier, issue/PR templates, SECURITY.md, CONTRIBUTING.md.

[Unreleased]: https://github.com/lockstep-team-agent/lockstep/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lockstep-team-agent/lockstep/releases/tag/v0.1.0
