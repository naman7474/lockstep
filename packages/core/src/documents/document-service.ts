import { and, eq, like, inArray } from "drizzle-orm";
import { withOrg, withSystem, type Tx } from "../db/rls.js";
import {
  sourceDocuments,
  documentStateMappings,
  sourceConnections,
  ingestAllowlist,
  ingestArtifacts,
  decisions,
  decisionVersions,
  decisionProvenances,
  conflicts,
  writebacks,
  members,
  projects,
} from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";
import { fileProposedDecision, reproposeDocConstraint, similar } from "../ledger/ledger-service.js";
import { getProjectRoleTx, canManageDocTx, projectArchived } from "../auth/permissions.js";
import { reconcileCandidateTx, type DocForReconcile } from "./reconcile-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

function notFound(what: string): Error {
  return Object.assign(new Error(`${what} not found`), { statusCode: 404 });
}

export const CANONICAL_STATES = ["draft", "review", "active", "archived"] as const;
export type CanonicalState = (typeof CANONICAL_STATES)[number];

/** Per-project feature gate: the whole product layer ships behind projects.settings.productLayer.enabled. */
export function productLayerEnabled(settings: unknown): boolean {
  const s = settings as { productLayer?: { enabled?: boolean } } | null;
  return Boolean(s?.productLayer?.enabled);
}

/** GDocs support is a per-project sub-flag of the product layer (default off). */
export function gdocsEnabled(settings: unknown): boolean {
  const s = settings as { productLayer?: { gdocs?: boolean } } | null;
  return Boolean(s?.productLayer?.gdocs);
}

/** Confluence support is a per-project sub-flag of the product layer (default off). */
export function confluenceEnabled(settings: unknown): boolean {
  const s = settings as { productLayer?: { confluence?: boolean } } | null;
  return Boolean(s?.productLayer?.confluence);
}

/** Min interval between GDocs re-fetches (revision-watch debounce, FR-ING-6). Default 600s. */
const GDOCS_DEBOUNCE_MS = (Number(process.env.LOCKSTEP_GDOCS_DEBOUNCE) || 600) * 1000;

/**
 * Notion page ids appear as dashed UUIDs (API) and bare 32-hex tails (page URLs). Normalize both to
 * the dashed form so a URL-registered page and the same page seen by the sweep are one document.
 */
export function parseNotionPageId(urlOrId: string): string | null {
  const dashed = urlOrId.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  if (dashed) return dashed.toLowerCase();
  const h = urlOrId.replace(/[?#].*$/, "").match(/([0-9a-f]{32})(?:$|\/)/i)?.[1]?.toLowerCase();
  if (!h) return null;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Google Docs file id from a docs.google.com/document/d/<id>/… URL (or a bare Drive file id). */
export function parseGDocsFileId(urlOrId: string): string | null {
  const m = urlOrId.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{20,})/)?.[1];
  if (m) return m;
  // A bare Drive file id (no dashes/dots, ≥25 chars) — distinct from a Notion 32-hex tail.
  if (/^[a-zA-Z0-9_-]{25,}$/.test(urlOrId.trim()) && !/^[0-9a-f]{32}$/i.test(urlOrId.trim())) return urlOrId.trim();
  return null;
}

/**
 * Confluence page id from a Cloud page URL: /wiki/spaces/<key>/pages/<numeric id>/… . Legacy
 * /display/<space>/<title> URLs carry no id in the path → null (register by the /pages/ URL instead).
 */
export function parseConfluencePageId(urlOrId: string): string | null {
  return urlOrId.match(/\/wiki\/spaces\/[^/]+\/pages\/(\d+)/)?.[1] ?? null;
}

/** Detect the source tool + external id from a pasted registration URL. */
export function detectDocTool(url: string): { tool: "notion" | "gdocs" | "confluence"; externalId: string } | null {
  if (/docs\.google\.com/.test(url)) {
    const id = parseGDocsFileId(url);
    return id ? { tool: "gdocs", externalId: id } : null;
  }
  // Confluence before the Notion/GDocs fallbacks — its numeric ids never look like a Notion 32-hex tail.
  if (/atlassian\.net/.test(url) || /\/wiki\//.test(url)) {
    const id = parseConfluencePageId(url);
    return id ? { tool: "confluence", externalId: id } : null;
  }
  const notion = parseNotionPageId(url);
  if (notion) return { tool: "notion", externalId: notion };
  const gdoc = parseGDocsFileId(url);
  return gdoc ? { tool: "gdocs", externalId: gdoc } : null;
}

/** Notion deep link to a block: page url + #<block id without dashes>. */
function anchorUrl(docUrl: string | null, blockId: string | null | undefined): string | null {
  if (!docUrl || !blockId) return docUrl;
  return `${docUrl}#${blockId.replace(/-/g, "")}`;
}

/* ───────────────────────────── Registration & lifecycle ───────────────────────────── */

/**
 * Register a document by pasted URL (native mode: no structured source state, Lockstep hosts the
 * state chip). Native registration IS the review signal — the doc starts at `review` (extraction can
 * run; ratification stays locked until the registrant flips it to `active`). Mirrored docs are
 * registered by the sweep, never here.
 */
export async function registerDocument(
  orgId: string,
  input: { projectId: string; memberId: string; url: string },
): Promise<{ documentId: string; externalId: string; state: string }> {
  const detected = detectDocTool(input.url);
  if (!detected) throw Object.assign(new Error("could not parse a Notion page or Google Docs id from url"), { statusCode: 400 });
  const { tool, externalId } = detected;
  return withOrg(orgId, async (tx) => {
    // Attach the ORG's connection for that tool when one exists so content can be fetched (#10:
    // connections are org-level; prefer an active one). Side benefit: native docs in projects that
    // never connected the tool themselves now resolve the org connection.
    const conns = await tx
      .select()
      .from(sourceConnections)
      .where(and(eq(sourceConnections.orgId, orgId), eq(sourceConnections.tool, tool)));
    const conn = conns.find((c) => c.status === "active") ?? conns[0];
    const existing = (
      await tx
        .select()
        .from(sourceDocuments)
        .where(and(eq(sourceDocuments.projectId, input.projectId), eq(sourceDocuments.externalId, externalId)))
        .limit(1)
    )[0];
    if (existing) return { documentId: existing.id, externalId, state: existing.state };
    const d = one(
      await tx
        .insert(sourceDocuments)
        .values({
          orgId,
          projectId: input.projectId,
          connectionId: conn?.id ?? null,
          tool,
          externalId,
          url: input.url,
          state: "review",
          stateAuthority: "native",
          registeredBy: input.memberId,
        })
        .returning(),
    );
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "document.registered",
      entityKind: "document",
      entityId: d.id,
      payload: { externalId, tool, stateAuthority: "native" },
    });
    return { documentId: d.id, externalId, state: d.state };
  });
}

/**
 * Flip a native doc's canonical state. Mirrored docs are managed in the source tool — one state
 * authority per document, forever; the escape hatch is unregistering, not overriding.
 */
