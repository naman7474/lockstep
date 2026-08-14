/**
 * Lockstep system-of-record schema (PRD §9).
 *
 * Principles:
 *  - Multi-tenant: every child table carries `orgId`; Postgres RLS (see sql/0001_rls.sql)
 *    scopes every query to the caller's org. The `orgs` table is the tenant root.
 *  - Append-only / versioned / attributed: documents get new *version* rows rather than
 *    in-place mutation; narrow status columns are the only allowed UPDATEs (enforced by
 *    triggers in sql/0002_append_only.sql).
 *  - Source code never appears here — only coordination metadata.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
// org scoping column present on every child table (RLS key)
const orgId = () => uuid("org_id").notNull();

/* ───────────────────────────── Tenancy & identity ───────────────────────────── */

export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  identityProvider: text("identity_provider").notNull().default("github"),
  retentionPolicy: jsonb("retention_policy"),
  deployment: text("deployment").notNull().default("self-host"), // cloud | self-host
  createdAt: createdAt(),
});

/**
 * Global identity (NOT org-scoped). A GitHub user is one principal that may be a
 * member of many orgs. principals/access_tokens/github_credentials are "system" tables —
 * RLS makes them readable only via the privileged withSystem() path (auth/login), never
 * by a normal tenant request.
 */
export const principals = pgTable("principals", {
  id: id(),
  githubUserId: bigint("github_user_id", { mode: "number" }).notNull().unique(),
  githubLogin: text("github_login").notNull(),
  displayName: text("display_name"),
  email: text("email"),
  createdAt: createdAt(),
});

export const members = pgTable(
  "members",
  {
    id: id(),
    orgId: orgId(),
    principalId: uuid("principal_id").notNull(),
    githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
    githubLogin: text("github_login").notNull(), // the @handle used in CODEOWNERS
    displayName: text("display_name"),
    email: text("email"),
    vendorsInUse: text("vendors_in_use").array(), // {claude,codex,gemini}
    slackUserId: text("slack_user_id"), // v3: Slack identity for ratification digests + button actions
    createdAt: createdAt(),
  },
  (t) => ({
    uqOrgPrincipal: uniqueIndex("uq_members_org_principal").on(t.orgId, t.principalId),
    byLogin: index("ix_members_org_login").on(t.orgId, t.githubLogin),
  }),
);

export const projects = pgTable("projects", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  settings: jsonb("settings"), // per-project feature flags, e.g. {productLayer:{enabled:true}}
  createdAt: createdAt(),
  createdBy: uuid("created_by"),
});

export const projectMembers = pgTable(
  "project_members",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    memberId: uuid("member_id"), // null until invite accepted
    invitedGithubLogin: text("invited_github_login").notNull(), // invite by handle
    role: text("role").notNull().default("member"), // owner | pm | member
    status: text("status").notNull().default("invited"), // invited | active | revoked
    invitedBy: uuid("invited_by"),
    createdAt: createdAt(),
  },
  (t) => ({
    uqInvite: uniqueIndex("uq_project_member_login").on(t.projectId, t.invitedGithubLogin),
  }),
);

export const repos = pgTable(
  "repos",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    gitRemote: text("git_remote").notNull(), // canonical, e.g. github.com/org/order-service — match key
    defaultBranch: text("default_branch").default("main"),
    codeownersSha: text("codeowners_sha"),
    isMonorepo: boolean("is_monorepo").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({
    uqRemote: uniqueIndex("uq_repo_project_remote").on(t.projectId, t.gitRemote),
    byRemote: index("ix_repo_remote").on(t.gitRemote),
  }),
);

