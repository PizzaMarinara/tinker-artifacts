import { expect, test } from "bun:test";
import "../shared/sig.js";

const tsig = (globalThis as any).tinkerSig;

test("signature base matches the RFC 9421 profile shape exactly", () => {
  const base = tsig.buildSignatureBase("put", "/api/artifacts", "?ttl=7d", "sha-256=:abc=:", 1750000000, "enrico");
  expect(base).toBe(
    '"@method": PUT\n' +
      '"@path": /api/artifacts\n' +
      '"@query": ?ttl=7d\n' +
      '"content-digest": sha-256=:abc=:\n' +
      '"@signature-params": ("@method" "@path" "@query" "content-digest");created=1750000000;keyid="enrico";alg="ed25519"',
  );
});

test("signature-input build/parse round-trip", () => {
  const h = tsig.buildSignatureInput(1750000000, "ci-bot.2");
  expect(h).toBe('sig1=("@method" "@path" "@query" "content-digest");created=1750000000;keyid="ci-bot.2";alg="ed25519"');
  expect(tsig.parseSignatureInput(h)).toEqual({ created: 1750000000, keyid: "ci-bot.2" });
});

test("parseSignatureInput rejects any deviation from the profile", () => {
  const cases = [
    'sig1=("@method" "@path" "content-digest");created=1;keyid="a";alg="ed25519"', // missing @query
    'sig1=("@method" "@path" "@query" "content-digest");created=1;keyid="a";alg="rsa-v1_5-sha256"', // wrong alg
    'sig2=("@method" "@path" "@query" "content-digest");created=1;keyid="a";alg="ed25519"', // wrong label
    'sig1=("@method" "@path" "@query" "content-digest");created=1;keyid="a";alg="ed25519";nonce="x"', // extra param
    'sig1=("@method" "@path" "@query" "content-digest");keyid="a";created=1;alg="ed25519"', // param order
    'sig1=("@method" "@path" "@query" "content-digest");created=1;keyid="a b";alg="ed25519"', // bad keyid charset
  ];
  for (const c of cases) expect(tsig.parseSignatureInput(c)).toBeNull();
});

test("parseSignature extracts base64, rejects junk", () => {
  expect(tsig.parseSignature("sig1=:aGVsbG8=:")).toBe("aGVsbG8=");
  expect(tsig.parseSignature("sig1=aGVsbG8=")).toBeNull();
  expect(tsig.parseSignature("sig1=:not*base64:")).toBeNull();
});

test("contentDigestHeader is RFC 9530 sha-256 with standard base64", async () => {
  const h = await tsig.contentDigestHeader(new TextEncoder().encode("hello"));
  expect(h).toBe("sha-256=:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=:");
});

test("b64 and b64u round-trip", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(33));
  expect(tsig.b64Decode(tsig.b64Encode(bytes))).toEqual(bytes);
  expect(tsig.b64uDecode(tsig.b64uEncode(bytes))).toEqual(bytes);
  expect(tsig.b64uEncode(bytes)).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("end-to-end Ed25519 sign/verify over a built base", async () => {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const base = tsig.buildSignatureBase("PUT", "/api/artifacts", "?", "sha-256=:x:", 1, "t");
  const sig = await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(base));
  expect(await crypto.subtle.verify("Ed25519", pair.publicKey, sig, new TextEncoder().encode(base))).toBe(true);
});