export async function setDocumentState(
  orgId: string,
  docId: string,
  memberId: string,
  state: string,
): Promise<{ state: string }> {
  if (!CANONICAL_STATES.includes(state as CanonicalState))
    throw Object.assign(new Error(`invalid state: ${state}`), { statusCode: 400 });
  return withOrg(orgId, async (tx) => {
    const doc = (await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, docId)).limit(1))[0];
    if (!doc) throw notFound("document");
    if (!(await canManageDocTx(tx, { projectId: doc.projectId, memberId, doc })))
      throw Object.assign(new Error("insufficient_permission"), { statusCode: 403, code: "insufficient_permission" });
    if (doc.stateAuthority !== "native")
      throw Object.assign(new Error("state_authority_mirrored"), { statusCode: 403, code: "state_authority_mirrored" });
    if (doc.state === state) return { state };
    const becameActive = state === "active" && doc.state !== "active";
    const digestSeq = becameActive ? doc.digestSeq + 1 : doc.digestSeq;
    await tx
      .update(sourceDocuments)
      .set({ state, digestSeq, updatedAt: new Date() })
      .where(eq(sourceDocuments.id, docId));
    await writeAudit(tx, {
      orgId,
      projectId: doc.projectId,
      actorMemberId: memberId,
      action: "document.state_changed",
      entityKind: "document",
      entityId: docId,
      payload: { from: doc.state, to: state, source: "native" },
    });
    if (state === "archived") await staleConstraintsTx(tx, orgId, doc);
    if (becameActive) await enqueueDigestTx(tx, orgId, { ...doc, state, digestSeq });
    return { state };
  });
}

/** Force the next sweep to re-fetch + re-extract this doc (unchanged sections still dedupe). */
export async function requestResync(orgId: string, docId: string, memberId: string): Promise<{ ok: boolean }> {
  return withOrg(orgId, async (tx) => {
    const doc = (await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, docId)).limit(1))[0];
    if (!doc) throw notFound("document");
    if (!(await canManageDocTx(tx, { projectId: doc.projectId, memberId, doc })))
      throw Object.assign(new Error("insufficient_permission"), { statusCode: 403, code: "insufficient_permission" });
    await tx
      .update(sourceDocuments)
      .set({ forceResync: true, updatedAt: new Date() })
      .where(eq(sourceDocuments.id, docId));
    await writeAudit(tx, {
      orgId,
      projectId: doc.projectId,
      actorMemberId: memberId,
      action: "document.resync_requested",
      entityKind: "document",
      entityId: docId,
    });
    return { ok: true };
  });
}

/**
 * Unregister a document — the escape hatch (§21). Its live constraints go `stale`, open conflicts
 * auto-dismiss, and the source row is removed so it stops being swept. Constraints stay in history.
 */
export async function unregisterDocument(orgId: string, docId: string, memberId: string): Promise<{ ok: boolean }> {
  return withOrg(orgId, async (tx) => {
    const doc = (await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, docId)).limit(1))[0];
    if (!doc) throw notFound("document");
    if (!(await canManageDocTx(tx, { projectId: doc.projectId, memberId, doc })))
      throw Object.assign(new Error("insufficient_permission"), { statusCode: 403, code: "insufficient_permission" });
    await staleConstraintsTx(tx, orgId, doc);
    await tx.delete(sourceDocuments).where(eq(sourceDocuments.id, docId));
    await writeAudit(tx, {
      orgId,
      projectId: doc.projectId,
      actorMemberId: memberId,
      action: "document.unregistered",
      entityKind: "document",
      entityId: docId,
      payload: { externalId: doc.externalId, tool: doc.tool },
    });
    return { ok: true };
  });
}

/** Archiving a doc retires its constraints: binding/proposed → stale, open conflicts auto-dismiss. */
async function staleConstraintsTx(
  tx: Tx,
  orgId: string,
  doc: { id: string; projectId: string; connectionId: string | null; externalId: string; tool: string },
): Promise<void> {
  const rows = await constraintsForDocTx(tx, doc);
  for (const r of rows) {
    if (r.decision.status !== "binding" && r.decision.status !== "proposed") continue;
    await tx.update(decisions).set({ status: "stale" }).where(eq(decisions.id, r.decision.id));
    await tx
      .update(conflicts)
      .set({ status: "dismissed", dismissReason: "source_archived", resolvedAt: new Date() })
      .where(and(eq(conflicts.constraintDecisionId, r.decision.id), eq(conflicts.status, "open")));
  }
}

/* ───────────────────────────── Sweep (worker) paths ───────────────────────────── */

export interface DocWorkItem {
  orgId: string;
  /** @deprecated #10: route per container/doc projectId. First live project, for old workers. */
  projectId: string;
  connectionId: string;
  tool: string;
  entity: string;
  connectedAccountId: string | null;
  containers: Array<{
    containerRef: string;
    containerName: string | null;
    statusProperty: string | null;
    /** #10: the allowlist row's project — where this database's constraints file. */
    projectId: string;
  }>;
  // Native/standalone docs (registered by URL, not living in a swept database) that need extraction.
  // `tool` lets the worker pick the connector per doc (notion vs gdocs).
  docs: Array<{ docId: string; externalId: string; tool: string; state: string; knownSectionHashes: string[]; projectId: string }>;
}

/**
 * Cross-org enumeration of document-sweep work: active Notion connections whose project has the
 * product layer enabled, with their allowlisted PRD databases (sourceKind=database — the same trust
 * wedge as conversations: nothing is swept unless allowlisted) + state-mapping config.
 */
export async function getDocumentWork(): Promise<DocWorkItem[]> {
  return withSystem(async (tx) => {
    const conns = await tx
      .select()
      .from(sourceConnections)
      .where(and(eq(sourceConnections.status, "active"), inArray(sourceConnections.tool, ["notion", "gdocs", "confluence"])));
    const items: DocWorkItem[] = [];
    for (const c of conns) {
      const allow = await tx
        .select()
        .from(ingestAllowlist)
        .where(
          and(
            eq(ingestAllowlist.connectionId, c.id),
            eq(ingestAllowlist.enabled, true),
            eq(ingestAllowlist.sourceKind, "database"),
          ),
        );
      const mappings = await tx
        .select()
        .from(documentStateMappings)
        .where(eq(documentStateMappings.connectionId, c.id));
      const mapFor = (ref: string) => mappings.find((m) => m.containerRef === ref);
      // Standalone (native) docs served by THIS connection (scoped by connectionId so a gdocs doc
      // rides the gdocs connection's work item — the sweep picks the connector per doc.tool).
      const standalone = await tx
        .select()
        .from(sourceDocuments)
        .where(and(eq(sourceDocuments.connectionId, c.id), eq(sourceDocuments.stateAuthority, "native")));

      // #10: the connection is org-level — flag-gate (product layer, tool sub-flags, archived) PER
      // PROJECT, resolved from each allowlist row / doc row, not from the connection.
      const projIds = [...new Set([...allow.map((a) => a.projectId), ...standalone.map((d) => d.projectId)])];
      if (projIds.length === 0) continue;
      const projRows = await tx.select().from(projects).where(inArray(projects.id, projIds));
      const projectOk = (pid: string): boolean => {
        const p = projRows.find((r) => r.id === pid);
        if (!p || !productLayerEnabled(p.settings) || projectArchived(p.settings)) return false;
        if (c.tool === "gdocs" && !gdocsEnabled(p.settings)) return false;
        if (c.tool === "confluence" && !confluenceEnabled(p.settings)) return false;
        return true;
      };
      const liveAllow = allow.filter((a) => projectOk(a.projectId));

      const docs: DocWorkItem["docs"] = [];
      const now = Date.now();
      for (const d of standalone) {
        if (!projectOk(d.projectId)) continue;
        if (d.state !== "review" && d.state !== "active") continue;
        // GDocs and Confluence are revision-watched: re-fetch on each window (per-section hashes skip
        // unchanged), bounded by the debounce. Notion native docs are resync-driven (Phase A).
        const revisionWatched = d.tool === "gdocs" || d.tool === "confluence";
        if (revisionWatched) {
          if (!d.forceResync && d.lastSweptAt && now - d.lastSweptAt.getTime() < GDOCS_DEBOUNCE_MS) continue;
        } else if (!d.forceResync && d.lastExtractedAt) {
          continue;
        }
        docs.push({
          docId: d.id,
          externalId: d.externalId,
          tool: d.tool,
          state: d.state,
          knownSectionHashes: await sectionHashesTx(tx, d),
          projectId: d.projectId,
        });
        // Claim it for this window so the debounce holds even if extraction yields nothing.
        if (revisionWatched) await tx.update(sourceDocuments).set({ lastSweptAt: new Date() }).where(eq(sourceDocuments.id, d.id));
      }
      if (liveAllow.length === 0 && docs.length === 0) continue;
      items.push({
        orgId: c.orgId,
        projectId: liveAllow[0]?.projectId ?? docs[0]!.projectId, // deprecated compat — see DocWorkItem
        connectionId: c.id,
        tool: c.tool,
        entity: c.entity,
        connectedAccountId: c.connectedAccountId,
        containers: liveAllow.map((a) => ({
          containerRef: a.sourceRef,
          containerName: a.sourceName,
          statusProperty: mapFor(a.sourceRef)?.statusProperty ?? null,
          projectId: a.projectId,
        })),
        docs,
      });
    }
    return items;
  });
}

