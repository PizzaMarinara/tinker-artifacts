import viewerHtml from "./viewer-html";
import deleteHtml from "./delete-html";
import landingHtml from "./landing-html";
import "../shared/sig.js";

const tsig = (globalThis as any).tinkerSig;

export interface ArtifactMetadata {
  by: string;
  delHash: string;
  exp: number;
}

// Minimal KV surface we use — avoids the @cloudflare/workers-types devDependency.
export interface KVNamespace {
  put(key: string, value: ArrayBuffer, opts: { expirationTtl: number; metadata: ArtifactMetadata }): Promise<void>;
  getWithMetadata(
    key: string,
    type: "arrayBuffer",
  ): Promise<{ value: ArrayBuffer | null; metadata: ArtifactMetadata | null }>;
  delete(key: string): Promise<void>;
}

export interface Env {
  ARTIFACTS: KVNamespace;
  UPLOAD_KEYS?: string;
  TTL_OPTIONS?: string;
  DEFAULT_TTL?: string;
}

const MAX_BYTES = 20 * 1024 * 1024;
const CREATED_WINDOW_S = 300;
const MIN_TTL_S = 60;
const MAX_TTL_S = 365 * 86400;

export function parseDuration(s: string): number | null {
  const m = /^(\d{1,4})([mhd])$/.exec(s);
  if (!m) return null;
  const mult = m[2] === "m" ? 60 : m[2] === "h" ? 3600 : 86400;
  const secs = Number(m[1]) * mult;
  return secs >= MIN_TTL_S && secs <= MAX_TTL_S ? secs : null;
}

function ttlConfig(env: Env): { options: string[]; def: string } | null {
  const options = (env.TTL_OPTIONS ?? "1h,1d,7d,30d").split(",").map((s) => s.trim()).filter(Boolean);
  const def = env.DEFAULT_TTL ?? "7d";
  if (options.length === 0 || options.some((o) => parseDuration(o) === null)) return null;
  if (!options.includes(def)) return null;
  return { options, def };
}

function newId(): string {
  return tsig.b64uEncode(crypto.getRandomValues(new Uint8Array(16)));
}

async function sha256b64(bytes: Uint8Array): Promise<string> {
  return tsig.b64Encode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseUploadKeys(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf(":");
    if (idx < 1) return new Map();
    const name = pair.slice(0, idx).trim();
    const key = pair.slice(idx + 1).trim();
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || !/^[A-Za-z0-9_-]{43}$/.test(key)) return new Map();
    map.set(name, key);
  }
  return map;
}

// Returns the authenticated keyid, or null (any failure — caller returns one generic 401).
async function verifySignedPut(request: Request, bodyBytes: Uint8Array, url: URL, env: Env): Promise<string | null> {
  const keys = parseUploadKeys(env.UPLOAD_KEYS);
  if (keys.size === 0) return null;
  const sigInputHeader = request.headers.get("Signature-Input");
  const sigHeader = request.headers.get("Signature");
  const cdHeader = request.headers.get("Content-Digest");
  if (!sigInputHeader || !sigHeader || !cdHeader) return null;
  const parsed = tsig.parseSignatureInput(sigInputHeader);
  const sigB64 = tsig.parseSignature(sigHeader);
  if (!parsed || !sigB64) return null;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.created) > CREATED_WINDOW_S) return null;
  const pubB64u = keys.get(parsed.keyid);
  if (!pubB64u) return null;
  const expectedCd = await tsig.contentDigestHeader(bodyBytes);
  if (!constantTimeEqual(cdHeader, expectedCd)) return null;
  const query = url.search === "" ? "?" : url.search;
  const base = tsig.buildSignatureBase(request.method, url.pathname, query, cdHeader, parsed.created, parsed.keyid);
  try {
    const pubKey = await crypto.subtle.importKey("raw", tsig.b64uDecode(pubB64u), "Ed25519", false, ["verify"]);
    const ok = await crypto.subtle.verify(
      "Ed25519",
      pubKey,
      tsig.b64Decode(sigB64),
      new TextEncoder().encode(base),
    );
    return ok ? parsed.keyid : null;
  } catch {
    return null;
  }
}

function page(html: string): Response {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "img-src data: blob:; font-src data:; media-src data: blob:; " +
        "connect-src 'self'; frame-src 'self' data: blob: about:",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "PUT" && url.pathname === "/api/artifacts") {
      const cfg = ttlConfig(env);
      if (!cfg) return Response.json({ error: "server ttl config invalid" }, { status: 500 });
      if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BYTES) {
        return Response.json({ error: "too large" }, { status: 413 });
      }
      const body = await request.arrayBuffer();
      const uploader = await verifySignedPut(request, new Uint8Array(body), url, env);
      if (!uploader) return Response.json({ error: "unauthorized" }, { status: 401 });
      const ttl = url.searchParams.get("ttl") ?? cfg.def;
      if (!cfg.options.includes(ttl)) {
        return Response.json({ error: `invalid ttl — allowed: ${cfg.options.join(", ")}` }, { status: 400 });
      }
      const expirationTtl = parseDuration(ttl)!;
      if (body.byteLength === 0) return Response.json({ error: "empty body" }, { status: 400 });
      if (body.byteLength > MAX_BYTES) return Response.json({ error: "too large" }, { status: 413 });
      const id = newId();
      const deleteToken = newId();
      const delHash = await sha256b64(new TextEncoder().encode(deleteToken));
      const exp = Math.floor(Date.now() / 1000) + expirationTtl;
      await env.ARTIFACTS.put(id, body, { expirationTtl, metadata: { by: uploader, delHash, exp } });
      return Response.json({ id, deleteToken });
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/artifacts/")) {
      const id = url.pathname.slice("/api/artifacts/".length);
      const { value, metadata } = await env.ARTIFACTS.getWithMetadata(id, "arrayBuffer");
      if (!value) return Response.json({ error: "not found" }, { status: 404 });
      return new Response(value, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Expires-At": String(metadata?.exp ?? ""),
        },
      });
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/artifacts/")) {
      const id = url.pathname.slice("/api/artifacts/".length);
      const token = request.headers.get("X-Delete-Token");
      const { value, metadata } = await env.ARTIFACTS.getWithMetadata(id, "arrayBuffer");
      if (!value || !metadata) return Response.json({ error: "not found" }, { status: 404 });
      const presented = token ? await sha256b64(new TextEncoder().encode(token)) : "";
      if (!token || !constantTimeEqual(presented, metadata.delHash)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      await env.ARTIFACTS.delete(id);
      return Response.json({ deleted: true });
    }

    if (request.method === "GET" && url.pathname.startsWith("/a/")) return page(viewerHtml);
    if (request.method === "GET" && url.pathname.startsWith("/d/")) return page(deleteHtml);
    if (request.method === "GET" && url.pathname === "/") return page(landingHtml);

    return new Response("not found", { status: 404 });
  },
};
