import { expect, test } from "bun:test";
import { b64uDecode, b64uEncode, decryptEnvelope, encryptEnvelope, type Envelope } from "../cli/tinker-share";

test("b64u round-trip", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(33));
  expect(b64uDecode(b64uEncode(bytes))).toEqual(bytes);
});

test("b64u output is URL-safe and unpadded", () => {
  const s = b64uEncode(Uint8Array.from({ length: 256 }, (_, i) => i));
  expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("encrypt/decrypt round-trip preserves envelope", async () => {
  const envelope: Envelope = { type: "md", name: "notes.md", content: "# hi\nàéü 😀" };
  const { blob, key } = await encryptEnvelope(envelope);
  expect(blob.length).toBeGreaterThan(12);
  expect(await decryptEnvelope(blob, key)).toEqual(envelope);
});

test("fresh key and IV per artifact", async () => {
  const envelope: Envelope = { type: "html", name: "a.html", content: "x" };
  const a = await encryptEnvelope(envelope);
  const b = await encryptEnvelope(envelope);
  expect(a.key).not.toBe(b.key);
  expect(a.blob.slice(0, 12)).not.toEqual(b.blob.slice(0, 12));
});

test("tampered ciphertext fails to decrypt", async () => {
  const { blob, key } = await encryptEnvelope({ type: "md", name: "n", content: "secret" });
  blob[blob.length - 1] ^= 0xff;
  await expect(decryptEnvelope(blob, key)).rejects.toThrow();
});

test("wrong key fails to decrypt", async () => {
  const { blob } = await encryptEnvelope({ type: "md", name: "n", content: "secret" });
  const wrong = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
  await expect(decryptEnvelope(blob, wrong)).rejects.toThrow();
});