/** All section content hashes already seen for a doc — the worker skips those sections' LLM calls. */
async function sectionHashesTx(
  tx: Tx,
  doc: { id: string; connectionId: string | null; externalId: string },
): Promise<string[]> {
  const rows = await tx
    .select({ hash: ingestArtifacts.contentHash })
    .from(ingestArtifacts)
    .where(
      and(
        // Native docs with no connection use the doc id as the idempotency scope (see fileDocCandidates).
        eq(ingestArtifacts.connectionId, doc.connectionId ?? doc.id),
        like(ingestArtifacts.externalId, `${doc.externalId}#%`),
      ),
    );
  return [...new Set(rows.map((r) => r.hash))];
}

export interface SweptDoc {
  externalId: string;
  containerRef: string;
  title: string | null;
  url: string | null;
  rawStateValue: string | null;
  ownerRef: string | null; // Notion created_by email when available
  lastEditedTime: string | null;
}

export interface SweepDirective {
  docId: string;
  externalId: string;
  state: string;
  shouldExtract: boolean;
  knownSectionHashes: string[];
}

/**
 * The sweep reports raw documents; CORE owns state resolution (the mapping config lives here, and
 * "never guess a new value" must be enforced in one place). Detects state transitions, queues
 * unmapped values, and returns per-doc extraction directives.
 */
export async function upsertDocumentsFromSweep(connectionId: string, docs: SweptDoc[]): Promise<SweepDirective[]> {
  return withSystem(async (tx) => {
    const conn = (await tx.select().from(sourceConnections).where(eq(sourceConnections.id, connectionId)).limit(1))[0];
    if (!conn) throw notFound("connection");
    const orgId = conn.orgId;
    const mappings = await tx
      .select()
      .from(documentStateMappings)
      .where(eq(documentStateMappings.connectionId, connectionId));
    // #10: the connection is org-level — a NEW mirrored doc's project comes from the allowlist row
    // that routed its container. Fail-closed: no allowlist row → skip the doc (log), never guess.
    const allowRows = await tx
      .select()
      .from(ingestAllowlist)
      .where(eq(ingestAllowlist.connectionId, connectionId));
    const projectFor = (containerRef: string | null): string | null =>
      (containerRef && allowRows.find((a) => a.sourceRef === containerRef)?.projectId) || null;
    const out: SweepDirective[] = [];
    for (const d of docs) {
      const mapping = mappings.find((m) => m.containerRef === d.containerRef);
      // Resolve raw source value → canonical state. No mapping row / no status property / unmapped
      // value ⇒ undefined: a new doc defaults to draft (safe: do nothing), an existing doc HOLDS its
      // last-known state — never guess.
      let canonical: CanonicalState | undefined;
      if (mapping && d.rawStateValue != null) {
        const m = (mapping.mapping ?? {}) as Record<string, string>;
        const mapped = m[d.rawStateValue];
        if (mapped && CANONICAL_STATES.includes(mapped as CanonicalState)) {
          canonical = mapped as CanonicalState;
        } else {
          await queuePendingValueTx(tx, orgId, mapping, d.rawStateValue);
        }
      }

      const existing = (
        await tx
          .select()
          .from(sourceDocuments)
          .where(and(eq(sourceDocuments.connectionId, connectionId), eq(sourceDocuments.externalId, d.externalId)))
          .limit(1)
      )[0];

      // Resolve the doc owner (digest recipient) from the source-tool owner hint when it is an email.
      let ownerMemberId = existing?.ownerMemberId ?? null;
      if (!ownerMemberId && d.ownerRef && d.ownerRef.includes("@")) {
        const m = (
          await tx
            .select()
            .from(members)
            .where(and(eq(members.orgId, orgId), eq(members.email, d.ownerRef)))
            .limit(1)
        )[0];
        ownerMemberId = m?.id ?? null;
      }

      const now = new Date();
      let doc: typeof sourceDocuments.$inferSelect;
      let stateChanged: boolean;
      let becameActive: boolean;
      if (!existing) {
        const routedProject = projectFor(d.containerRef);
        if (!routedProject) {
          console.warn(`[sweep] doc ${d.externalId} in unrouted container ${d.containerRef ?? "?"} — skipped`);
          continue;
        }
        const state: CanonicalState = canonical ?? "draft";
        doc = one(
          await tx
            .insert(sourceDocuments)
            .values({
              orgId,
              projectId: routedProject,
              connectionId,
              tool: conn.tool,
              containerRef: d.containerRef,
              externalId: d.externalId,
              title: d.title,
              url: d.url,
              state,
              stateAuthority: "mirrored",
              sourceStateValue: d.rawStateValue,
              ownerRef: d.ownerRef,
              ownerMemberId,
              digestSeq: state === "active" ? 1 : 0,
              lastSweptAt: now,
            })
            .returning(),
        );
        stateChanged = state !== "draft";
        becameActive = state === "active";
        await writeAudit(tx, {
          orgId,
          projectId: doc.projectId,
          action: "document.registered",
          entityKind: "document",
          entityId: doc.id,
          payload: { externalId: d.externalId, containerRef: d.containerRef, state, stateAuthority: "mirrored" },
        });
      } else {
        const nextState = (canonical ?? existing.state) as CanonicalState;
        stateChanged = nextState !== existing.state;
        becameActive = stateChanged && nextState === "active";
        doc = one(
          await tx
            .update(sourceDocuments)
            .set({
              title: d.title ?? existing.title,
              url: d.url ?? existing.url,
              state: nextState,
              sourceStateValue: d.rawStateValue,
              ownerRef: d.ownerRef ?? existing.ownerRef,
              ownerMemberId,
              digestSeq: becameActive ? existing.digestSeq + 1 : existing.digestSeq,
              lastSweptAt: now,
              updatedAt: stateChanged ? now : existing.updatedAt,
            })
            .where(eq(sourceDocuments.id, existing.id))
            .returning(),
        );
        if (stateChanged) {
          await writeAudit(tx, {
            orgId,
            projectId: doc.projectId,
            action: "document.state_changed",
            entityKind: "document",
            entityId: doc.id,
            payload: { from: existing.state, to: nextState, source: "mirrored", rawValue: d.rawStateValue },
          });
          if (nextState === "archived") await staleConstraintsTx(tx, orgId, doc);
        }
      }

      const extractable = doc.state === "review" || doc.state === "active";
      const editedSinceExtract =
        !doc.lastExtractedAt || (d.lastEditedTime ? new Date(d.lastEditedTime) > doc.lastExtractedAt : false);
      const shouldExtract =
        extractable && (!existing || stateChanged || doc.forceResync || editedSinceExtract);
      if (doc.forceResync && shouldExtract) {
        await tx.update(sourceDocuments).set({ forceResync: false }).where(eq(sourceDocuments.id, doc.id));
      }
      if (becameActive) await enqueueDigestTx(tx, orgId, doc);
      out.push({
        docId: doc.id,
        externalId: doc.externalId,
        state: doc.state,
        shouldExtract,
        knownSectionHashes: shouldExtract ? await sectionHashesTx(tx, doc) : [],
      });
    }
    return out;
  });
}

