/**
 * Canonical surface extraction — TS port of actions/pr-check/surface.mjs, used by the GitHub
 * webhook path (PR-merge → changed files → surfaces → recordChange). The action stays vendored
 * and dependency-free because it runs inside user CI; core cannot import a .mjs outside its
 * rootDir — so this is a deliberate copy, ~90 lines that change rarely.
 *
 * KEEP IN SYNC with actions/pr-check/surface.mjs and packages/cli/src/capture/surface.ts
 * (surface-extract.parity.test.ts pins TS-port ↔ action equivalence on shared fixtures).
 */

const HTTP_VERBS = "get|post|put|patch|delete|options|head|all";

function normalizePath(p: string): string {
  let s = p.split("?")[0]!.trim();
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\{([^}]+)\}/g, ":$1");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s;
}

const httpId = (method: string, path: string): string =>
  `http:${method.toUpperCase() === "ALL" ? "ANY" : method.toUpperCase()} ${normalizePath(path)}`;

function extractExpressRoutes(content: string): string[] {
  const re = new RegExp(`\\.(${HTTP_VERBS})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, "gi");
  const out: string[] = [];
  for (const m of content.matchAll(re)) out.push(httpId(m[1]!, m[2]!));
  return out;
}

function extractNextRoutes(path: string, content: string): string[] {
  const m = path.match(/(?:^|\/)app\/(.*)\/route\.(?:ts|tsx|js|mjs)$/i);
  if (!m) return [];
  const segments = m[1]!
    .split("/")
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
    .map((seg) => seg.replace(/^\[(?:\.\.\.)?([^\]]+)\]$/, ":$1"));
  const routePath = "/" + segments.join("/");
  const out: string[] = [];
  for (const v of content.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)) {
    out.push(httpId(v[1]!, routePath));
  }
  return out;
}

function extractProto(content: string): string[] {
  const pkg = content.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ?? "";
  const out: string[] = [];
  for (const svc of content.matchAll(/service\s+(\w+)\s*\{([\s\S]*?)\}/g)) {
    const service = svc[1]!;
    for (const rpc of svc[2]!.matchAll(/rpc\s+(\w+)\s*\(/g)) {
      out.push(`proto:${pkg ? pkg + "." : ""}${service}/${rpc[1]}`);
    }
  }
  return out;
}

function extractGraphql(content: string): string[] {
  const out: string[] = [];
  const blockRe = /\b(type|extend\s+type)\s+(Query|Mutation|Subscription)\s*\{([\s\S]*?)\}/g;
  for (const block of content.matchAll(blockRe)) {
    const root = block[2]!;
    for (const field of block[3]!.matchAll(/^\s*(\w+)\s*[(:]/gm)) out.push(`gql:${root}.${field[1]}`);
  }
  return out;
}

const isHttpRoutey = (path: string): boolean =>
  /(^|\/)(routes?|controllers?|api|handlers?|endpoints?)(\/|\.)/i.test(path);

/** Every canonical surface id a changed file *defines*. [] for files with no public interface. */
export function extractSurfaces(path: string, content: string): string[] {
  const out = new Set<string>();
  if (/\.proto$/i.test(path) && content) extractProto(content).forEach((s) => out.add(s));
  if (/\.(graphql|gql)$/i.test(path) && content) extractGraphql(content).forEach((s) => out.add(s));
  if (/\.(ts|tsx|js|mjs|cjs)$/i.test(path) && content) {
    extractNextRoutes(path, content).forEach((s) => out.add(s));
    if (isHttpRoutey(path) || /\b(express|fastify|router|app)\b/.test(content)) {
      extractExpressRoutes(content).forEach((s) => out.add(s));
    }
  }
  return [...out];
}

/** Pre-filter: is this a file we should even read for surfaces? (mirrors capture/classify.ts) */
export function isContractSurface(path: string): boolean {
  if (/(openapi|swagger)/i.test(path) && /\.(ya?ml|json)$/i.test(path)) return true;
  if (/\.(proto|graphql|gql)$/i.test(path)) return true;
  if (/(^|\/)(routes?|controllers?|api|handlers?|endpoints?|contracts?)(\/|\.)/i.test(path)) return true;
  return false;
}