/* GitHub App installation per org (mint installation tokens for CODEOWNERS reads). */
export const githubInstallations = pgTable(
  "github_installations",
  {
    id: id(),
    orgId: orgId(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login"),
    createdAt: createdAt(),
  },
  (t) => ({ uqInstall: uniqueIndex("uq_install_org").on(t.orgId, t.installationId) }),
);

/* ───────────────────────────── Ownership graph ───────────────────────────── */

export const ownershipSnapshots = pgTable(
  "ownership_snapshots",
  {
    id: id(),
    orgId: orgId(),
    repoId: uuid("repo_id").notNull(),
    codeownersSha: text("codeowners_sha"),
    builtFrom: text("built_from").notNull().default("codeowners"), // codeowners | git_history | merged
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({ byCurrent: index("ix_ownership_snapshot_current").on(t.repoId, t.isCurrent) }),
);

export const ownershipRules = pgTable(
  "ownership_rules",
  {
    id: id(),
    orgId: orgId(),
    repoId: uuid("repo_id").notNull(),
    snapshotId: uuid("snapshot_id").notNull(),
    pattern: text("pattern").notNull(), // raw CODEOWNERS glob
    patternRegex: text("pattern_regex").notNull(), // precompiled
    precedence: integer("precedence").notNull(), // line order; last match wins
    source: text("source").notNull().default("codeowners"), // codeowners | git_history | manual_override
    createdAt: createdAt(),
  },
  (t) => ({ bySnapshot: index("ix_ownership_rule_snapshot").on(t.snapshotId, t.precedence) }),
);

export const ownershipRuleOwners = pgTable("ownership_rule_owners", {
  id: id(),
  orgId: orgId(),
  ruleId: uuid("rule_id").notNull(),
  ownerLogin: text("owner_login").notNull(), // @handle or @team
  memberId: uuid("member_id"), // resolved if known
});

/* ───────────────────────────── Decision docs (CAS, versioned) ───────────────────────────── */

export const decisions = pgTable("decisions", {
  id: id(),
  orgId: orgId(),
  projectId: uuid("project_id").notNull(),
  scopeKind: text("scope_kind").notNull(), // surface | repo | topic | project | capability
  scopeRef: text("scope_ref").notNull(),
  // A decision is a durable RULE or ARCHITECTURAL choice that shapes future work — never a routine
  // change event (those live in change_feed_entries). See the product thesis.
  decisionType: text("decision_type").notNull().default("rule"), // rule | architecture | principle (project-level meta-decision / standing criteria)
  // Blast radius, derived from the usage graph (count of consumers of the scope) with optional
  // agent/human override. Drives noise filtering, session-start ranking, and the binding model.
  impact: integer("impact").notNull().default(0),
  currentVersion: integer("current_version").notNull().default(0),
  // proposed → awaiting human confirm (v2 ingested decisions) or PM ratification (v3 document
  // constraints); open | ack | binding | superseded are the agent-originated lifecycle; rejected → a
  // proposed decision a human declined; stale → source document archived/lost (v3); expired → a dated
  // constraint past expiresAt (v3). stale/expired are terminal-ish like superseded: out of briefings,
  // visible in history.
  status: text("status").notNull().default("open"), // proposed | open | ack | binding | superseded | rejected | stale | expired
  // Who authored this decision: an agent via propose_decision, the v2 ingestion pipeline distilling it
  // from a human tool (Slack/Jira/Notion conversations), or the v3 document pipeline distilling a
  // product constraint from a PRD. Both non-agent origins land `proposed` until a human confirms/ratifies.
  origin: text("origin").notNull().default("agent"), // agent | ingested | document
  // v3 product constraints only (origin=document): display/expiry taxonomy — never changes binding
  // semantics. Null for everything else.
  constraintKind: text("constraint_kind"), // behavioral | launch_gate | scope_exclusion
  expiresAt: timestamp("expires_at", { withTimezone: true }), // launch gates: binding → expired past this
  // Review tripwire ("prepare to be wrong"): a binding decision past reviewAt surfaces as due for
  // review — query-time only, never changes binding semantics. Mutable (snooze/clear via review route).
  reviewAt: timestamp("review_at", { withTimezone: true }),
  // Set together with status=superseded when a newer decision on the same scope binds. Logical link
  // (no FK constraint, matching the rest of the schema); "supersedes" is the reverse lookup.
  supersededById: uuid("superseded_by_id"),
  createdAt: createdAt(),
});

export const decisionVersions = pgTable(
  "decision_versions",
  {
    id: id(),
    orgId: orgId(),
    decisionId: uuid("decision_id").notNull(),
    version: integer("version").notNull(),
    baseVersion: integer("base_version").notNull(), // CAS target
    ruleText: text("rule_text").notNull(),
    provenance: jsonb("provenance"), // {source, vendor, gitSha, summary}
    rationale: text("rationale"), // the why, versioned with the rule text (ADR context)
    alternatives: jsonb("alternatives").$type<string[]>(), // options considered and rejected
    status: text("status").notNull().default("open"),
    proposedBy: uuid("proposed_by"),
    createdAt: createdAt(),
  },
  (t) => ({ uqVersion: uniqueIndex("uq_decision_version").on(t.decisionId, t.version) }),
);

export const decisionRequiredReviewers = pgTable("decision_required_reviewers", {
  id: id(),
  orgId: orgId(),
  decisionId: uuid("decision_id").notNull(),
  reviewerMemberId: uuid("reviewer_member_id").notNull(),
  required: boolean("required").notNull().default(true),
});

export const decisionApprovals = pgTable("decision_approvals", {
  id: id(),
  orgId: orgId(),
  decisionId: uuid("decision_id").notNull(),
  version: integer("version").notNull(),
  reviewerId: uuid("reviewer_id").notNull(),
  verdict: text("verdict").notNull(), // approve | request_changes | ack | ratify
  comment: text("comment"),
  createdAt: createdAt(),
});

/* ───────────────────────────── Contract (asserted → verified) ───────────────────────────── */

export const contracts = pgTable(
  "contracts",
  {
    id: id(),
    orgId: orgId(),
    repoId: uuid("repo_id").notNull(),
    surface: text("surface").notNull(), // e.g. "POST /orders" — dependency-graph key
    delta: jsonb("delta"), // added/removed/changed fields & types
    // "verified" here means MECHANICALLY DERIVED (from a git diff or source extraction), never
    // runtime-verified — the UI renders git-diff/source-extracted as "extracted" and reserves the
    // word "verified" for a future runtime/OpenAPI check (IMPROVEMENTS #3).
    verified: boolean("verified").notNull().default(false),
    verifiedAgainst: text("verified_against"), // "git-diff" | "source-extracted" | "openapi:..." | null
    verificationStatus: text("verification_status").notNull().default("asserted_unverified"),
    version: integer("version").notNull().default(1),
    decisionId: uuid("decision_id"),
    createdAt: createdAt(),
    createdBy: uuid("created_by"),
  },
  (t) => ({ bySurface: index("ix_contract_repo_surface").on(t.repoId, t.surface) }),
);

/* ───────────────────────────── Dependency graph (edge table) ───────────────────────────── */

export const dependencyEdges = pgTable(
  "dependency_edges",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    consumerRepoId: uuid("consumer_repo_id").notNull(),
    producedRepoId: uuid("produced_repo_id"), // nullable for cross-org/unknown producer
    producedSurface: text("produced_surface").notNull(), // "POST /orders"
    source: text("source").notNull().default("register_dependency"), // register_dependency | inferred
    active: boolean("active").notNull().default(true), // soft-delete / tombstone
    createdAt: createdAt(),
    createdBy: uuid("created_by"),
  },
  (t) => ({
    // the two hot routing queries:
    bySurface: index("ix_dep_surface_active").on(t.producedSurface, t.active),
    byProducer: index("ix_dep_producer_surface").on(t.producedRepoId, t.producedSurface),
  }),
);

/* ───────────────────────────── Question docs ───────────────────────────── */

export const questions = pgTable("questions", {
  id: id(),
  orgId: orgId(),
  projectId: uuid("project_id").notNull(),
  scopeKind: text("scope_kind").notNull(), // surface | repo | topic | project
  scopeRef: text("scope_ref"),
  body: text("body").notNull(),
  urgent: boolean("urgent").notNull().default(false),
  status: text("status").notNull().default("open"), // open | answered | closed
  routeTrace: jsonb("route_trace"),
  askedBy: uuid("asked_by"),
  createdAt: createdAt(),
});

export const answers = pgTable("answers", {
  id: id(),
  orgId: orgId(),
  questionId: uuid("question_id").notNull(),
  body: text("body").notNull(),
  answeredBy: uuid("answered_by"),
  writtenBackRef: uuid("written_back_ref"), // ledger row created so future query() finds it
  createdAt: createdAt(),
});

/* ───────────────────────────── Change feed ───────────────────────────── */

export const changeFeedEntries = pgTable("change_feed_entries", {
  id: id(),
  orgId: orgId(),
  projectId: uuid("project_id").notNull(),
  repoId: uuid("repo_id").notNull(),
  summary: text("summary").notNull(),
  contractId: uuid("contract_id"),
  surface: text("surface"),
  riskTier: text("risk_tier").notNull().default("owned"), // owned | shared | contract
  impact: integer("impact").notNull().default(0), // blast radius (consumer count of the surface)
  publishState: text("publish_state").notNull().default("drafted"), // drafted | pending_confirm | published
  provenance: jsonb("provenance"),
  diffHash: text("diff_hash"), // dedup key for PostToolUse vs Stop double-fire
  createdAt: createdAt(),
  createdBy: uuid("created_by"),
});

/* ───────────────────────────── Tasks ───────────────────────────── */

export const tasks = pgTable("tasks", {
  id: id(),
  orgId: orgId(),
  projectId: uuid("project_id").notNull(),
  title: text("title").notNull(),
  refs: jsonb("refs"),
  delegatedTo: uuid("delegated_to"),
  delegatedBy: uuid("delegated_by"),
  approver: uuid("approver"),
  runState: text("run_state").notNull().default("queued"), // queued | approved | running | done
  status: text("status").notNull().default("open"),
  createdAt: createdAt(),
});

/* ───────────────────────────── Inbox ───────────────────────────── */

export const inboxes = pgTable(
  "inboxes",
  {
    id: id(),
    orgId: orgId(),
    memberId: uuid("member_id").notNull(),
    repoId: uuid("repo_id").notNull(),
    projectId: uuid("project_id").notNull(),
    replayCursor: uuid("replay_cursor"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ uqInbox: uniqueIndex("uq_inbox_member_repo_project").on(t.memberId, t.repoId, t.projectId) }),
);

export const inboxItems = pgTable(
  "inbox_items",
  {
    id: id(),
    orgId: orgId(),
    inboxId: uuid("inbox_id").notNull(),
    kind: text("kind").notNull(), // change | decision | question | task
    refId: uuid("ref_id").notNull(),
    reason: jsonb("reason"), // route trace: why you got this
    state: text("state").notNull().default("unread"), // unread | read | acked
    createdAt: createdAt(),
  },
  (t) => ({ uqItem: uniqueIndex("uq_inbox_item").on(t.inboxId, t.kind, t.refId) }),
);

/* ───────────────────────────── Sessions ───────────────────────────── */

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    orgId: orgId(),
    memberId: uuid("member_id").notNull(),
    repoId: uuid("repo_id").notNull(),
    projectId: uuid("project_id").notNull(),
    gitRemote: text("git_remote").notNull(),
    cwd: text("cwd"),
    vendor: text("vendor"), // claude | codex | gemini
    tokenId: uuid("token_id"),
    lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }).defaultNow().notNull(),
    state: text("state").notNull().default("live"), // live | ended
  },
  (t) => ({ byRepo: index("ix_session_repo_state").on(t.projectId, t.repoId, t.state) }),
);

