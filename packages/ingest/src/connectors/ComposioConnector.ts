import type { SourceConnector, Unit, Channel, DocumentConnector, DocMeta, DocSection } from "./SourceConnector.js";

export type Tool = "slack" | "jira" | "notion" | "confluence";

/** The subset of the @composio/core v0.13 client surface this connector uses. */
type V3Client = {
  authConfigs: {
    list: (q: { toolkit?: string }) => Promise<{ items?: Array<{ id: string; toolkit?: { slug?: string } }> }>;
    create: (toolkit: string, opts: { type: string; name?: string }) => Promise<{ id: string }>;
  };
  connectedAccounts: {
    // Composio-managed OAuth configs require `link` (initiate is rejected for them).
    link: (userId: string, authConfigId: string) => Promise<{ redirectUrl?: string; id?: string }>;
    get: (id: string) => Promise<{ status?: string }>;
  };
  tools: {
    getRawComposioTools: (query: {
      toolkits: string[];
      limit?: number;
    }) => Promise<Array<{ slug?: string; version?: string }> | { items?: Array<{ slug?: string; version?: string }> }>;
    execute: (
      slug: string,
      body: { userId: string; arguments: Record<string, unknown>; version?: string },
    ) => Promise<unknown>;
  };
};

/**
 * Composio slugs for the v3 doc layer — plausible picks from Composio's Notion action list but NOT yet
 * verified against live Composio (plan A7 risk #1: verify these before the first real doc sweep).
 * Each is referenced exactly once, so a rename is a one-line fix.
 */
// Verified against Composio docs: NOTION_FETCH_BLOCK_CONTENTS takes `block_id`; NOTION_CREATE_COMMENT takes
// `parent_page_id` (or `discussion_id`) + a `comment` rich-text object ({content}).
const NOTION_BLOCK_CHILDREN_SLUG = "NOTION_FETCH_BLOCK_CONTENTS";
const NOTION_CREATE_COMMENT_SLUG = "NOTION_CREATE_COMMENT";

/**
 * Composio-backed connector for every human-coordination source. One class, per-tool routing — the
 * distillation funnel is source-agnostic (it just consumes Units). Verified Composio slugs:
 *   Slack:      SLACK_FIND_CHANNELS, SLACK_FETCH_CONVERSATION_HISTORY, SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION
 *   Jira:       JIRA_GET_ALL_PROJECTS, JIRA_SEARCH_ISSUES (JQL)
 *   Notion:     NOTION_SEARCH_NOTION_PAGE, NOTION_QUERY_DATABASE, NOTION_GET_PAGE_MARKDOWN
 *   Confluence: CONFLUENCE_SEARCH, CONFLUENCE_GET_PAGE_BY_ID (best-effort; verify against installed SDK)
 *   Notion docs (v3, UNVERIFIED — see consts above): block children + comment create
 *
 * The @composio/core SDK loads via a computed dynamic import so this file typechecks / the worker builds
 * even without the package (CI runs only StubConnector). `exec()` is the one place the SDK call shape
 * lives; it's exercised by the live test, not CI. Composio holds the OAuth token; we never see it.
 */
export class ComposioConnector implements SourceConnector, DocumentConnector {
  private client: unknown;

  constructor(
    private readonly apiKey: string,
    private readonly entity: string,
    private readonly tool: Tool = "slack",
    private readonly defaultWindowDays = 7,
  ) {}

  private async getClient(): Promise<Record<string, unknown>> {
    if (!this.client) {
      const spec = "@composio/core";
      const mod: Record<string, unknown> = await import(spec);
      const Composio = mod.Composio as new (opts: { apiKey: string }) => unknown;
      this.client = new Composio({ apiKey: this.apiKey });
    }
    return this.client as Record<string, unknown>;
  }

