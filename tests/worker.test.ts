import { expect, test } from "bun:test";
import worker, { type Env } from "../server/worker";

function makeEnv() {
  const store = new Map<string, { value: ArrayBuffer; expirationTtl: number }>();
  const env: Env = {
    AUTH_TOKEN: "test-token",
    ARTIFACTS: {
      async put(key: string, value: ArrayBuffer, opts: { expirationTtl: number }) {
        store.set(key, { value, expirationTtl: opts.expirationTtl });
      },
      async get(key: string, _type: "arrayBuffer") {
        return store.get(key)?.value ?? null;
      },
    },
  };
  return { env, store };
}

function putReq(body: BodyInit | null, opts: { ttl?: string; token?: string | null } = {}) {
  const headers = new Headers();
  if (opts.token !== null) headers.set("Authorization", `Bearer ${opts.token ?? "test-token"}`);
  const qs = opts.ttl ? `?ttl=${opts.ttl}` : "";
  return new Request(`https://share.test/api/artifacts${qs}`, { method: "PUT", headers, body });
}

test("PUT without auth is rejected", async () => {
  const { env } = makeEnv();
  expect((await worker.fetch(putReq("data", { token: null }), env)).status).toBe(401);
  expect((await worker.fetch(putReq("data", { token: "wrong" }), env)).status).toBe(401);
});

test("PUT stores blob with default 7d TTL and returns id", async () => {
  const { env, store } = makeEnv();
  const res = await worker.fetch(putReq("ciphertext-bytes"), env);
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 bytes base64url, unpadded
  expect(store.get(id)!.expirationTtl).toBe(604800);
});

test("PUT honors valid ttl and rejects invalid ttl", async () => {
  const { env, store } = makeEnv();
  const ok = await worker.fetch(putReq("x", { ttl: "1h" }), env);
  const { id } = (await ok.json()) as { id: string };
  expect(store.get(id)!.expirationTtl).toBe(3600);
  expect((await worker.fetch(putReq("x", { ttl: "2h" }), env)).status).toBe(400);
});

test("PUT rejects empty body", async () => {
  const { env } = makeEnv();
  expect((await worker.fetch(putReq(null), env)).status).toBe(400);
});

test("PUT rejects bodies over 20 MB", async () => {
  const { env } = makeEnv();
  const big = new Uint8Array(20 * 1024 * 1024 + 1);
  expect((await worker.fetch(putReq(big), env)).status).toBe(413);
});

test("GET returns stored ciphertext, 404 when missing", async () => {
  const { env } = makeEnv();
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  const putRes = await worker.fetch(putReq(bytes), env);
  const { id } = (await putRes.json()) as { id: string };

  const res = await worker.fetch(new Request(`https://share.test/api/artifacts/${id}`), env);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

  const missing = await worker.fetch(new Request("https://share.test/api/artifacts/nope"), env);
  expect(missing.status).toBe(404);
});

test("unknown routes 404", async () => {
  const { env } = makeEnv();
  expect((await worker.fetch(new Request("https://share.test/whatever"), env)).status).toBe(404);
});