/* ───────────────────────────── Auth ───────────────────────────── */

/* System table (principal-scoped, not org-scoped). */
export const accessTokens = pgTable(
  "access_tokens",
  {
    id: id(),
    principalId: uuid("principal_id").notNull(),
    tokenHash: text("token_hash").notNull(), // sha256, never plaintext
    scopes: text("scopes").array(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revoked: boolean("revoked").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({ byHash: uniqueIndex("uq_token_hash").on(t.tokenHash) }),
);

/* user-to-server GitHub token (identity); installation tokens are minted on demand, not stored.
   System table (principal-scoped). */
export const githubCredentials = pgTable("github_credentials", {
  id: id(),
  principalId: uuid("principal_id").notNull(),
  accessTokenEnc: text("access_token_enc"), // encrypted at rest
  refreshTokenEnc: text("refresh_token_enc"),
  scopes: text("scopes").array(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

/* ───────────────────────────── Audit trail (append-only) ───────────────────────────── */

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id"),
    actorMemberId: uuid("actor_member_id"),
    action: text("action").notNull(), // decision.proposed | contract.verified | inbox.delivered | ...
    entityKind: text("entity_kind"),
    entityId: uuid("entity_id"),
    entityVersion: integer("entity_version"),
    payload: jsonb("payload"),
    createdAt: createdAt(),
  },
  (t) => ({ byEntity: index("ix_audit_entity").on(t.entityKind, t.entityId) }),
);

/* ───────────────────────────── v2 ingestion (human-tool → decision ledger) ───────────────────────────── */

/**
 * A connected human-coordination tool for a project (Slack today; Jira/Notion later). Auth is held by
 * the connector provider (Composio) — we store only the entity + connectedAccountId, never a token.
 */
export const sourceConnections = pgTable(
  "source_connections",
  {
    id: id(),
    orgId: orgId(),
    // #10: connections are ORG-level (connect a workspace once); routing to projects happens per
    // ingest_allowlist row. Legacy rows were NULLed by migration 0006; the column is vestigial.
    projectId: uuid("project_id"),
    tool: text("tool").notNull(), // slack | jira | notion | confluence
    // Opaque Composio userId the OAuth account is keyed by. New connections use the org id; legacy
    // rows keep their old project-id entity so existing OAuth accounts keep resolving (no re-auth).
    entity: text("entity").notNull(),
    connectedAccountId: text("connected_account_id"), // Composio connection id once OAuth completes
    status: text("status").notNull().default("pending"), // pending | active | revoked
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => ({ byOrg: index("ix_source_conn_org").on(t.orgId, t.tool) }),
);

/**
 * The opt-in: nothing is swept unless a source (Slack channel, Jira project, Notion space) is listed
 * here and enabled. This is the trust wedge — allowlisted sources only.
 */
export const ingestAllowlist = pgTable(
  "ingest_allowlist",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    sourceKind: text("source_kind").notNull(), // channel | project | space
    sourceRef: text("source_ref").notNull(), // e.g. Slack channel id C0123
    sourceName: text("source_name"), // human label, e.g. #eng-decisions
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({ uqSource: uniqueIndex("uq_allowlist_conn_source").on(t.connectionId, t.sourceRef) }),
);

/**
 * #6: lazily-populated cache of the CURRENT version's ruleText embedding per decision. Mutable (not
 * append-only); staleness = version < decisions.currentVersion, healed by the sole reader
 * (prepareScopeSimilarity). jsonb float array + TS cosine — deliberately not pgvector: the only
 * comparison is among <10 scope-mates, where an ANN index buys nothing.
 */
export const decisionEmbeddings = pgTable(
  "decision_embeddings",
  {
    id: id(),
    orgId: orgId(),
    decisionId: uuid("decision_id").notNull(),
    version: integer("version").notNull(),
    model: text("model").notNull(),
    embedding: jsonb("embedding").$type<number[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ uqDecision: uniqueIndex("uq_decision_embedding").on(t.decisionId) }),
);

/** Incremental-sweep cursor per allowlisted source (e.g. latest Slack ts seen). */
export const ingestWatermarks = pgTable(
  "ingest_watermarks",
  {
    id: id(),
    orgId: orgId(),
    connectionId: uuid("connection_id").notNull(),
    sourceRef: text("source_ref").notNull(),
    cursor: text("cursor"), // opaque per-connector cursor (Slack: last ts)
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ uqWatermark: uniqueIndex("uq_watermark_conn_source").on(t.connectionId, t.sourceRef) }),
);

/**
 * Idempotency + tuning audit: every conversation unit the funnel sees is hashed here so it is never
 * re-distilled. Stores the outcome (distilled/discarded/proposed) + confidence, not the raw content.
 */
export const ingestArtifacts = pgTable(
  "ingest_artifacts",
  {
    id: id(),
    orgId: orgId(),
    connectionId: uuid("connection_id").notNull(),
    externalId: text("external_id").notNull(), // e.g. Slack channel/threadTs
    contentHash: text("content_hash").notNull(), // sha256 of the unit's content
    status: text("status").notNull(), // discarded | proposed | question
    confidence: integer("confidence"), // 0..100 (integer for simplicity)
    decisionId: uuid("decision_id"), // set when it produced a proposed decision
    createdAt: createdAt(),
  },
  (t) => ({ uqArtifact: uniqueIndex("uq_artifact_conn_ext_hash").on(t.connectionId, t.externalId, t.contentHash) }),
);

/**
 * One decision, many provenances. When the funnel distills a decision that is semantically the same as
 * an existing one (in the same scope) — even from a different tool — we attach a provenance row here
 * instead of minting a duplicate. Each row is one source that evidences the decision.
 */
export const decisionProvenances = pgTable(
  "decision_provenances",
  {
    id: id(),
    orgId: orgId(),
    decisionId: uuid("decision_id").notNull(),
    source: text("source").notNull(), // slack | jira | notion | confluence | agent
    externalId: text("external_id"), // thread/issue/page id
    url: text("url"),
    evidence: jsonb("evidence"), // [{externalId, quote}]
    confidence: integer("confidence"), // 0..100
    // v3 document constraints: pointer to the exact origin location in the source doc, e.g.
    // {type:"notion_block", pageId, blockId, headingPath[], snippet}. Never silently re-pointed —
    // a lost anchor flips anchorStatus, it never guesses a new location.
    anchor: jsonb("anchor"),
    anchorStatus: text("anchor_status").notNull().default("valid"), // valid | reverify | lost
    createdAt: createdAt(),
  },
  (t) => ({
    byDecision: index("ix_provenance_decision").on(t.decisionId),
    uqSource: uniqueIndex("uq_provenance_decision_source").on(t.decisionId, t.source, t.externalId),
  }),
);

/* ───────────────────────────── v2 org graph (impact beyond code surfaces) ───────────────────────────── */

/** Non-code nodes: teams, projects, docs, people, topics — auto-derived from connectors + human fixes. */
export const graphNodes = pgTable(
  "graph_nodes",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    kind: text("kind").notNull(), // team | project | doc | person | topic | surface | capability
    ref: text("ref").notNull(), // stable key within kind (e.g. topic:auth, person:@alice)
    label: text("label"),
    source: text("source").notNull().default("derived"), // derived | manual
    createdAt: createdAt(),
  },
  (t) => ({ uqNode: uniqueIndex("uq_graph_node").on(t.projectId, t.kind, t.ref) }),
);

/** Edges connect nodes (e.g. person → topic they work on; topic → surface it governs). */
export const graphEdges = pgTable(
  "graph_edges",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    fromId: uuid("from_id").notNull(),
    toId: uuid("to_id").notNull(),
    kind: text("kind").notNull().default("relates"), // relates | owns | member | governs
    weight: integer("weight").notNull().default(1),
    source: text("source").notNull().default("derived"),
    // v3: LLM-seeded capability→surface edges land `proposed`; only `confirmed` edges count for
    // briefing scoping and conflict detection. Confirmed by a tech lead or the auto-link path.
    status: text("status").notNull().default("confirmed"), // proposed | confirmed
    createdAt: createdAt(),
  },
  (t) => ({ uqEdge: uniqueIndex("uq_graph_edge").on(t.projectId, t.fromId, t.toId, t.kind) }),
);

/* ───────────────────────────── v3 product layer (PRDs → constraints) ───────────────────────────── */

/**
 * A registered PRD/document Lockstep watches. Exactly one state authority per document, forever:
 * `mirrored` — the source tool owns state; we map its status vocabulary onto the four canonical
 * states via document_state_mappings, read-only. `native` — no structured source state (pasted URL,
 * GDocs); Lockstep hosts the state chip. Canonical lifecycle: draft (ignored entirely) → review
 * (extraction + pre-approval reconciliation; ratification locked) → active (ratification unlocked;
 * drift monitoring) → archived (constraints → stale).
 */
export const sourceDocuments = pgTable(
  "source_documents",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    connectionId: uuid("connection_id"), // null for native docs with no connector
    tool: text("tool").notNull().default("notion"), // notion | confluence | gdocs | jira
    containerRef: text("container_ref"), // Notion database id — state-mapping key
    externalId: text("external_id").notNull(), // page id / file id
    title: text("title"),
    url: text("url"),
    state: text("state").notNull().default("draft"), // draft | review | active | archived
    stateAuthority: text("state_authority").notNull().default("mirrored"), // mirrored | native
    sourceStateValue: text("source_state_value"), // last raw status value seen (mirrored only)
    ownerRef: text("owner_ref"), // source-tool owner hint (Notion person), best-effort
    ownerMemberId: uuid("owner_member_id"), // resolved doc owner — ratification digest recipient
    registeredBy: uuid("registered_by"),
    contentHash: text("content_hash"), // whole-doc hash (of section hashes) for change detection
    forceResync: boolean("force_resync").notNull().default(false),
    digestSeq: integer("digest_seq").notNull().default(0), // per-activation digest dedupe counter
    lastSweptAt: timestamp("last_swept_at", { withTimezone: true }),
    lastExtractedAt: timestamp("last_extracted_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    byProjectState: index("ix_source_doc_project_state").on(t.projectId, t.state),
  }),
);