/** Dedupe-append a never-before-seen status value for admin mapping. Never guessed, never dropped. */
async function queuePendingValueTx(
  tx: Tx,
  orgId: string,
  mapping: typeof documentStateMappings.$inferSelect,
  value: string,
): Promise<void> {
  const pending = ((mapping.pendingValues ?? []) as Array<{ value: string; firstSeenAt: string }>).slice();
  if (pending.some((p) => p.value === value)) return;
  pending.push({ value, firstSeenAt: new Date().toISOString() });
  await tx.update(documentStateMappings).set({ pendingValues: pending }).where(eq(documentStateMappings.id, mapping.id));
  mapping.pendingValues = pending; // keep the in-memory row current for subsequent docs in this sweep
  await writeAudit(tx, {
    orgId,
    projectId: mapping.projectId,
    action: "mapping.pending_value",
    entityKind: "state_mapping",
    entityId: mapping.id,
    payload: { containerRef: mapping.containerRef, value },
  });
}

/* ───────────────────────────── Candidate filing ───────────────────────────── */

export interface DocCandidateItem {
  scopeKind: string;
  scopeRef: string;
  ruleText: string;
  constraintKind: string;
  expiresAt: string | null;
  expiresHint: string;
  lowConfidence: boolean;
  confidence: number; // 0..100
  externalId: string; // `${docExternalId}#${anchorKey}`
  contentHash: string;
  anchor: { type: string; pageId: string; blockId: string; headingPath: string[]; snippet: string };
  evidence: Array<{ externalId: string; quote: string }>;
  rationale: string;
  surfaceCandidates?: string[]; // canonicalized surfaces the extraction named — seed proposed governs edges at ratify
}

/**
 * File extracted constraints for a doc: proposed decisions (origin=document, idempotent per section
 * content hash) → pre-approval reconciliation per fresh filing → digest if the doc is already active.
 */
export interface CurrentSection {
  anchorKey: string;
  headingPath: string[];
  snippet: string;
}

export async function fileDocCandidates(
  docId: string,
  items: DocCandidateItem[],
  docContentHash?: string,
  extractedAnchorKeys?: string[],
  currentSections?: CurrentSection[],
): Promise<{ filed: number; fused: number; deduped: number; reversioned: number; staled: number; conflicts: number; reverified: number }> {
  const doc = await withSystem(async (tx) => {
    return (await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, docId)).limit(1))[0];
  });
  if (!doc) throw notFound("document");
  if (doc.state !== "review" && doc.state !== "active")
    throw Object.assign(new Error(`document is ${doc.state}; candidates are filed at review/active only`), {
      statusCode: 409,
    });

  const docRef: DocForReconcile = {
    id: doc.id,
    projectId: doc.projectId,
    connectionId: doc.connectionId,
    externalId: doc.externalId,
    url: doc.url,
    title: doc.title,
  };
  // Existing document constraints for this doc, keyed by anchor — so an edited section RE-VERSIONS its
  // constraint (re-enters ratification) instead of minting a duplicate (F10 re-extraction diff).
  const existingByAnchor = await withOrg(doc.orgId, async (tx) => {
    const rows = await constraintsForDocTx(tx, doc);
    const m = new Map<string, { decisionId: string; ruleText: string; status: string }>();
    for (const r of rows) {
      const anchorKey = (r.provenance.anchorKey as string | undefined) ?? (r.provRow?.anchor as { blockId?: string } | null)?.blockId;
      if (!anchorKey) continue;
      const prev = m.get(anchorKey);
      // Prefer a live (non-rejected/stale) decision if duplicates exist from the pre-Phase-C bug.
      const live = r.decision.status !== "rejected" && r.decision.status !== "stale" && r.decision.status !== "superseded";
      if (!prev || live) m.set(anchorKey, { decisionId: r.decision.id, ruleText: r.ruleText, status: r.decision.status });
    }
    return m;
  });

  let filed = 0;
  let fused = 0;
  let deduped = 0;
  let reversioned = 0;
  let staled = 0;
  let opened = 0;
  let freshDigestible = 0;
  const seenAnchors = new Set<string>();
  const provenanceFor = (it: DocCandidateItem) => ({
    source: doc.tool,
    connectionId: doc.connectionId,
    externalId: it.externalId,
    url: anchorUrl(doc.url, it.anchor?.blockId),
    evidence: it.evidence,
    confidence: it.confidence / 100,
    rationale: it.rationale,
    documentId: doc.id,
    anchorKey: it.anchor?.blockId,
    heading: it.anchor?.headingPath?.at(-1) ?? null,
    lowConfidence: it.lowConfidence,
    expiresHint: it.expiresHint || undefined,
    constraintKind: it.constraintKind,
    surfaceCandidates: it.surfaceCandidates ?? [],
  });

  for (const it of items) {
    const anchorKey = it.anchor?.blockId;
    if (anchorKey) seenAnchors.add(anchorKey);
    const existing = anchorKey ? existingByAnchor.get(anchorKey) : undefined;

    if (existing) {
      // Same anchor as an existing constraint → re-version (or no-op if the rule is unchanged).
      const r = await reproposeDocConstraint(doc.orgId, {
        projectId: doc.projectId,
        existingDecisionId: existing.decisionId,
        ruleText: it.ruleText,
        provenance: provenanceFor(it),
        constraintKind: it.constraintKind,
        expiresAt: it.expiresAt ? new Date(it.expiresAt) : null,
        anchor: it.anchor,
        connectionId: doc.connectionId ?? doc.id,
        externalId: it.externalId,
        contentHash: it.contentHash,
        confidence: it.confidence,
        rationale: it.rationale,
      });
      if (r.reversioned) reversioned++;
      else deduped++;
      continue;
    }

    const r = await fileProposedDecision(doc.orgId, {
      projectId: doc.projectId,
      scopeKind: it.scopeKind,
      scopeRef: it.scopeRef,
      ruleText: it.ruleText,
      decisionType: "rule",
      origin: "document",
      constraintKind: it.constraintKind,
      expiresAt: it.expiresAt ? new Date(it.expiresAt) : null,
      anchor: it.anchor,
      provenance: provenanceFor(it),
      // Native docs with no connector scope idempotency on the doc id itself.
      connectionId: doc.connectionId ?? doc.id,
      externalId: it.externalId,
      contentHash: it.contentHash,
      confidence: it.confidence,
      rationale: it.rationale,
    });
    if (r.deduped) deduped++;
    else if (r.fused) fused++;
    else {
      filed++;
      if (!it.lowConfidence) freshDigestible++;
      const conflictsOpened = await withOrg(doc.orgId, (tx) =>
        reconcileCandidateTx(tx, doc.orgId, {
          doc: docRef,
          decisionId: r.decisionId,
          scopeKind: it.scopeKind,
          scopeRef: it.scopeRef,
          ruleText: it.ruleText,
          anchorBlockId: it.anchor?.blockId ?? null,
        }),
      );
      opened += conflictsOpened.length;
    }
  }

  // Stale pass: a section that was re-visited this run (its text changed) but no longer yields the
  // constraint it used to → the requirement was removed from the PRD. Retire that constraint.
  const revisited = new Set(extractedAnchorKeys ?? []);
  if (revisited.size > 0) {
    await withOrg(doc.orgId, async (tx) => {
      for (const [anchorKey, ex] of existingByAnchor) {
        if (!revisited.has(anchorKey) || seenAnchors.has(anchorKey)) continue;
        if (ex.status !== "binding" && ex.status !== "proposed") continue;
        await tx.update(decisions).set({ status: "stale" }).where(eq(decisions.id, ex.decisionId));
        await tx
          .update(conflicts)
          .set({ status: "dismissed", dismissReason: "constraint_removed", resolvedAt: new Date() })
          .where(and(eq(conflicts.constraintDecisionId, ex.decisionId), eq(conflicts.status, "open")));
        await writeAudit(tx, {
          orgId: doc.orgId,
          projectId: doc.projectId,
          action: "constraint.staled",
          entityKind: "decision",
          entityId: ex.decisionId,
          payload: { reason: "removed_from_prd", anchorKey },
        });
        staled++;
      }
    });
  }

  // Anchor relocation (D3): re-verify each live constraint's anchor against the freshly-fetched
  // sections. A block that vanished (Notion) or a snippet that can't be relocated (GDocs) flips to
  // `reverify` — never a silent re-point. Only runs when the worker supplied the current sections.
  let reverified = 0;
  if (currentSections && currentSections.length > 0) {
    reverified = await withOrg(doc.orgId, (tx) => relocateAnchorsTx(tx, doc, currentSections));
  }

  await withSystem(async (tx) => {
    await tx
      .update(sourceDocuments)
      .set({ contentHash: docContentHash ?? doc.contentHash, lastExtractedAt: new Date(), lastSweptAt: new Date() })
      .where(eq(sourceDocuments.id, docId));
    // Doc already active (native flip or PRD edited post-approval): follow-up digest for new/amended items.
    if (doc.state === "active" && freshDigestible + reversioned > 0) {
      await enqueueDigestTx(tx, doc.orgId, { ...doc, contentHash: docContentHash ?? doc.contentHash });
    }
  });
  return { filed, fused, deduped, reversioned, staled, conflicts: opened, reverified };
}

