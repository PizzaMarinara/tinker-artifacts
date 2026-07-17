import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../shared/sig.js";
import { decryptEnvelope, deleteArtifact, keygen, loadConfig, push } from "../cli/tinker-share";

const tsig = (globalThis as any).tinkerSig;

test("keygen writes 0600 config and prints a registrable line", async () => {
  const home = mkdtempSync(join(tmpdir(), "tinker-keygen-"));
  const { line } = await keygen("laptop", { HOME: home });
  expect(line).toMatch(/^laptop:[A-Za-z0-9_-]{43}$/);
  const path = join(home, ".config", "tinker-share", "config");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const cfg = loadConfig({ HOME: home, TINKER_SHARE_URL: "https://s.test/" });
  expect(cfg.url).toBe("https://s.test");
  expect(cfg.keyName).toBe("laptop");
  expect(cfg.privateKey.length).toBeGreaterThan(40);
});

test("keygen preserves existing non-key config lines and replaces old keys", async () => {
  const home = mkdtempSync(join(tmpdir(), "tinker-keygen2-"));
  const dir = join(home, ".config", "tinker-share");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config"), "TINKER_SHARE_URL=https://kept.test\n");
  await keygen("first", { HOME: home });
  await keygen("second", { HOME: home });
  const cfg = loadConfig({ HOME: home });
  expect(cfg.url).toBe("https://kept.test");
  expect(cfg.keyName).toBe("second");
});

test("loadConfig throws with keygen hint when key missing", () => {
  expect(() => loadConfig({ HOME: "/nonexistent-tinker", TINKER_SHARE_URL: "https://x.test" })).toThrow("keygen");
});

test("push signs a verifiable request and returns view + delete URLs", async () => {
  const home = mkdtempSync(join(tmpdir(), "tinker-push-"));
  const { line } = await keygen("pusher", { HOME: home });
  const pubB64u = line.split(":")[1];
  const pubKey = await crypto.subtle.importKey("raw", tsig.b64uDecode(pubB64u), "Ed25519", false, ["verify"]);

  let verified = false;
  let ttlSeen: string | null = null;
  let received: Uint8Array | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      ttlSeen = url.searchParams.get("ttl");
      received = new Uint8Array(await req.arrayBuffer());
      const cd = req.headers.get("Content-Digest")!;
      if (cd !== (await tsig.contentDigestHeader(received))) return new Response("bad digest", { status: 401 });
      const parsed = tsig.parseSignatureInput(req.headers.get("Signature-Input")!)!;
      const sigB64 = tsig.parseSignature(req.headers.get("Signature")!)!;
      const base = tsig.buildSignatureBase("PUT", url.pathname, url.search || "?", cd, parsed.created, parsed.keyid);
      verified =
        parsed.keyid === "pusher" &&
        (await crypto.subtle.verify("Ed25519", pubKey, tsig.b64Decode(sigB64), new TextEncoder().encode(base)));
      return Response.json({ id: "abc123", deleteToken: "tok456" });
    },
  });
  const config = loadConfig({ HOME: home, TINKER_SHARE_URL: `http://localhost:${server.port}` });
  const { viewUrl, deleteUrl } = await push("samples/notes.md", "1d", config);
  server.stop();

  expect(verified).toBe(true);
  expect(ttlSeen).toBe("1d");
  expect(viewUrl.startsWith(`http://localhost:${server.port}/a/abc123#`)).toBe(true);
  expect(deleteUrl).toBe(`http://localhost:${server.port}/d/abc123#tok456`);
  const envelope = await decryptEnvelope(received!, viewUrl.split("#")[1]);
  expect(envelope.type).toBe("md");
  expect(envelope.name).toBe("notes.md");
  expect(envelope.content).toBe(await Bun.file("samples/notes.md").text());
});

test("push rejects unsupported extensions and malformed server responses", async () => {
  const home = mkdtempSync(join(tmpdir(), "tinker-push2-"));
  await keygen("p", { HOME: home });
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
  const config = loadConfig({ HOME: home, TINKER_SHARE_URL: `http://localhost:${server.port}` });
  await expect(push("notes.txt", null, config)).rejects.toThrow("Unsupported");
  await expect(push("samples/notes.md", null, config)).rejects.toThrow("Malformed");
  server.stop();
});

test("deleteArtifact calls DELETE with the fragment token", async () => {
  let got: { path: string; token: string | null; method: string } | undefined;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      got = { path: url.pathname, token: req.headers.get("X-Delete-Token"), method: req.method };
      return Response.json({ deleted: true });
    },
  });
  await deleteArtifact(`http://localhost:${server.port}/d/abc123#tok456`);
  server.stop();
  expect(got).toEqual({ path: "/api/artifacts/abc123", token: "tok456", method: "DELETE" });
});

test("deleteArtifact rejects non-deletion URLs", async () => {
  await expect(deleteArtifact("https://x.test/a/abc#key")).rejects.toThrow("deletion URL");
});