/**
 * Per-container (Notion database) mapping of the team's status vocabulary onto the four canonical
 * document states. Unmapped values fall back to `unmappedBehavior` (draft = do nothing); a NEW value
 * appearing later is never guessed — it queues in pendingValues for an admin and the doc holds its
 * last-known canonical state until resolved.
 */
export const documentStateMappings = pgTable(
  "document_state_mappings",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    containerRef: text("container_ref").notNull(),
    containerName: text("container_name"),
    statusProperty: text("status_property"), // e.g. "Status" — the Notion property we read
    mapping: jsonb("mapping").notNull().default({}), // {sourceValue: canonicalState}
    unmappedBehavior: text("unmapped_behavior").notNull().default("draft"),
    pendingValues: jsonb("pending_values").notNull().default([]), // [{value, firstSeenAt}]
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => ({ uqContainer: uniqueIndex("uq_state_mapping_conn_container").on(t.connectionId, t.containerRef) }),
);

/**
 * Co-location flag between a product constraint and an engineering decision governing the same
 * surface — "these two things govern the same surface, a human should look", never a semantic
 * contradiction claim. kind=pre_approval: constraintDecisionId is the just-filed candidate and
 * engDecisionId the existing binding decision it collides with. kind=drift (Phase C): a newly
 * binding engineering decision (candidateDecisionId) lands on an active constraint's surface.
 */
