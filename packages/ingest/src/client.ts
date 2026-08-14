/** Thin authed HTTP client to core's /ingest/* and /internal/* worker endpoints (service-token auth). */

import type { ProposedDocItem } from "./docFunnel.js";

export interface WorkSource {
  sourceRef: string;
  sourceName: string | null;
  cursor: string | null;
  /** #10: routing lives on the allowlist row — each source names the project its decisions file into. */
  projectId: string;
}
export interface WorkItem {
  orgId: string;
  /** @deprecated #10: connections are org-level; route per WorkSource.projectId. */
  projectId: string;
  connectionId: string;
  tool: string;
  entity: string;
  connectedAccountId: string | null;
  sources: WorkSource[];
}

export interface ProposedItem {
  orgId: string;
  projectId: string;
  scopeKind: string;
  scopeRef: string;
  ruleText: string;
  decisionType?: string;
  provenance: unknown;
  connectionId: string;
  externalId: string;
  contentHash: string;
  confidence?: number; // 0..100
  // Phase J deliberation fields — first-class on the ledger (also kept in the provenance blob).
  rationale?: string;
  alternatives?: string[];
  reviewAt?: string | null; // ISO; parsed from review_hint when calendar-anchored
}

/* ── v3 document layer (core's /internal/documents + /internal/writebacks) ── */

export interface DocWorkItem {
  orgId: string;
  /** @deprecated #10: connections are org-level; containers/docs carry their own projectId. */
  projectId: string;
  connectionId: string;
  tool: string;
  entity: string;
  connectedAccountId: string | null;
  containers: Array<{ containerRef: string; containerName: string | null; statusProperty: string | null; projectId?: string }>;
  /** Standalone/native docs (registered by URL, not swept from a database) that need extraction.
   *  `tool` selects the doc connector per doc (e.g. "gdocs" vs "notion"); absent ⇒ the connection's tool. */
  docs: Array<{ docId: string; externalId: string; state: string; knownSectionHashes: string[]; tool?: string; projectId?: string }>;
}

/** Raw listing-level doc facts from the sweep — core owns state resolution, never the worker (D4). */
export interface SweptDoc {
  externalId: string;
  containerRef: string;
  title: string | null;
  url: string | null;
  rawStateValue: string | null;
  ownerRef: string | null;
  lastEditedTime: string | null;
}

export interface SweepDirective {
  docId: string;
  externalId: string;
  state: string;
  shouldExtract: boolean;
  knownSectionHashes: string[];
}

export interface PendingWriteback {
  id: string;
  orgId: string;
  tool: "notion" | "slack";
  kind: "conflict_comment" | "slack_digest" | "drift_alert" | "weekly_digest";
  targetRef: string; // notion page id (conflict_comment) or Slack user id (slack_digest / drift_alert)
  payload: unknown;
  connection: { entity: string; connectedAccountId: string | null; tool: string } | null;
}

export class LockstepClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        // Only advertise a JSON body when we actually send one — Fastify 400s on an empty body
        // with content-type: application/json (bit the bodyless /internal/expiry|digests calls).
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-lockstep-ingest-token": this.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async getWork(): Promise<WorkItem[]> {
    const r = await this.req<{ work: WorkItem[] }>("GET", "/ingest/work");
    return r.work;
  }

  async postProposed(items: ProposedItem[]): Promise<{ filed: number; deduped: number }> {
    if (items.length === 0) return { filed: 0, deduped: 0 };
    return this.req("POST", "/ingest/proposed-decisions", { items });
  }

  async setWatermark(orgId: string, connectionId: string, sourceRef: string, cursor: string): Promise<void> {
    await this.req("POST", "/ingest/watermark", { orgId, connectionId, sourceRef, cursor });
  }

  async finalizeConnection(connectionId: string, connectedAccountId: string): Promise<void> {
    await this.req("POST", `/ingest/connections/${connectionId}/finalize`, { connectedAccountId });
  }

  async reconcileSlackMembers(
    orgId: string,
    users: Array<{ slackUserId: string; email: string | null }>,
  ): Promise<{ matched: number }> {
    if (users.length === 0) return { matched: 0 };
    return this.req("POST", "/internal/slack/reconcile-members", { orgId, users });
  }

  /* ── v3 document layer ── */

  async getDocumentWork(): Promise<DocWorkItem[]> {
    const r = await this.req<{ work: DocWorkItem[] }>("GET", "/internal/documents/work");
    return r.work;
  }

  async upsertDocuments(connectionId: string, docs: SweptDoc[]): Promise<SweepDirective[]> {
    if (docs.length === 0) return [];
    const r = await this.req<{ results: SweepDirective[] }>("POST", "/internal/documents/upsert", {
      connectionId,
      docs,
    });
    return r.results;
  }

  async postDocCandidates(
    docId: string,
    items: ProposedDocItem[],
    docContentHash?: string,
    extractedAnchorKeys?: string[],
    currentSections?: Array<{ anchorKey: string; headingPath: string[]; snippet: string }>,
  ): Promise<{ filed: number; fused: number; deduped: number; reversioned: number; staled: number; conflicts: number }> {
    return this.req("POST", `/internal/documents/${docId}/candidates`, {
      items,
      docContentHash,
      extractedAnchorKeys,
      currentSections,
    });
  }

  async getPendingWritebacks(): Promise<PendingWriteback[]> {
    const r = await this.req<{ writebacks: PendingWriteback[] }>("GET", "/internal/writebacks/pending");
    return r.writebacks;
  }

  async markWritebackDone(id: string, ok: boolean, resultRef?: string): Promise<void> {
    await this.req("POST", `/internal/writebacks/${id}/done`, { ok, resultRef });
  }

  /** Expire past-due launch gates (FR-CORE-11) — executed via the `expiry` scheduled job. */
  async runExpiry(): Promise<{ expired: number; conflictsDismissed: number }> {
    return this.req("POST", "/internal/expiry/run");
  }

  /** Enqueue weekly operator digests (idempotent per ISO week) — via the `weekly_digest` job. */
  async runWeeklyDigests(): Promise<{ enqueued: number }> {
    return this.req("POST", "/internal/digests/weekly/run");
  }

  /* ── gateway: Slack event drain + scheduled jobs (the fast loop) ── */

  async getPendingEvents(): Promise<PendingEventBatch[]> {
    const r = await this.req<{ batches: PendingEventBatch[] }>("GET", "/ingest/events/pending");
    return r.batches;
  }

  async markEventsDone(ids: string[], ok: boolean): Promise<void> {
    if (ids.length === 0) return;
    await this.req("POST", "/ingest/events/done", { ids, ok });
  }

  async claimJobs(): Promise<Array<{ id: string; kind: string }>> {
    const r = await this.req<{ jobs: Array<{ id: string; kind: string }> }>("POST", "/internal/jobs/claim");
    return r.jobs;
  }

  async completeJob(id: string, ok: boolean, error?: string): Promise<void> {
    await this.req("POST", `/internal/jobs/${id}/complete`, { ok, error });
  }
}

export interface PendingEventBatch {
  orgId: string;
  connectionId: string;
  tool: string;
  entity: string;
  connectedAccountId: string | null;
  events: Array<{ id: string; projectId: string; sourceRef: string; threadKey: string; threadTs: string }>;
}