  private versionCache: Record<string, string | undefined> = {};
  private versionsLoaded = false;
  /** v0.13 manual execute() requires a concrete toolkit version (refuses "latest"); load slug→version once. */
  private async toolVersion(client: V3Client, slug: string): Promise<string | undefined> {
    if (!this.versionsLoaded) {
      const raw = await client.tools.getRawComposioTools({ toolkits: [this.tool], limit: 500 }).catch(() => []);
      const arr = Array.isArray(raw) ? raw : (raw.items ?? []);
      for (const t of arr) if (t.slug) this.versionCache[t.slug] = t.version;
      this.versionsLoaded = true;
    }
    return this.versionCache[slug];
  }

  private async exec(slug: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = (await this.getClient()) as unknown as V3Client;
    // @composio/core v0.13: execute(slug, { userId, arguments, version }); Composio resolves the
    // connected account for this user+toolkit. (The legacy { entity, app, tool, input } shape was retired.)
    const version = await this.toolVersion(client, slug);
    const res = (await client.tools.execute(slug, { userId: this.entity, arguments: input, version })) as {
      data?: Record<string, unknown>;
      successful?: boolean;
      error?: string;
    };
    if (res && res.successful === false) throw new Error(`composio ${slug} failed: ${res.error ?? "unknown"}`);
    return (res?.data ?? {}) as Record<string, unknown>;
  }

  /**
   * Composio v0.13 connections require an auth config (per-toolkit). We use Composio-managed auth
   * ("use_composio_managed_auth") so no self-registered OAuth app is needed; reuse an existing config
   * for the toolkit if present, else create one. Cached per connector instance.
   */
  private authConfigId?: string;
  private async ensureAuthConfig(): Promise<string> {
    if (this.authConfigId) return this.authConfigId;
    const client = (await this.getClient()) as unknown as V3Client;
    const existing = await client.authConfigs.list({ toolkit: this.tool }).catch(() => ({ items: [] }));
    const found = (existing.items ?? []).find((a) => (a.toolkit?.slug ?? "").toLowerCase() === this.tool);
    if (found) return (this.authConfigId = found.id);
    const created = await client.authConfigs.create(this.tool, {
      type: "use_composio_managed_auth",
      name: `lockstep-${this.tool}`,
    });
    return (this.authConfigId = created.id);
  }

  private sinceEpoch(cursor: string | null): number {
    if (cursor && /^\d+(\.\d+)?$/.test(cursor)) return Math.floor(Number(cursor));
    return Math.floor(Date.now() / 1000) - this.defaultWindowDays * 86400;
  }
  private sinceIso(cursor: string | null): string {
    if (cursor && cursor.includes("-")) return cursor;
    return new Date((Math.floor(Date.now() / 1000) - this.defaultWindowDays * 86400) * 1000).toISOString();
  }

  /* ── OAuth (control-plane) ── */

  async initiate(): Promise<{ redirectUrl: string; connectedAccountId: string }> {
    const client = (await this.getClient()) as unknown as V3Client;
    const authConfigId = await this.ensureAuthConfig();
    // v0.13 managed-auth: link(userId, authConfigId) → ConnectionRequest { redirectUrl, id }.
    const req = await client.connectedAccounts.link(this.entity, authConfigId);
    return { redirectUrl: req.redirectUrl ?? "", connectedAccountId: req.id ?? "" };
  }

  async isActive(connectedAccountId: string): Promise<boolean> {
    const client = (await this.getClient()) as unknown as V3Client;
    const acc = await client.connectedAccounts.get(connectedAccountId).catch(() => ({ status: "" }));
    return (acc.status ?? "").toUpperCase() === "ACTIVE";
  }

  /**
   * Enumerate the connected Slack workspace's users (id + profile email) so core can auto-link
   * members.slack_user_id by email. The slug drifts across Composio versions (this broke silently
   * once, E2E 2026-07-08) — so try a fallback chain, first success wins, remembered for pagination.
   * `COMPOSIO_SLACK_USERS_SLUG` overrides the chain outright. Live verification of the winning slug
   * still required per Composio upgrade. Defensive against members/users response shapes and
   * profile.email vs email. Empty for non-Slack tools.
   */
  private slackUsersSlug: string | null = null;

