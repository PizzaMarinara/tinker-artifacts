import { expect, test } from "bun:test";
import worker, { type Env } from "../server/cf";
import { parseDuration, type ArtifactMetadata } from "../server/core";
import "../shared/sig.js";

const tsig = (globalThis as any).tinkerSig;

const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
const otherPair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
const TEST_PUB = tsig.b64uEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));

function makeEnv(overrides: Partial<Env> = {}) {
  const store = new Map<string, { value: ArrayBuffer; expirationTtl: number; metadata: ArtifactMetadata }>();
  const env: Env = {
    UPLOAD_KEYS: `test:${TEST_PUB}`,
    ARTIFACTS: {
      async put(key: string, value: ArrayBuffer, opts: { expirationTtl: number; metadata: ArtifactMetadata }) {
        store.set(key, { value, expirationTtl: opts.expirationTtl, metadata: opts.metadata });
      },
      async getWithMetadata(key: string, _type: "arrayBuffer") {
        const e = store.get(key);
        return { value: e?.value ?? null, metadata: e?.metadata ?? null };
      },
      async delete(key: string) {
        store.delete(key);
      },
    },
    ...overrides,
  };
  return { env, store };
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

test("signed PUT stores blob with metadata and returns id + deleteToken", async () => {
  const { env, store } = makeEnv();
  const res = await worker.fetch(await signedPut(BODY), env);
  expect(res.status).toBe(200);
  const { id, deleteToken } = (await res.json()) as { id: string; deleteToken: string };
  expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(deleteToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
  const entry = store.get(id)!;
  expect(entry.expirationTtl).toBe(604800);
  expect(new Uint8Array(entry.value)).toEqual(BODY);
  expect(entry.metadata.by).toBe("test");
  expect(entry.metadata.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  const hash = tsig.b64Encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deleteToken))));
  expect(entry.metadata.delHash).toBe(hash);
});

test("unsigned PUT is rejected", async () => {
  const { env } = makeEnv();
  const bare = new Request("https://share.test/api/artifacts", { method: "PUT", body: BODY });
  const res = await worker.fetch(bare, env);
  expect(res.status).toBe(401);
  expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
});

test("tampered body is rejected", async () => {
  const { env } = makeEnv();
  const req = await signedPut(BODY, { body: new TextEncoder().encode("EVIL-bytes-here!") });
  expect((await worker.fetch(req, env)).status).toBe(401);
});

test("tampered query (ttl swap after signing) is rejected", async () => {
  const { env } = makeEnv();
  const req = await signedPut(BODY, { ttl: "30d", signedQuery: "?ttl=1h" });
  expect((await worker.fetch(req, env)).status).toBe(401);
});

test("stale and future created are rejected", async () => {
  const { env } = makeEnv();
  const now = Math.floor(Date.now() / 1000);
  expect((await worker.fetch(await signedPut(BODY, { created: now - 301 }), env)).status).toBe(401);
  expect((await worker.fetch(await signedPut(BODY, { created: now + 301 }), env)).status).toBe(401);
});

test("unknown keyid and wrong key are rejected", async () => {
  const { env } = makeEnv();
  expect((await worker.fetch(await signedPut(BODY, { keyid: "ghost" }), env)).status).toBe(401);
  expect((await worker.fetch(await signedPut(BODY, { privateKey: otherPair.privateKey }), env)).status).toBe(401);
});

test("non-profile Signature-Input is rejected", async () => {
  const { env } = makeEnv();
  const created = Math.floor(Date.now() / 1000);
  const bad = `sig1=("@method" "@path" "content-digest");created=${created};keyid="test";alg="ed25519"`;
  expect((await worker.fetch(await signedPut(BODY, { sigInput: bad }), env)).status).toBe(401);
});

test("missing, empty, or malformed UPLOAD_KEYS fails closed", async () => {
  expect((await worker.fetch(await signedPut(BODY), makeEnv({ UPLOAD_KEYS: "" }).env)).status).toBe(401);
  expect((await worker.fetch(await signedPut(BODY), makeEnv({ UPLOAD_KEYS: undefined }).env)).status).toBe(401);
  expect((await worker.fetch(await signedPut(BODY), makeEnv({ UPLOAD_KEYS: "garbage-no-colon" }).env)).status).toBe(401);
  // duplicate uploader name must fail closed (not silently shadow the earlier key)
  const dup = `test:${TEST_PUB},test:${TEST_PUB}`;
  expect((await worker.fetch(await signedPut(BODY), makeEnv({ UPLOAD_KEYS: dup }).env)).status).toBe(401);
});