/** Whitespace-normalized lowercase — the first fuzzy-relocation rung. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Relocate each of a doc's live constraint anchors against the current section list and update
 * `anchorStatus`. Notion: valid iff the heading block id still exists. GDocs/Confluence (`gdoc_fuzzy` /
 * `confluence_xpath`): locate the stored snippet — exact/normalized/≥0.8-Jaccard within the heading's
 * section; on a confident
 * match re-point the heading path only (never the snippet); on failure → `reverify`, anchor untouched.
 * Returns how many flipped to reverify.
 */
async function relocateAnchorsTx(tx: Tx, doc: typeof sourceDocuments.$inferSelect, sections: CurrentSection[]): Promise<number> {
  const rows = await constraintsForDocTx(tx, doc);
  const anchorKeys = new Set(sections.map((s) => s.anchorKey));
  let reverified = 0;
  for (const r of rows) {
    if (r.decision.status === "rejected" || r.decision.status === "stale" || r.decision.status === "superseded") continue;
    const prov = r.provRow;
    const anchor = prov?.anchor as { type?: string; blockId?: string; snippet?: string; headingPath?: string[] } | null;
    if (!prov || !anchor) continue;

    let located: CurrentSection | null = null;
    if (anchor.type === "gdoc_fuzzy" || anchor.type === "confluence_xpath") {
      const target = norm(anchor.snippet ?? "");
      if (target) {
        // exact/normalized containment first, then Jaccard ≥0.8 (prefer same heading path).
        located =
          sections.find((s) => norm(s.snippet).includes(target) || target.includes(norm(s.snippet))) ??
          sections
            .map((s) => ({ s, score: similar(anchor.snippet ?? "", s.snippet) }))
            .filter((x) => x.score >= 0.8)
            .sort((a, b) => b.score - a.score)[0]?.s ??
          null;
      }
    } else {
      // notion_block (or any stable-id anchor): valid iff the block/section still exists.
      located = anchor.blockId && anchorKeys.has(anchor.blockId) ? sections.find((s) => s.anchorKey === anchor.blockId) ?? null : null;
    }

    const nextStatus = located ? "valid" : "reverify";
    const patch: Record<string, unknown> = {};
    if (prov.anchorStatus !== nextStatus) patch.anchorStatus = nextStatus;
    // Re-point the HEADING PATH only on a confident fuzzy (GDocs/Confluence) match (the snippet is never rewritten).
    if (located && (anchor.type === "gdoc_fuzzy" || anchor.type === "confluence_xpath") && JSON.stringify(located.headingPath) !== JSON.stringify(anchor.headingPath ?? [])) {
      patch.anchor = { ...anchor, headingPath: located.headingPath };
    }
    if (Object.keys(patch).length > 0) {
      await tx.update(decisionProvenances).set(patch).where(eq(decisionProvenances.id, prov.id));
    }
    if (nextStatus === "reverify" && prov.anchorStatus !== "reverify") reverified++;
  }
  return reverified;
}

/* ───────────────────────────── Constraints & digest ───────────────────────────── */

interface ConstraintRow {
  decision: typeof decisions.$inferSelect;
  ruleText: string;
  provenance: Record<string, unknown>;
  provRow: typeof decisionProvenances.$inferSelect | undefined;
}

/** All constraints filed from a doc (via the per-section idempotency artifacts). */
async function constraintsForDocTx(
  tx: Tx,
  doc: { id: string; connectionId: string | null; externalId: string; tool: string },
): Promise<ConstraintRow[]> {
  const artifacts = await tx
    .select()
    .from(ingestArtifacts)
    .where(
      and(
        eq(ingestArtifacts.connectionId, doc.connectionId ?? doc.id),
        like(ingestArtifacts.externalId, `${doc.externalId}#%`),
      ),
    );
  const ids = [...new Set(artifacts.map((a) => a.decisionId).filter((x): x is string => Boolean(x)))];
  const out: ConstraintRow[] = [];
  for (const id of ids) {
    const d = (await tx.select().from(decisions).where(eq(decisions.id, id)).limit(1))[0];
    if (!d || d.origin !== "document") continue;
    const v = (
      await tx
        .select()
        .from(decisionVersions)
        .where(and(eq(decisionVersions.decisionId, id), eq(decisionVersions.version, d.currentVersion)))
        .limit(1)
    )[0];
    const prov = (
      await tx
        .select()
        .from(decisionProvenances)
        .where(and(eq(decisionProvenances.decisionId, id), eq(decisionProvenances.source, doc.tool)))
        .limit(1)
    )[0];
    out.push({
      decision: d,
      ruleText: v?.ruleText ?? "",
      provenance: (v?.provenance ?? {}) as Record<string, unknown>,
      provRow: prov,
    });
  }
  return out;
}

