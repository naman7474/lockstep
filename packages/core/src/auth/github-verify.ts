import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub webhook signing: X-Hub-Signature-256 = "sha256=" + HMAC_SHA256(secret, rawBody).
 * Hand-rolled on node:crypto, mirroring slack-verify.ts — same minimal-dep posture.
 */
export function verifyGitHubSignature(input: {
  secret: string;
  signature: string | undefined;
  rawBody: string;
}): boolean {
  if (!input.signature) return false;
  const expected = `sha256=${createHmac("sha256", input.secret).update(input.rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(input.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
