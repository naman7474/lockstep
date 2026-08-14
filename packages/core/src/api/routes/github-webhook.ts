import type { FastifyInstance } from "fastify";
import { env } from "../../env.js";
import { verifyGitHubSignature } from "../../auth/github-verify.js";
import { processGitHubEvent } from "../../gateway/github-webhook-service.js";

/**
 * GitHub webhook ingress (gateway). Own plugin so the raw-body JSON parser stays encapsulated —
 * registering a string parser at the app root would break every other JSON route (same pattern as
 * routes/slack.ts). GitHub signs the raw body (X-Hub-Signature-256); verification MUST precede parse.
 */
export async function githubWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post("/webhooks/github", async (req, reply) => {
    if (!env.GITHUB_WEBHOOK_SECRET) return reply.code(503).send({ error: "github webhook not configured" });
    const rawBody = req.body as string;
    const ok = verifyGitHubSignature({
      secret: env.GITHUB_WEBHOOK_SECRET,
      signature: req.headers["x-hub-signature-256"] as string | undefined,
      rawBody,
    });
    if (!ok) return reply.code(401).send({ error: "bad signature" });

    const event = (req.headers["x-github-event"] as string | undefined) ?? "";
    if (event === "ping") return { ok: true, pong: true };

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return reply.code(400).send({ error: "invalid JSON" });
    }
    // Always 200 for verified deliveries — GitHub retries 4xx/5xx and the skip reasons are ours.
    return processGitHubEvent(event, payload as Parameters<typeof processGitHubEvent>[1]);
  });
}