/**
 * Queue the Slack ratification digest for a doc: one message per doc per activation (dedupeKey uses
 * digestSeq), proposed non-lowConfidence constraints only, pre-approval warnings inline. Core only
 * composes data — the worker renders Block Kit and posts with the first-party bot token.
 */
export async function enqueueDigestTx(
  tx: Tx,
  orgId: string,
  doc: typeof sourceDocuments.$inferSelect,
): Promise<boolean> {
  const rows = await constraintsForDocTx(tx, doc);
  const candidates = rows.filter(
    (r) => r.decision.status === "proposed" && !(r.provenance.lowConfidence as boolean | undefined),
  );
  if (candidates.length === 0) return false;
  const recipientId = doc.ownerMemberId ?? doc.registeredBy;
  const recipient = recipientId
    ? (await tx.select().from(members).where(eq(members.id, recipientId)).limit(1))[0]
    : undefined;
  if (!recipient?.slackUserId) {
    await writeAudit(tx, {
      orgId,
      projectId: doc.projectId,
      action: "digest.skipped",
      entityKind: "document",
      entityId: doc.id,
      payload: { reason: recipient ? "no_slack_user" : "no_recipient" },
    });
    return false;
  }
  const payloadCandidates = [];
  for (const c of candidates) {
    const openConflict = (
      await tx
        .select()
        .from(conflicts)
        .where(
          and(
            eq(conflicts.constraintDecisionId, c.decision.id),
            eq(conflicts.kind, "pre_approval"),
            eq(conflicts.status, "open"),
          ),
        )
        .limit(1)
    )[0];
    let conflictInfo: { engDecisionId: string; engRuleText: string; surface: string } | null = null;
    if (openConflict?.engDecisionId) {
      const eng = (
        await tx.select().from(decisions).where(eq(decisions.id, openConflict.engDecisionId)).limit(1)
      )[0];
      const ev = eng
        ? (
            await tx
              .select()
              .from(decisionVersions)
              .where(and(eq(decisionVersions.decisionId, eng.id), eq(decisionVersions.version, eng.currentVersion)))
              .limit(1)
          )[0]
        : undefined;
      conflictInfo = {
        engDecisionId: openConflict.engDecisionId,
        engRuleText: ev?.ruleText ?? "",
        surface: openConflict.surface,
      };
    }
    payloadCandidates.push({
      decisionId: c.decision.id,
      ruleText: c.ruleText,
      scopeRef: c.decision.scopeRef,
      constraintKind: c.decision.constraintKind,
      confidencePct: Math.round(((c.provenance.confidence as number | undefined) ?? 0) * 100),
      anchorUrl: (c.provenance.url as string | undefined) ?? doc.url,
      conflict: conflictInfo,
    });
  }
  await tx
    .insert(writebacks)
    .values({
      orgId,
      projectId: doc.projectId,
      connectionId: null,
      tool: "slack",
      kind: "slack_digest",
      targetRef: recipient.slackUserId,
      payload: {
        orgId,
        documentId: doc.id,
        docTitle: doc.title,
        docUrl: doc.url,
        docState: doc.state,
        candidates: payloadCandidates,
      },
      dedupeKey: `digest:${doc.id}:${doc.digestSeq}:${doc.contentHash ?? "initial"}`,
    })
    .onConflictDoNothing();
  return true;
}

/* ───────────────────────────── Write-back queue (worker) ───────────────────────────── */

export interface PendingWriteback {
  id: string;
  orgId: string;
  tool: string;
  kind: string;
  targetRef: string;
  payload: unknown;
  connection: { entity: string; connectedAccountId: string | null; tool: string } | null;
}

/** Drainable queue for the worker. Attempts increment on pull; three strikes → failed. */
/**
 * Drain window for the worker. Cross-org (withSystem) by default — one worker serves every org.
 * `orgId` narrows to a single org: unused in production, but it keeps this deterministic in the
 * shared-DB e2e suite, where other files leave undrained `queued` rows that would otherwise crowd
 * a fresh row out of the FIFO limit window.
 */
export async function pendingWritebacks(limit = 50, orgId?: string): Promise<PendingWriteback[]> {
  return withSystem(async (tx) => {
    const rows = await tx
      .select()
      .from(writebacks)
      .where(orgId ? and(eq(writebacks.status, "queued"), eq(writebacks.orgId, orgId)) : eq(writebacks.status, "queued"))
      .orderBy(writebacks.createdAt)
      .limit(limit);
    const out: PendingWriteback[] = [];
    for (const w of rows) {
      if (w.attempts >= 3) {
        await tx.update(writebacks).set({ status: "failed" }).where(eq(writebacks.id, w.id));
        continue;
      }
      await tx.update(writebacks).set({ attempts: w.attempts + 1 }).where(eq(writebacks.id, w.id));
      const conn = w.connectionId
        ? (await tx.select().from(sourceConnections).where(eq(sourceConnections.id, w.connectionId)).limit(1))[0]
        : undefined;
      out.push({
        id: w.id,
        orgId: w.orgId,
        tool: w.tool,
        kind: w.kind,
        targetRef: w.targetRef,
        payload: w.payload,
        connection: conn ? { entity: conn.entity, connectedAccountId: conn.connectedAccountId, tool: conn.tool } : null,
      });
    }
    return out;
  });
}

export async function markWritebackDone(id: string, ok: boolean, resultRef?: string): Promise<void> {
  await withSystem(async (tx) => {
    const w = (await tx.select().from(writebacks).where(eq(writebacks.id, id)).limit(1))[0];
    if (!w) throw notFound("writeback");
    await tx
      .update(writebacks)
      .set({ status: ok ? "posted" : w.attempts >= 3 ? "failed" : "queued", resultRef: resultRef ?? null, postedAt: ok ? new Date() : null })
      .where(eq(writebacks.id, id));
    if (ok && w.kind === "conflict_comment") {
      const conflictId = (w.payload as { conflictId?: string })?.conflictId;
      if (conflictId) {
        await tx.update(conflicts).set({ writeBackRef: resultRef ?? "posted" }).where(eq(conflicts.id, conflictId));
      }
    }
  });
}

/* ───────────────────────────── Dashboard reads ───────────────────────────── */

export interface DocumentSummary {
  id: string;
  tool: string;
  stateAuthority: string;
  title: string | null;
  url: string | null;
  state: string;
  ownerMemberId: string | null;
  constraintCounts: { binding: number; total: number };
  openConflicts: number;
  anchors: { total: number; needsReverify: number };
  lastSyncedAt: string | null;
}