test("oversized body is rejected before auth even with a lying Content-Length", async () => {
  const { env } = makeEnv();
  const big = new Uint8Array(20 * 1024 * 1024 + 1);
  const req = await signedPut(big); // signedPut sets no Content-Length; body cap must still apply
  expect((await worker.fetch(req, env)).status).toBe(413);
});

test("ttl honored; invalid ttl 400 lists allowed values", async () => {
  const { env, store } = makeEnv();
  const ok = await worker.fetch(await signedPut(BODY, { ttl: "1h" }), env);
  const { id } = (await ok.json()) as { id: string };
  expect(store.get(id)!.expirationTtl).toBe(3600);
  const bad = await worker.fetch(await signedPut(BODY, { ttl: "2h" }), env);
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toContain("1h, 1d, 7d, 30d");
});

test("custom TTL_OPTIONS/DEFAULT_TTL honored; inconsistent config 500", async () => {
  const { env, store } = makeEnv({ TTL_OPTIONS: "30m,2h", DEFAULT_TTL: "2h" });
  const res = await worker.fetch(await signedPut(BODY, { ttl: "30m" }), env);
  const { id } = (await res.json()) as { id: string };
  expect(store.get(id)!.expirationTtl).toBe(1800);
  const def = await worker.fetch(await signedPut(BODY), env);
  const { id: id2 } = (await def.json()) as { id: string };
  expect(store.get(id2)!.expirationTtl).toBe(7200);
  const broken = makeEnv({ TTL_OPTIONS: "1h", DEFAULT_TTL: "7d" }).env;
  expect((await worker.fetch(await signedPut(BODY), broken)).status).toBe(500);
});

test("empty body 400, oversized 413", async () => {
  const { env } = makeEnv();
  expect((await worker.fetch(await signedPut(new Uint8Array(0)), env)).status).toBe(400);
  const big = new Uint8Array(20 * 1024 * 1024 + 1);
  expect((await worker.fetch(await signedPut(big), env)).status).toBe(413);
});

test("parseDuration accepts m/h/d within bounds, rejects junk", () => {
  expect(parseDuration("1m")).toBe(60);
  expect(parseDuration("12h")).toBe(43200);
  expect(parseDuration("14d")).toBe(1209600);
  expect(parseDuration("365d")).toBe(31536000);
  expect(parseDuration("366d")).toBeNull();
  expect(parseDuration("30s")).toBeNull();
  expect(parseDuration("0m")).toBeNull();
  expect(parseDuration("7")).toBeNull();
  expect(parseDuration("dd")).toBeNull();
});

test("GET returns ciphertext with X-Expires-At; 404 when missing", async () => {
  const { env } = makeEnv();
  const putRes = await worker.fetch(await signedPut(BODY, { ttl: "1h" }), env);
  const { id } = (await putRes.json()) as { id: string };
  const res = await worker.fetch(new Request(`https://share.test/api/artifacts/${id}`), env);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(BODY);
  const exp = Number(res.headers.get("X-Expires-At"));
  expect(exp).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 3590);
  expect((await worker.fetch(new Request("https://share.test/api/artifacts/nope"), env)).status).toBe(404);
});

test("DELETE lifecycle: wrong token 401, correct token deletes, then 404s", async () => {
  const { env } = makeEnv();
  const putRes = await worker.fetch(await signedPut(BODY), env);
  const { id, deleteToken } = (await putRes.json()) as { id: string; deleteToken: string };
  const del = (token?: string) =>
    worker.fetch(
      new Request(`https://share.test/api/artifacts/${id}`, {
        method: "DELETE",
        headers: token ? { "X-Delete-Token": token } : {},
      }),
      env,
    );
  expect((await del("wrong-token")).status).toBe(401);
  expect((await del(undefined)).status).toBe(401);
  const ok = await del(deleteToken);
  expect(ok.status).toBe(200);
  expect((await ok.json()) as { deleted: boolean }).toEqual({ deleted: true });
  expect((await worker.fetch(new Request(`https://share.test/api/artifacts/${id}`), env)).status).toBe(404);
  expect((await del(deleteToken)).status).toBe(404);
});

test("unknown routes 404", async () => {
  const { env } = makeEnv();
  expect((await worker.fetch(new Request("https://share.test/whatever"), env)).status).toBe(404);
});