export const conflicts = pgTable(
  "conflicts",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    constraintDecisionId: uuid("constraint_decision_id").notNull(),
    engDecisionId: uuid("eng_decision_id"),
    candidateDecisionId: uuid("candidate_decision_id"), // Phase C drift only
    surface: text("surface").notNull(),
    kind: text("kind").notNull(), // pre_approval | drift
    status: text("status").notNull().default("open"), // open | resolved_eng_revised | resolved_prd_amended | dismissed
    dismissReason: text("dismiss_reason"),
    writeBackRef: text("write_back_ref"), // source-tool comment id once posted
    openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by"),
    createdAt: createdAt(),
  },
  (t) => ({
    byStatusProject: index("ix_conflicts_status_project").on(t.status, t.projectId),
    bySurfaceStatus: index("ix_conflicts_surface_status").on(t.surface, t.status),
    uqPair: uniqueIndex("uq_conflict_pair").on(t.constraintDecisionId, t.engDecisionId, t.kind),
  }),
);

/**
 * Outbound write-back queue. Core composes payloads (it stays LLM-free and never calls Composio or
 * Slack for delivery); the ingest worker drains queued rows and posts them — Notion conflict comments
 * and Slack ratification digests. dedupeKey gives exactly-once per logical event.
 */
export const writebacks = pgTable(
  "writebacks",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    connectionId: uuid("connection_id"), // null for slack_digest (first-party bot token)
    tool: text("tool").notNull(), // notion | slack
    kind: text("kind").notNull(), // conflict_comment | slack_digest
    targetRef: text("target_ref").notNull(), // Notion page id / Slack user id
    payload: jsonb("payload").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull().default("queued"), // queued | posted | failed
    attempts: integer("attempts").notNull().default(0),
    resultRef: text("result_ref"), // comment id / message ts once posted
    postedAt: timestamp("posted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    uqDedupe: uniqueIndex("uq_writeback_dedupe").on(t.dedupeKey),
    byStatus: index("ix_writebacks_status").on(t.status),
  }),
);

