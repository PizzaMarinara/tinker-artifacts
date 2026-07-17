import { expect, test } from "bun:test";
import { handle, parseDuration, type ArtifactMetadata, type CoreConfig, type Storage } from "../server/core";
import "../shared/sig.js";

const tsig = (globalThis as any).tinkerSig;

const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
const otherPair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
const TEST_PUB = tsig.b64uEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));

function memStorage() {
  const store = new Map<string, { body: Uint8Array; ttlSeconds: number; metadata: ArtifactMetadata }>();
  const storage: Storage = {
    async put(id, body, opts) {
      store.set(id, { body, ttlSeconds: opts.ttlSeconds, metadata: opts.metadata });
    },
    async get(id) {
      const e = store.get(id);
      return e ? { body: e.body, metadata: e.metadata } : null;
    },
    async delete(id) {
      store.delete(id);
    },
  };
  return { storage, store };
}

function makeDeps(config: Partial<CoreConfig> = {}) {
  const { storage, store } = memStorage();
  return { deps: { storage, config: { uploadKeys: `test:${TEST_PUB}`, ...config } }, store };
}

interface SignOpts {
  ttl?: string;
  keyid?: string;
  privateKey?: CryptoKey;
  created?: number;
  signedQuery?: string;
  body?: BodyInit;
  sigInput?: string;
}

async function signedPut(bodyBytes: Uint8Array, opts: SignOpts = {}) {
  const query = opts.ttl === undefined ? "" : `?ttl=${opts.ttl}`;
  const signedQuery = opts.signedQuery ?? (query === "" ? "?" : query);
  const keyid = opts.keyid ?? "test";
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const cd = await tsig.contentDigestHeader(bodyBytes);
  const base = tsig.buildSignatureBase("PUT", "/api/artifacts", signedQuery, cd, created, keyid);
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign("Ed25519", opts.privateKey ?? pair.privateKey, new TextEncoder().encode(base)),
  );
  return new Request(`https://share.test/api/artifacts${query}`, {
    method: "PUT",
    headers: {
      "Content-Digest": cd,
      "Signature-Input": opts.sigInput ?? tsig.buildSignatureInput(created, keyid),
      Signature: "sig1=:" + tsig.b64Encode(sigBytes) + ":",
    },
    body: opts.body ?? bodyBytes,
  });
}

const BODY = new TextEncoder().encode("ciphertext-bytes");

test("signed PUT stores body+metadata and returns id + deleteToken", async () => {
  const { deps, store } = makeDeps();
  const res = await handle(await signedPut(BODY), deps);
  expect(res.status).toBe(200);
  const { id, deleteToken } = (await res.json()) as { id: string; deleteToken: string };
  expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(deleteToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
  const entry = store.get(id)!;
  expect(entry.ttlSeconds).toBe(604800);
  expect(entry.body).toEqual(BODY);
  expect(entry.metadata.by).toBe("test");
  const hash = tsig.b64Encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deleteToken))),
  );
  expect(entry.metadata.delHash).toBe(hash);
});

test("unsigned / tampered / wrong-key PUTs are 401", async () => {
  const { deps } = makeDeps();
  expect((await handle(new Request("https://share.test/api/artifacts", { method: "PUT", body: BODY }), deps)).status).toBe(401);
  expect((await handle(await signedPut(BODY, { body: new TextEncoder().encode("EVIL-bytes-here!") }), deps)).status).toBe(401);
  expect((await handle(await signedPut(BODY, { ttl: "30d", signedQuery: "?ttl=1h" }), deps)).status).toBe(401);
  expect((await handle(await signedPut(BODY, { privateKey: otherPair.privateKey }), deps)).status).toBe(401);
  expect((await handle(await signedPut(BODY, { keyid: "ghost" }), deps)).status).toBe(401);
});

