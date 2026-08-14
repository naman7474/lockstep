import type { FastifyInstance } from "fastify";
import { env } from "../../env.js";
import { verifySlackSignature } from "../../auth/slack-verify.js";
import { enqueueSlackEvent } from "../../ingest/ingest-events-service.js";

/**
 * Slack Events API ingress (gateway) — live ingestion alongside the polling sweep. Own plugin:
 * Slack posts application/json and signs the RAW body (same v0 scheme as interactivity, reused
 * verbatim), so this scope parses JSON as a string; the parser stays encapsulated here (the
 * routes/slack.ts pattern — a root-level string parser would break every other JSON route).
 *
 * Fast-ack contract: Slack retries after 3s, so the handler only verifies + enqueues a ref row
 * (insert-only) and always 200s. Distillation happens in the worker's fast loop.
 */
export async function slackEventsRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post("/webhooks/slack/events", async (req, reply) => {
    const secret = env.LOCKSTEP_SLACK_SIGNING_SECRET;
    if (!secret) return reply.code(503).send({ error: "slack events not configured" });
    const rawBody = req.body as string;
    const ok = verifySlackSignature({
      signingSecret: secret,
      timestamp: req.headers["x-slack-request-timestamp"] as string | undefined,
      signature: req.headers["x-slack-signature"] as string | undefined,
      rawBody,
    });
    if (!ok) return reply.code(401).send({ error: "bad signature" });

    let payload: {
      type?: string;
      challenge?: string;
      event?: { type?: string; subtype?: string; bot_id?: string; channel?: string; ts?: string; thread_ts?: string };
    };
    try {
      payload = JSON.parse(rawBody) as typeof payload;
    } catch {
      return reply.code(400).send({ error: "invalid JSON" });
    }

    if (payload.type === "url_verification") return { challenge: payload.challenge };
    if (payload.type !== "event_callback") return { ok: true };

    const ev = payload.event;
    // Human messages only: no bot echoes; plain messages + thread broadcasts (edits/joins have subtypes).
    const humanMessage =
      ev?.type === "message" &&
      !ev.bot_id &&
      (ev.subtype === undefined || ev.subtype === "thread_broadcast") &&
      ev.channel &&
      ev.ts;
    if (humanMessage) {
      await enqueueSlackEvent({ channel: ev.channel!, ts: ev.ts!, threadTs: ev.thread_ts }).catch(() => false);
    }
    return { ok: true };
  });
}