async function summarizeDocTx(tx: Tx, doc: typeof sourceDocuments.$inferSelect): Promise<DocumentSummary> {
  const rows = await constraintsForDocTx(tx, doc);
  const live = rows.filter((r) => r.decision.status !== "rejected");
  let openConflicts = 0;
  for (const r of live) {
    const cs = await tx
      .select()
      .from(conflicts)
      .where(and(eq(conflicts.constraintDecisionId, r.decision.id), eq(conflicts.status, "open")));
    openConflicts += cs.length;
  }
  return {
    id: doc.id,
    tool: doc.tool,
    stateAuthority: doc.stateAuthority,
    title: doc.title,
    url: doc.url,
    state: doc.state,
    ownerMemberId: doc.ownerMemberId,
    constraintCounts: {
      binding: live.filter((r) => r.decision.status === "binding").length,
      total: live.length,
    },
    openConflicts,
    anchors: {
      total: live.filter((r) => r.provRow?.anchor).length,
      needsReverify: live.filter((r) => r.provRow && r.provRow.anchorStatus !== "valid").length,
    },
    lastSyncedAt: doc.lastSweptAt?.toISOString() ?? null,
  };
}

export async function listDocuments(
  orgId: string,
  projectId: string,
): Promise<{
  documents: DocumentSummary[];
  pendingStatusValues: Array<{ connectionId: string; containerRef: string; containerName: string | null; value: string; firstSeenAt: string }>;
}> {
  return withOrg(orgId, async (tx) => {
    const docs = await tx.select().from(sourceDocuments).where(eq(sourceDocuments.projectId, projectId));
    const documents = [];
    for (const d of docs) documents.push(await summarizeDocTx(tx, d));
    documents.sort((a, b) => (b.lastSyncedAt ?? "").localeCompare(a.lastSyncedAt ?? ""));
    const mappings = await tx
      .select()
      .from(documentStateMappings)
      .where(eq(documentStateMappings.projectId, projectId));
    const pendingStatusValues = mappings.flatMap((m) =>
      ((m.pendingValues ?? []) as Array<{ value: string; firstSeenAt: string }>).map((p) => ({
        connectionId: m.connectionId,
        containerRef: m.containerRef,
        containerName: m.containerName,
        value: p.value,
        firstSeenAt: p.firstSeenAt,
      })),
    );
    return { documents, pendingStatusValues };
  });
}

export async function getDocument(orgId: string, docId: string): Promise<Record<string, unknown>> {
  return withOrg(orgId, async (tx) => {
    const doc = (await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, docId)).limit(1))[0];
    if (!doc) throw notFound("document");
    const summary = await summarizeDocTx(tx, doc);
    const rows = await constraintsForDocTx(tx, doc);
    const constraints = rows
      .filter((r) => r.decision.status !== "rejected")
      .map((r) => {
        const anchor = (r.provRow?.anchor ?? null) as { blockId?: string; headingPath?: string[] } | null;
        return {
          id: r.decision.id,
          ruleText: r.ruleText,
          status: r.decision.status,
          constraintKind: r.decision.constraintKind,
          scopeRef: r.decision.scopeRef,
          anchor: {
            heading: anchor?.headingPath?.at(-1) ?? null,
            url: anchorUrl(doc.url, anchor?.blockId),
            healthy: (r.provRow?.anchorStatus ?? "valid") === "valid",
          },
        };
      });
    const artifacts = await tx
      .select()
      .from(ingestArtifacts)
      .where(
        and(
          eq(ingestArtifacts.connectionId, doc.connectionId ?? doc.id),
          like(ingestArtifacts.externalId, `${doc.externalId}#%`),
        ),
      );
    const extractionHistory = artifacts
      .map((a) => ({ id: a.id, at: a.createdAt.toISOString(), status: a.status, confidence: a.confidence }))
      .sort((a, b) => b.at.localeCompare(a.at));
    const wbs = await tx
      .select()
      .from(writebacks)
      .where(and(eq(writebacks.projectId, doc.projectId), eq(writebacks.targetRef, doc.externalId)));
    const writeBackLog = wbs
      .map((w) => ({ id: w.id, at: w.createdAt.toISOString(), kind: w.kind, status: w.status, url: null }))
      .sort((a, b) => b.at.localeCompare(a.at));
    return { ...summary, constraints, extractionHistory, writeBackLog };
  });
}

/* ───────────────────────────── State mappings (admin) ───────────────────────────── */

export async function listStateMappings(
  orgId: string,
  projectId: string,
  connectionId: string,
): Promise<{
  containers: Array<{
    containerRef: string;
    containerName: string | null;
    statusProperty: string | null;
    knownValues: string[];
    mappings: Array<{ sourceValue: string; canonicalState: string }>;
    pendingValues: Array<{ value: string; firstSeenAt: string }>;
  }>;
}> {
  return withOrg(orgId, async (tx) => {
    // Containers = allowlisted databases; mapping rows overlay config on them.
    const allow = await tx
      .select()
      .from(ingestAllowlist)
      .where(
        and(
          eq(ingestAllowlist.connectionId, connectionId),
          eq(ingestAllowlist.enabled, true),
          eq(ingestAllowlist.sourceKind, "database"),
        ),
      );
    const mappings = await tx
      .select()
      .from(documentStateMappings)
      .where(eq(documentStateMappings.connectionId, connectionId));
    const refs = new Map<string, { name: string | null }>();
    for (const a of allow) refs.set(a.sourceRef, { name: a.sourceName });
    for (const m of mappings) if (!refs.has(m.containerRef)) refs.set(m.containerRef, { name: m.containerName });
    const docs = await tx.select().from(sourceDocuments).where(eq(sourceDocuments.connectionId, connectionId));
    const containers = [...refs.entries()].map(([containerRef, { name }]) => {
      const m = mappings.find((x) => x.containerRef === containerRef);
      const mapObj = ((m?.mapping ?? {}) as Record<string, string>) || {};
      const pending = ((m?.pendingValues ?? []) as Array<{ value: string; firstSeenAt: string }>) || [];
      // Known values = every raw status value we've observed on this container's docs.
      const seen = new Set<string>();
      for (const d of docs) {
        if (d.containerRef === containerRef && d.sourceStateValue) seen.add(d.sourceStateValue);
      }
      for (const v of Object.keys(mapObj)) seen.add(v);
      return {
        containerRef,
        containerName: m?.containerName ?? name,
        statusProperty: m?.statusProperty ?? null,
        knownValues: [...seen].sort(),
        mappings: Object.entries(mapObj).map(([sourceValue, canonicalState]) => ({ sourceValue, canonicalState })),
        pendingValues: pending,
      };
    });
    return { containers };
  });
}

async function upsertMappingRowTx(
  tx: Tx,
  orgId: string,
  input: { projectId: string; connectionId: string; containerRef: string; memberId: string },
): Promise<typeof documentStateMappings.$inferSelect> {
  const existing = (
    await tx
      .select()
      .from(documentStateMappings)
      .where(
        and(
          eq(documentStateMappings.connectionId, input.connectionId),
          eq(documentStateMappings.containerRef, input.containerRef),
        ),
      )
      .limit(1)
  )[0];
  if (existing) return existing;
  const allow = (
    await tx
      .select()
      .from(ingestAllowlist)
      .where(and(eq(ingestAllowlist.connectionId, input.connectionId), eq(ingestAllowlist.sourceRef, input.containerRef)))
      .limit(1)
  )[0];
  return one(
    await tx
      .insert(documentStateMappings)
      .values({
        orgId,
        projectId: input.projectId,
        connectionId: input.connectionId,
        containerRef: input.containerRef,
        containerName: allow?.sourceName ?? null,
        createdBy: input.memberId,
      })
      .returning(),
  );
}

