import type { SourceConnector, Unit, Channel, DocumentConnector, DocMeta, DocSection } from "./SourceConnector.js";
import { goldenPrdMeta, goldenPrdSections } from "../eval/golden-prd.js";

/** Canned data for deterministic tests and local demos — no network, no Composio, no Slack app. */
export class StubConnector implements SourceConnector, DocumentConnector {
  /** writeComment calls, recorded for assertions (the stub never talks to Notion). */
  readonly comments: Array<{ pageId: string; body: string; anchorBlockId: string | null }> = [];

  constructor(
    private readonly units: Unit[] = StubConnector.sample(),
    private readonly opts: { docStateValue?: string } = {},
  ) {}

  async listChannels(): Promise<Channel[]> {
    return [{ id: "C_STUB", name: "eng-decisions" }];
  }

  async listUnitsSince(sourceRef: string, _sinceCursor: string | null): Promise<Unit[]> {
    return this.units.filter((u) => u.sourceRef === sourceRef);
  }

  /** Gateway event drain: resolve one thread unit by its root ts (mirrors ComposioConnector). */
  async fetchThreadUnit(channel: string, threadTs: string): Promise<Unit | null> {
    return this.units.find((u) => u.sourceRef === channel && u.externalId === `${channel}/${threadTs}`) ?? null;
  }

  /* ── DocumentConnector — the guest-checkout PRD fixture, shared with eval (golden-prd.ts) ── */

  async listDocuments(containerRef: string, _statusProperty: string | null): Promise<DocMeta[]> {
    return [{ ...goldenPrdMeta(this.opts.docStateValue ?? "In review"), containerRef }];
  }

  async fetchDocumentSections(_pageId: string): Promise<DocSection[]> {
    return goldenPrdSections();
  }

  async writeComment(pageId: string, body: string, anchorBlockId?: string | null): Promise<{ commentRef: string }> {
    this.comments.push({ pageId, body, anchorBlockId: anchorBlockId ?? null });
    return { commentRef: "stub-comment-1" };
  }

  static sample(): Unit[] {
    return [
      {
        externalId: "C_STUB/1699000001.0001",
        sourceRef: "C_STUB",
        sourceName: "eng-decisions",
        ts: "1699000001.0001",
        authors: ["@alice", "@bob"],
        permalink: "https://example.slack.com/archives/C_STUB/p16990000010001",
        text:
          "@alice: should auth tokens be JWT or server-side sessions?\n" +
          "@bob: JWT keeps us stateless across services. I say JWT, 15-min expiry.\n" +
          "@alice: agreed — let's lock it: JWT with 15-minute expiry, refresh via /auth/session. Shipping it.",
      },
      {
        externalId: "C_STUB/1699000002.0002",
        sourceRef: "C_STUB",
        sourceName: "eng-decisions",
        ts: "1699000002.0002",
        authors: ["@carol"],
        permalink: "https://example.slack.com/archives/C_STUB/p16990000020002",
        text: "@carol: anyone grabbing lunch? the cafeteria line is huge today lol",
      },
    ];
  }
}