/**
 * Slack Events ingress queue (gateway). Core stores only REFS — channel, ts, thread key — never
 * message text; the worker re-fetches the thread via the connector so unit granularity (and the
 * ingest_artifacts contentHash barrier) matches sweeps exactly. The REAL dedupe is a partial unique
 * index in SQL (0008): (connection_id, thread_key) WHERE status IN ('queued','processing') — Drizzle
 * can't express partials, so only the plain lookup index is modeled here.
 */
export const ingestEvents = pgTable(
  "ingest_events",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    sourceRef: text("source_ref").notNull(), // Slack channel id
    threadKey: text("thread_key").notNull(), // `${channel}/${thread_ts ?? ts}` — the sweep's unit key
    latestEventTs: text("latest_event_ts").notNull(), // newest Slack ts seen for this unit
    status: text("status").notNull().default("queued"), // queued | processing | done | failed
    attempts: integer("attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: createdAt(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({
    byStatus: index("ix_ingest_events_status").on(t.status, t.createdAt),
  }),
);

/**
 * Persistent scheduler (gateway). SYSTEM table — jobs are cross-org (each kind runs withSystem and
 * iterates orgs, like expiry/digests already do), so it carries the system-only RLS policy, not
 * org isolation. Mutable: the worker claims due rows with a lease (locked_until) and reschedules
 * run_at by interval_seconds on completion.
 */
export const scheduledJobs = pgTable(
  "scheduled_jobs",
  {
    id: id(),
    kind: text("kind").notNull(), // expiry | weekly_digest | writeback_drain
    singletonKey: text("singleton_key").notNull(),
    runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
    intervalSeconds: integer("interval_seconds"), // null = one-shot
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    uqSingleton: uniqueIndex("uq_scheduled_job_singleton").on(t.singletonKey),
  }),
);
