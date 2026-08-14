import { createSign } from "node:crypto";
import { env } from "../env.js";

const GH = "https://github.com";
const API = "https://api.github.com";

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export interface GhUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

function clientId(): string {
  if (!env.GITHUB_APP_CLIENT_ID) throw new Error("GITHUB_APP_CLIENT_ID not configured");
  return env.GITHUB_APP_CLIENT_ID;
}

/** Step 1 of device flow: request device + user codes. */
export async function startDeviceFlow(): Promise<DeviceCode> {
  const res = await fetch(`${GH}/login/device/code`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId() }),
  });
  if (!res.ok) throw new Error(`github device/code ${res.status}`);
  return (await res.json()) as DeviceCode;
}

/** Step 2: poll for the user-to-server token. Returns { access_token } or { error }. */
export async function pollDeviceFlow(
  deviceCode: string,
): Promise<{ access_token?: string; error?: string; interval?: number }> {
  const res = await fetch(`${GH}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId(),
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  return (await res.json()) as { access_token?: string; error?: string; interval?: number };
}

/**
 * Web OAuth (dashboard "Sign in with GitHub"): exchange the authorization `code` for a
 * user-to-server access token. Uses the App's client_id + client_secret. The dashboard performs the
 * redirect dance and hands us the code; the secret never leaves the core.
 */
export async function exchangeWebCode(
  code: string,
  redirectUri?: string,
): Promise<{ access_token?: string; error?: string }> {
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) {
    throw new Error("GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET not configured");
  }
  const res = await fetch(`${GH}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    }),
  });
  if (!res.ok) return { error: `github access_token ${res.status}` };
  return (await res.json()) as { access_token?: string; error?: string };
}

export async function getUser(userToken: string): Promise<GhUser> {
  const res = await fetch(`${API}/user`, {
    headers: { authorization: `Bearer ${userToken}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`github /user ${res.status}`);
  return (await res.json()) as GhUser;
}

/** True if this user's GitHub token can see the repo (GitHub returns 404 for no access). */
export async function userCanAccessRepo(userToken: string, owner: string, repo: string): Promise<boolean> {
  const res = await fetch(`${API}/repos/${owner}/${repo}`, {
    headers: { authorization: `Bearer ${userToken}`, accept: "application/vnd.github+json" },
  });
  return res.ok;
}

/* ───────── App-level auth: installation tokens for reading CODEOWNERS (P2) ───────── */

function appJwt(): string {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub App (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY) not configured");
  }
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = enc({ alg: "RS256", typ: "JWT" });
  const payload = enc({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID });
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const sig = signer.sign(env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n")).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

/** Find the App installation id for a repo (App must be installed on it). */
export async function repoInstallationId(owner: string, repo: string): Promise<number> {
  const res = await fetch(`${API}/repos/${owner}/${repo}/installation`, {
    headers: { authorization: `Bearer ${appJwt()}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`installation lookup ${res.status}`);
  return ((await res.json()) as { id: number }).id;
}

/** Verify a GitHub App installation id and return the account (org/user) login it's installed on. */
export async function installationAccount(installationId: number): Promise<string> {
  const res = await fetch(`${API}/app/installations/${installationId}`, {
    headers: { authorization: `Bearer ${appJwt()}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`installation lookup ${res.status}`);
  return ((await res.json()) as { account?: { login?: string } }).account?.login ?? "";
}

export async function installationToken(installationId: number): Promise<string> {
  const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${appJwt()}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`installation token ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

/** Changed files of a PR via an installation token (webhook path). Paginated, capped at 300. */
export async function listPrFiles(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<Array<{ filename: string; status: string }>> {
  const token = await installationToken(installationId);
  const out: Array<{ filename: string; status: string }> = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`pr files ${res.status}`);
    const batch = (await res.json()) as Array<{ filename: string; status: string }>;
    out.push(...batch.map((f) => ({ filename: f.filename, status: f.status })));
    if (batch.length < 100) break;
  }
  return out;
}

/** Read a single file (e.g. CODEOWNERS) via an installation token. Returns null on 404. */
export async function getFile(
  installationId: number,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<{ content: string; sha: string } | null> {
  const token = await installationToken(installationId);
  const url = new URL(`${API}/repos/${owner}/${repo}/contents/${path}`);
  if (ref) url.searchParams.set("ref", ref);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`contents ${res.status}`);
  const j = (await res.json()) as { content?: string; encoding?: string; sha?: string };
  if (!j.content) return null;
  return {
    content: Buffer.from(j.content, (j.encoding as BufferEncoding) ?? "base64").toString("utf8"),
    sha: j.sha ?? "",
  };
}