  private async execSlackUsers(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const chain = process.env.COMPOSIO_SLACK_USERS_SLUG
      ? [process.env.COMPOSIO_SLACK_USERS_SLUG]
      : ["SLACK_LIST_ALL_SLACK_TEAM_USERS_WITH_PAGINATION", "SLACK_LIST_ALL_USERS", "SLACK_FIND_USERS"];
    if (this.slackUsersSlug) return this.exec(this.slackUsersSlug, args);
    let lastErr: unknown;
    for (const slug of chain) {
      try {
        const d = await this.exec(slug, args);
        this.slackUsersSlug = slug;
        console.log(`[composio] slack users via ${slug}`);
        return d;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async listSlackUsers(): Promise<Array<{ slackUserId: string; email: string | null }>> {
    if (this.tool !== "slack") return [];
    const out: Array<{ slackUserId: string; email: string | null }> = [];
    let cursor: string | null = null;
    do {
      const d = await this.execSlackUsers({
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const u of arr(d.members ?? d.users ?? d.results)) {
        const id = str(u.id);
        if (!id || u.deleted === true || u.is_bot === true) continue;
        const profile = (u.profile ?? {}) as Record<string, unknown>;
        out.push({ slackUserId: id, email: str(profile.email ?? u.email) || null });
      }
      const meta = (d.response_metadata ?? {}) as Record<string, unknown>;
      cursor = str(meta.next_cursor) || null;
    } while (cursor);
    return out;
  }

  /* ── Sources (channels / projects / spaces / databases) ── */

  async listChannels(): Promise<Channel[]> {
    switch (this.tool) {
      case "slack": {
        // v0.13 schema: `query` is required (empty = list all); `types` covers public+private.
        const d = await this.exec("SLACK_FIND_CHANNELS", {
          query: "",
          limit: 200,
          exclude_archived: true,
          types: "public_channel,private_channel",
        });
        return arr(d.channels ?? d.results).flatMap((c) => (c.id ? [{ id: String(c.id), name: str(c.name) || String(c.id) }] : []));
      }
      case "jira": {
        const d = await this.exec("JIRA_GET_ALL_PROJECTS", {});
        return arr(d.projects ?? d.values ?? d).flatMap((p) => (p.key ? [{ id: String(p.key), name: str(p.name) || String(p.key) }] : []));
      }
      case "notion": {
        const d = await this.exec("NOTION_SEARCH_NOTION_PAGE", { filter_value: "database", page_size: 100 });
        return arr(d.results).flatMap((r) => (r.id ? [{ id: String(r.id), name: notionTitle(r) }] : []));
      }
      case "confluence": {
        const d = await this.exec("CONFLUENCE_GET_SPACES", { limit: 100 });
        return arr(d.results ?? d.spaces).flatMap((s) => (s.key || s.id ? [{ id: String(s.key ?? s.id), name: str(s.name) }] : []));
      }
    }
  }

  /* ── Units ── */

  async listUnitsSince(sourceRef: string, sinceCursor: string | null): Promise<Unit[]> {
    switch (this.tool) {
      case "slack":
        return this.slackUnits(sourceRef, sinceCursor);
      case "jira":
        return this.jiraUnits(sourceRef, sinceCursor);
      case "notion":
        return this.notionUnits(sourceRef, sinceCursor);
      case "confluence":
        return this.confluenceUnits(sourceRef, sinceCursor);
    }
  }

  private async slackUnits(channel: string, cursor: string | null): Promise<Unit[]> {
    const hist = await this.exec("SLACK_FETCH_CONVERSATION_HISTORY", {
      channel,
      oldest: String(this.sinceEpoch(cursor)),
      limit: 200,
    });
    const units: Unit[] = [];
    for (const m of arr(hist.messages)) {
      const ts = str(m.ts);
      if (!ts || (m.thread_ts && m.thread_ts !== m.ts)) continue;
      const lines = [renderSlack(m)];
      const authors = new Set<string>(author(m));
      if (Number(m.reply_count ?? 0) > 0) {
        const thread = await this.exec("SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION", { channel, ts });
        for (const r of arr(thread.messages)) {
          if (str(r.ts) === ts) continue;
          lines.push(renderSlack(r));
          author(r).forEach((a) => authors.add(a));
        }
      }
      units.push({ externalId: `${channel}/${ts}`, sourceRef: channel, ts, text: lines.join("\n"), authors: [...authors], permalink: str(m.permalink) || undefined });
    }
    return units;
  }

  /**
   * Gateway event drain: fetch ONE thread (root + replies) as a unit with the exact granularity of
   * slackUnits — same externalId (`${channel}/${threadTs}`) and same text composition, so its
   * contentHash matches what a sweep would produce and fileProposedDecision dedupes overlap.
   * Returns null when the root message is gone (deleted) or the fetch fails.
   */
  async fetchThreadUnit(channel: string, threadTs: string): Promise<Unit | null> {
    try {
      const thread = await this.exec("SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION", { channel, ts: threadTs });
      const messages = arr(thread.messages);
      const root = messages.find((m) => str(m.ts) === threadTs) ?? messages[0];
      if (!root || !str(root.ts)) return null;
      const rootTs = str(root.ts);
      const lines = [renderSlack(root)];
      const authors = new Set<string>(author(root));
      for (const r of messages) {
        if (str(r.ts) === rootTs) continue;
        lines.push(renderSlack(r));
        author(r).forEach((a) => authors.add(a));
      }
      return {
        externalId: `${channel}/${rootTs}`,
        sourceRef: channel,
        ts: str(messages[messages.length - 1]?.ts) || rootTs,
        text: lines.join("\n"),
        authors: [...authors],
        permalink: str(root.permalink) || undefined,
      };
    } catch {
      return null;
    }
  }

  private async jiraUnits(projectKey: string, cursor: string | null): Promise<Unit[]> {
    const since = this.sinceIso(cursor).slice(0, 10); // JQL date
    const jql = `project = "${projectKey}" AND updated >= "${since}" ORDER BY updated DESC`;
    const d = await this.exec("JIRA_SEARCH_ISSUES", { jql, maxResults: 100, fields: ["summary", "description", "comment", "updated"] });
    const units: Unit[] = [];
    for (const issue of arr(d.issues)) {
      const key = str(issue.key);
      const f = (issue.fields ?? {}) as Record<string, unknown>;
      const comments = arr((f.comment as Record<string, unknown>)?.comments).map((c) => `${author(c)[0] ?? "?"}: ${plain(c.body)}`);
      const text = `${key} ${str(f.summary)}\n${plain(f.description)}\n${comments.join("\n")}`.trim();
      const ts = str(f.updated) || new Date().toISOString();
      units.push({ externalId: `${projectKey}/${key}`, sourceRef: projectKey, ts, text, authors: comments.length ? [] : [], permalink: str(issue.self) || undefined });
    }
    return units;
  }

  private async notionUnits(sourceRef: string, cursor: string | null): Promise<Unit[]> {
    const isDb = /^[0-9a-f]{8}-?[0-9a-f]{4}/i.test(sourceRef);
    const listing = isDb
      ? await this.exec("NOTION_QUERY_DATABASE", { database_id: sourceRef, page_size: 100 })
      : await this.exec("NOTION_SEARCH_NOTION_PAGE", { query: sourceRef, filter_value: "page", page_size: 100 });
    const since = this.sinceIso(cursor);
    const units: Unit[] = [];
    for (const page of arr(listing.results)) {
      const pageId = str(page.id);
      const edited = str(page.last_edited_time) || since;
      if (edited < since) continue;
      const md = await this.exec("NOTION_GET_PAGE_MARKDOWN", { page_id: pageId });
      const text = `${notionTitle(page)}\n${str(md.markdown ?? md.content ?? md.text)}`.trim();
      units.push({ externalId: `${sourceRef}/${pageId}`, sourceRef, ts: edited, text, authors: [], permalink: str(page.url) || undefined });
    }
    return units;
  }

  private async confluenceUnits(spaceKey: string, cursor: string | null): Promise<Unit[]> {
    const since = this.sinceIso(cursor).slice(0, 10);
    const d = await this.exec("CONFLUENCE_SEARCH", { cql: `space = "${spaceKey}" AND lastmodified >= "${since}"`, limit: 100 });
    const units: Unit[] = [];
    for (const r of arr(d.results ?? d.pages)) {
      const id = str(r.id ?? (r.content as Record<string, unknown>)?.id);
      if (!id) continue;
      // Composio's Confluence tools are Cloud API v2 — no `expand`; body.storage retrieval is the live risk.
      const page = await this.exec("CONFLUENCE_GET_PAGE_BY_ID", { id });
      const body = plain((page.body as Record<string, unknown>)?.storage ?? page.body);
      const ts = str((page.version as Record<string, unknown>)?.when) || this.sinceIso(cursor);
      units.push({ externalId: `${spaceKey}/${id}`, sourceRef: spaceKey, ts, text: `${str(page.title)}\n${body}`.trim(), authors: [], permalink: str(page._links && (page._links as Record<string, unknown>).webui) || undefined });
    }
    return units;
  }

  /* ── Documents (v3 product layer — Notion only) ── */

  private assertNotion(method: string): void {
    if (this.tool !== "notion") throw new Error(`${method} requires the notion tool (got ${this.tool})`);
  }

  async listDocuments(containerRef: string, statusProperty: string | null): Promise<DocMeta[]> {
    this.assertNotion("listDocuments");
    const d = await this.exec("NOTION_QUERY_DATABASE", { database_id: containerRef, page_size: 100 });
    return arr(d.results).flatMap((page) => {
      const pageId = str(page.id);
      if (!pageId) return [];
      const props = (page.properties ?? {}) as Record<string, unknown>;
      return [
        {
          externalId: pageId,
          containerRef,
          title: notionTitle(page),
          url: str(page.url) || null,
          rawStateValue: statusProperty ? notionStatusValue(props[statusProperty]) : null,
          ownerRef: str((page.created_by as Record<string, unknown> | undefined)?.id) || null,
          lastEditedTime: str(page.last_edited_time) || new Date().toISOString(),
        },
      ];
    });
  }

  async fetchDocumentSections(pageId: string): Promise<DocSection[]> {
    this.assertNotion("fetchDocumentSections");
    // Walk the page's direct children (with pagination, no recursion into nested blocks — D8);
    // sections start at heading_1/2/3, anchored on the heading block id.
    const blocks: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    do {
      const d = await this.exec(NOTION_BLOCK_CHILDREN_SLUG, {
        block_id: pageId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      blocks.push(...arr(d.results ?? d.blocks));
      cursor = d.has_more ? str(d.next_cursor) || null : null;
    } while (cursor);
    return sectionize(pageId, blocks);
  }

  async writeComment(pageId: string, body: string, _anchorBlockId?: string | null): Promise<{ commentRef: string }> {
    this.assertNotion("writeComment");
    // Notion's comment-create takes a page parent or an existing discussion_id; a block id is neither,
    // so the anchor rides in the body's deep link and the comment lands at page level.
    // Composio flattens the parent + rich-text into `parent_page_id` + a `comment` rich-text object
    // ({content}) — NOT the raw Notion API `parent`/`rich_text` shape (verified against Composio docs).
    const d = await this.exec(NOTION_CREATE_COMMENT_SLUG, {
      parent_page_id: pageId,
      comment: { content: body },
    });
    return { commentRef: str(d.id) || pageId };
  }
}

/* helpers — defensive against varying Composio response shapes */
function arr(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function author(m: Record<string, unknown>): string[] {
  const a = m.user ?? m.username ?? m.author ?? (m.author as Record<string, unknown>)?.displayName ?? m.bot_id;
  return a ? [str(a)] : [];
}
function renderSlack(m: Record<string, unknown>): string {
  return `${str(m.user ?? m.username ?? "unknown")}: ${str(m.text)}`;
}
function plain(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.value === "string") return o.value; // confluence body.storage.value
    return JSON.stringify(v).slice(0, 4000); // ADF / rich text fallback
  }
  return "";
}
function notionTitle(page: Record<string, unknown>): string {
  const richText = (t: unknown): string | null =>
    Array.isArray(t) && (t as Array<{ plain_text?: string }>)[0]?.plain_text
      ? (t as Array<{ plain_text?: string }>).map((x) => x.plain_text ?? "").join("")
      : null;
  // Databases expose their name as a top-level `title` rich-text array.
  const top = richText(page.title);
  if (top) return top;
  // Pages expose it via a title-type property.
  const props = page.properties as Record<string, unknown> | undefined;
  if (props) {
    for (const p of Object.values(props)) {
      const t = richText((p as Record<string, unknown>)?.title);
      if (t) return t;
    }
  }
  return "(untitled)";
}
function notionStatusValue(prop: unknown): string | null {
  // Notion exposes the status column as either a `select` or a `status` property type — handle both.
  const p = prop as Record<string, unknown> | undefined;
  const sel = (p?.select ?? p?.status) as Record<string, unknown> | undefined;
  return sel && typeof sel.name === "string" ? sel.name : null;
}
function headingLevel(block: Record<string, unknown>): number | null {
  const m = str(block.type).match(/^heading_([123])$/);
  return m ? Number(m[1]) : null;
}
function blockPlain(block: Record<string, unknown>): string {
  const payload = block[str(block.type)] as Record<string, unknown> | undefined;
  const rich = payload?.rich_text as Array<{ plain_text?: string }> | undefined;
  return Array.isArray(rich) ? rich.map((r) => r.plain_text ?? "").join("") : "";
}
function snippetOf(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 120);
}
/** Split a page's block list into heading-anchored sections (the pre-heading preamble anchors at the pageId). */
function sectionize(pageId: string, blocks: Array<Record<string, unknown>>): DocSection[] {
  const sections: DocSection[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let i = 0;
  const preamble: string[] = [];
  while (i < blocks.length && headingLevel(blocks[i]!) === null) {
    const t = blockPlain(blocks[i]!);
    if (t) preamble.push(t);
    i++;
  }
  if (preamble.length) {
    const body = preamble.join("\n");
    sections.push({ anchorKey: pageId, headingPath: [], text: body, snippet: snippetOf(body) });
  }
  // Each heading's section runs until the next same-or-higher-level heading, so an h2 section includes
  // its h3 subsections' text — and the h3s also anchor their own, finer-grained sections.
  for (; i < blocks.length; i++) {
    const level = headingLevel(blocks[i]!);
    if (level === null) continue;
    const headingText = blockPlain(blocks[i]!);
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, text: headingText });
    const bodyParts: string[] = [];
    for (let j = i + 1; j < blocks.length; j++) {
      const l = headingLevel(blocks[j]!);
      if (l !== null && l <= level) break;
      const t = blockPlain(blocks[j]!);
      if (t) bodyParts.push(t);
    }
    const body = bodyParts.join("\n");
    sections.push({
      anchorKey: str(blocks[i]!.id) || `${pageId}:${i}`,
      headingPath: stack.map((h) => h.text),
      text: [headingText, body].filter(Boolean).join("\n"),
      snippet: snippetOf(body || headingText),
    });
  }
  return sections;
}