test("stale/future created rejected; malformed uploadKeys fail closed", async () => {
  const now = Math.floor(Date.now() / 1000);
  const { deps } = makeDeps();
  expect((await handle(await signedPut(BODY, { created: now - 301 }), deps)).status).toBe(401);
  expect((await handle(await signedPut(BODY, { created: now + 301 }), deps)).status).toBe(401);
  expect((await handle(await signedPut(BODY), { storage: makeDeps().deps.storage, config: { uploadKeys: "" } })).status).toBe(401);
  expect((await handle(await signedPut(BODY), { storage: makeDeps().deps.storage, config: { uploadKeys: `test:${TEST_PUB},test:${TEST_PUB}` } })).status).toBe(401);
});

test("ttl config: honored, invalid 400, inconsistent config 500", async () => {
  const { deps, store } = makeDeps();
  const ok = await handle(await signedPut(BODY, { ttl: "1h" }), deps);
  expect(store.get((await ok.json() as { id: string }).id)!.ttlSeconds).toBe(3600);
  const bad = await handle(await signedPut(BODY, { ttl: "2h" }), deps);
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toContain("1h, 1d, 7d, 30d");
  const custom = makeDeps({ ttlOptions: "30m,2h", defaultTtl: "2h" });
  const c = await handle(await signedPut(BODY, { ttl: "30m" }), custom.deps);
  expect(custom.store.get((await c.json() as { id: string }).id)!.ttlSeconds).toBe(1800);
  const broken = makeDeps({ ttlOptions: "1h", defaultTtl: "7d" });
  expect((await handle(await signedPut(BODY), broken.deps)).status).toBe(500);
});

test("empty body 400, oversized 413 (even without Content-Length)", async () => {
  const { deps } = makeDeps();
  expect((await handle(await signedPut(new Uint8Array(0)), deps)).status).toBe(400);
  expect((await handle(await signedPut(new Uint8Array(20 * 1024 * 1024 + 1)), deps)).status).toBe(413);
});

test("GET returns body + X-Expires-At; 404 when missing; DELETE lifecycle", async () => {
  const { deps } = makeDeps();
  const putRes = await handle(await signedPut(BODY, { ttl: "1h" }), deps);
  const { id, deleteToken } = (await putRes.json()) as { id: string; deleteToken: string };
  const got = await handle(new Request(`https://share.test/api/artifacts/${id}`), deps);
  expect(got.status).toBe(200);
  expect(got.headers.get("Content-Type")).toBe("application/octet-stream");
  expect(got.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(new Uint8Array(await got.arrayBuffer())).toEqual(BODY);
  expect(Number(got.headers.get("X-Expires-At"))).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 3590);
  expect((await handle(new Request("https://share.test/api/artifacts/nope"), deps)).status).toBe(404);
  const del = (token?: string) =>
    handle(new Request(`https://share.test/api/artifacts/${id}`, { method: "DELETE", headers: token ? { "X-Delete-Token": token } : {} }), deps);
  expect((await del("wrong")).status).toBe(401);
  expect((await del(undefined)).status).toBe(401);
  expect((await del(deleteToken)).status).toBe(200);
  expect((await handle(new Request(`https://share.test/api/artifacts/${id}`), deps)).status).toBe(404);
  expect((await del(deleteToken)).status).toBe(404);
});

test("pages served; unknown routes 404", async () => {
  const { deps } = makeDeps();
  for (const [path, needle] of [["/a/x", "renderMd"], ["/d/x", "X-Delete-Token"], ["/", "tinker-artifacts"]] as const) {
    const res = await handle(new Request(`https://share.test${path}`), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("connect-src 'self'");
    expect(await res.text()).toContain(needle);
  }
  expect((await handle(new Request("https://share.test/whatever"), deps)).status).toBe(404);
});

test("parseDuration bounds", () => {
  expect(parseDuration("1m")).toBe(60);
  expect(parseDuration("365d")).toBe(31536000);
  expect(parseDuration("366d")).toBeNull();
  expect(parseDuration("30s")).toBeNull();
  expect(parseDuration("0m")).toBeNull();
});
