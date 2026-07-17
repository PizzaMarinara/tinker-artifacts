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

export interface Storage {
  put(id: string, body: Uint8Array, opts: { ttlSeconds: number; metadata: ArtifactMetadata }): Promise<void>;
  get(id: string): Promise<{ body: Uint8Array; metadata: ArtifactMetadata } | null>;
  delete(id: string): Promise<void>;
}

export interface CoreConfig {
  uploadKeys?: string;
  ttlOptions?: string;
  defaultTtl?: string;
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

function ttlConfig(config: CoreConfig): { options: string[]; def: string } | null {
  const options = (config.ttlOptions ?? "1h,1d,7d,30d").split(",").map((s) => s.trim()).filter(Boolean);
  const def = config.defaultTtl ?? "7d";
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

function failClosed(reason: string): Map<string, string> {
  console.error(`UPLOAD_KEYS malformed (${reason}) — rejecting all uploads`);
  return new Map();
}

function parseUploadKeys(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf(":");
    if (idx < 1) return failClosed("entry has no name:key form");
    const name = pair.slice(0, idx).trim();
    const key = pair.slice(idx + 1).trim();
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
      return failClosed(`entry "${name}" has an invalid name or public key`);
    }
    if (map.has(name)) return failClosed(`duplicate uploader name "${name}"`);
    map.set(name, key);
  }
  return map;
}

async function verifySignedPut(
  request: Request,
  bodyBytes: Uint8Array,
  url: URL,
  config: CoreConfig,
): Promise<string | null> {
  const keys = parseUploadKeys(config.uploadKeys);
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
    const ok = await crypto.subtle.verify("Ed25519", pubKey, tsig.b64Decode(sigB64), new TextEncoder().encode(base));
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

export async function handle(request: Request, deps: { storage: Storage; config: CoreConfig }): Promise<Response> {
  const { storage, config } = deps;
  const url = new URL(request.url);

  if (request.method === "PUT" && url.pathname === "/api/artifacts") {
    const cfg = ttlConfig(config);
    if (!cfg) return Response.json({ error: "server ttl config invalid" }, { status: 500 });
    if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BYTES) {
      return Response.json({ error: "too large" }, { status: 413 });
    }
    const bodyBuf = await request.arrayBuffer();
    if (bodyBuf.byteLength > MAX_BYTES) return Response.json({ error: "too large" }, { status: 413 });
    const body = new Uint8Array(bodyBuf);
    const uploader = await verifySignedPut(request, body, url, config);
    if (!uploader) return Response.json({ error: "unauthorized" }, { status: 401 });
    const ttl = url.searchParams.get("ttl") ?? cfg.def;
    if (!cfg.options.includes(ttl)) {
      return Response.json({ error: `invalid ttl — allowed: ${cfg.options.join(", ")}` }, { status: 400 });
    }
    const ttlSeconds = parseDuration(ttl)!;
    if (body.byteLength === 0) return Response.json({ error: "empty body" }, { status: 400 });
    const id = newId();
    const deleteToken = newId();
    const delHash = await sha256b64(new TextEncoder().encode(deleteToken));
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    await storage.put(id, body, { ttlSeconds, metadata: { by: uploader, delHash, exp } });
    return Response.json({ id, deleteToken });
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/artifacts/")) {
    const id = url.pathname.slice("/api/artifacts/".length);
    const found = await storage.get(id);
    if (!found) return Response.json({ error: "not found" }, { status: 404 });
    return new Response(found.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Expires-At": String(found.metadata.exp),
      },
    });
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/artifacts/")) {
    const id = url.pathname.slice("/api/artifacts/".length);
    const token = request.headers.get("X-Delete-Token");
    const found = await storage.get(id);
    if (!found) return Response.json({ error: "not found" }, { status: 404 });
    const presented = token ? await sha256b64(new TextEncoder().encode(token)) : "";
    if (!token || !constantTimeEqual(presented, found.metadata.delHash)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    await storage.delete(id);
    return Response.json({ deleted: true });
  }

  if (request.method === "GET" && url.pathname.startsWith("/a/")) return page(viewerHtml);
  if (request.method === "GET" && url.pathname.startsWith("/d/")) return page(deleteHtml);
  if (request.method === "GET" && url.pathname === "/") return page(landingHtml);

  return new Response("not found", { status: 404 });
}
