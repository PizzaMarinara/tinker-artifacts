// Minimal KV surface we use — avoids the @cloudflare/workers-types devDependency.
export interface KVNamespace {
  put(key: string, value: ArrayBuffer, opts: { expirationTtl: number }): Promise<void>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
}

export interface Env {
  ARTIFACTS: KVNamespace;
  AUTH_TOKEN: string;
}

const TTL_SECONDS: Record<string, number> = { "1h": 3600, "1d": 86400, "7d": 604800, "30d": 2592000 };
const MAX_BYTES = 20 * 1024 * 1024;

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "PUT" && url.pathname === "/api/artifacts") {
      if (request.headers.get("Authorization") !== `Bearer ${env.AUTH_TOKEN}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const ttl = url.searchParams.get("ttl") ?? "7d";
      const expirationTtl = TTL_SECONDS[ttl];
      if (!expirationTtl) return Response.json({ error: "invalid ttl" }, { status: 400 });
      const body = await request.arrayBuffer();
      if (body.byteLength === 0) return Response.json({ error: "empty body" }, { status: 400 });
      if (body.byteLength > MAX_BYTES) return Response.json({ error: "too large" }, { status: 413 });
      const id = newId();
      await env.ARTIFACTS.put(id, body, { expirationTtl });
      return Response.json({ id });
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/artifacts/")) {
      const id = url.pathname.slice("/api/artifacts/".length);
      const blob = await env.ARTIFACTS.get(id, "arrayBuffer");
      if (!blob) return Response.json({ error: "not found" }, { status: 404 });
      return new Response(blob, {
        headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
      });
    }

    return new Response("not found", { status: 404 });
  },
};