export async function setStateMapping(
  orgId: string,
  input: {
    projectId: string;
    connectionId: string;
    containerRef: string;
    sourceValue: string;
    canonicalState: string;
    memberId: string;
  },
): Promise<{ ok: boolean }> {
  if (!CANONICAL_STATES.includes(input.canonicalState as CanonicalState))
    throw Object.assign(new Error(`invalid canonical state: ${input.canonicalState}`), { statusCode: 400 });
  return withOrg(orgId, async (tx) => {
    const row = await upsertMappingRowTx(tx, orgId, input);
    const mapping = { ...((row.mapping ?? {}) as Record<string, string>), [input.sourceValue]: input.canonicalState };
    // Mapping a value resolves it from the pending queue.
    const pending = ((row.pendingValues ?? []) as Array<{ value: string }>).filter((p) => p.value !== input.sourceValue);
    await tx
      .update(documentStateMappings)
      .set({ mapping, pendingValues: pending })
      .where(eq(documentStateMappings.id, row.id));
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "mapping.updated",
      entityKind: "state_mapping",
      entityId: row.id,
      payload: { containerRef: input.containerRef, sourceValue: input.sourceValue, canonicalState: input.canonicalState },
    });
    return { ok: true };
  });
}

/* ───────────────────────────── Ratifications queue & counts ───────────────────────────── */

/**
 * The Ratifications tab / Slack digest share one queue: proposed document constraints, each with its
 * doc, anchor, pre-approval warning, and the server-computed permission verdict (buttons are UX, the
 * ratify endpoint re-enforces).
 */
export async function listRatifications(
  orgId: string,
  projectId: string,
  memberId: string,
): Promise<{ candidates: Array<Record<string, unknown>>; viewer: { memberId: string; role: string } }> {
  return withOrg(orgId, async (tx) => {
    const role = (await getProjectRoleTx(tx, projectId, memberId)) ?? "member";
    const ds = await tx
      .select()
      .from(decisions)
      .where(and(eq(decisions.projectId, projectId), eq(decisions.origin, "document"), eq(decisions.status, "proposed")));
    const docCache = new Map<string, typeof sourceDocuments.$inferSelect | null>();
    const candidates: Array<Record<string, unknown>> = [];
    for (const d of ds) {
      const v = (
        await tx
          .select()
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, d.id), eq(decisionVersions.version, d.currentVersion)))
          .limit(1)
      )[0];
      const prov = (v?.provenance ?? {}) as Record<string, unknown>;
      const documentId = prov.documentId as string | undefined;
      if (documentId && !docCache.has(documentId)) {
        docCache.set(
          documentId,
          (await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, documentId)).limit(1))[0] ?? null,
        );
      }
      const doc = documentId ? docCache.get(documentId) : null;
      const provRows = await tx.select().from(decisionProvenances).where(eq(decisionProvenances.decisionId, d.id));
      const openConflict = (
        await tx
          .select()
          .from(conflicts)
          .where(and(eq(conflicts.constraintDecisionId, d.id), eq(conflicts.kind, "pre_approval"), eq(conflicts.status, "open")))
          .limit(1)
      )[0];
      let conflictInfo: { engDecisionId: string; engRuleText: string; surface: string } | null = null;
      if (openConflict?.engDecisionId) {
        const eng = (await tx.select().from(decisions).where(eq(decisions.id, openConflict.engDecisionId)).limit(1))[0];
        const ev = eng
          ? (
              await tx
                .select()
                .from(decisionVersions)
                .where(and(eq(decisionVersions.decisionId, eng.id), eq(decisionVersions.version, eng.currentVersion)))
                .limit(1)
            )[0]
          : undefined;
        conflictInfo = { engDecisionId: openConflict.engDecisionId, engRuleText: ev?.ruleText ?? "", surface: openConflict.surface };
      }
      const canRatify =
        Boolean(doc) &&
        doc!.state === "active" &&
        (role === "owner" || role === "pm" || doc!.registeredBy === memberId || doc!.ownerMemberId === memberId);
      const blockedReason = !doc
        ? "Source document not found"
        : doc.state !== "active"
          ? doc.stateAuthority === "mirrored"
            ? "PRD not yet approved in Notion"
            : "Document not yet active"
          : canRatify
            ? null
            : "Requires PM or owner role, or document ownership";
      const anchor = (provRows.find((p) => p.anchor)?.anchor ?? null) as { blockId?: string; headingPath?: string[] } | null;
      candidates.push({
        id: d.id,
        ruleText: v?.ruleText ?? "",
        scopeKind: d.scopeKind,
        scopeRef: d.scopeRef,
        decisionType: d.decisionType,
        constraintKind: d.constraintKind,
        confidence: (prov.confidence as number | undefined) ?? null,
        provenance: prov,
        provenances: provRows.map((p) => ({
          source: p.source,
          externalId: p.externalId,
          url: p.url,
          evidence: p.evidence,
          confidence: p.confidence,
        })),
        doc: doc
          ? { id: doc.id, title: doc.title, url: doc.url, state: doc.state, ownerMemberId: doc.ownerMemberId }
          : null,
        anchor: {
          heading: (prov.heading as string | undefined) ?? anchor?.headingPath?.at(-1) ?? null,
          url: anchorUrl(doc?.url ?? null, anchor?.blockId),
        },
        conflict: conflictInfo,
        lowConfidence: Boolean(prov.lowConfidence),
        canRatify,
        blockedReason,
        createdAt: d.createdAt,
      });
    }
    candidates.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { candidates, viewer: { memberId, role } };
  });
}

/** Cheap aggregate for nav badges. */
export async function projectCounts(
  orgId: string,
  projectId: string,
): Promise<{ review: { proposed: number; ratifications: number; conflicts: number; total: number }; sources: number }> {
  return withOrg(orgId, async (tx) => {
    const ds = await tx
      .select({ origin: decisions.origin, status: decisions.status })
      .from(decisions)
      .where(and(eq(decisions.projectId, projectId), eq(decisions.status, "proposed")));
    const proposed = ds.filter((d) => d.origin !== "document").length;
    const ratifications = ds.filter((d) => d.origin === "document").length;
    const open = await tx
      .select({ id: conflicts.id })
      .from(conflicts)
      .where(and(eq(conflicts.projectId, projectId), eq(conflicts.status, "open")));
    const mappings = await tx
      .select()
      .from(documentStateMappings)
      .where(eq(documentStateMappings.projectId, projectId));
    const pendingCount = mappings.reduce((n, m) => n + ((m.pendingValues ?? []) as unknown[]).length, 0);
    return {
      review: { proposed, ratifications, conflicts: open.length, total: proposed + ratifications },
      sources: pendingCount,
    };
  });
}

export async function setStatusProperty(
  orgId: string,
  input: { projectId: string; connectionId: string; containerRef: string; statusProperty: string; memberId: string },
): Promise<{ ok: boolean }> {
  return withOrg(orgId, async (tx) => {
    const row = await upsertMappingRowTx(tx, orgId, input);
    await tx
      .update(documentStateMappings)
      .set({ statusProperty: input.statusProperty })
      .where(eq(documentStateMappings.id, row.id));
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "mapping.updated",
      entityKind: "state_mapping",
      entityId: row.id,
      payload: { containerRef: input.containerRef, statusProperty: input.statusProperty },
    });
    return { ok: true };
  });
}
