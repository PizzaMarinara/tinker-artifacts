import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptEnvelope, loadConfig, push } from "../cli/tinker-share";

test("loadConfig prefers env vars and strips trailing slash", () => {
  const c = loadConfig({ TINKER_SHARE_URL: "https://s.test/", TINKER_SHARE_TOKEN: "t" });
  expect(c).toEqual({ url: "https://s.test", token: "t" });
});

test("loadConfig falls back to ~/.config/tinker-share/config", () => {
  const home = mkdtempSync(join(tmpdir(), "tinker-share-test-"));
  mkdirSync(join(home, ".config", "tinker-share"), { recursive: true });
  writeFileSync(
    join(home, ".config", "tinker-share", "config"),
    "TINKER_SHARE_URL=https://c.test\nTINKER_SHARE_TOKEN=filetoken\n",
  );
  expect(loadConfig({ HOME: home })).toEqual({ url: "https://c.test", token: "filetoken" });
});

test("loadConfig throws when nothing is configured", () => {
  expect(() => loadConfig({ HOME: "/nonexistent-tinker-share" })).toThrow();
});

test("push rejects unsupported extensions", async () => {
  await expect(push("notes.txt", "7d", { url: "https://x.test", token: "t" })).rejects.toThrow("Unsupported");
});

test("push encrypts, uploads with auth+ttl, returns decryptable fragment link", async () => {
  let received: { auth: string | null; ttl: string | null; body: Uint8Array } | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      received = {
        auth: req.headers.get("Authorization"),
        ttl: url.searchParams.get("ttl"),
        body: new Uint8Array(await req.arrayBuffer()),
      };
      return Response.json({ id: "abc123" });
    },
  });
  const base = `http://localhost:${server.port}`;
  const link = await push("samples/notes.md", "1d", { url: base, token: "tok" });
  server.stop();

  expect(received!.auth).toBe("Bearer tok");
  expect(received!.ttl).toBe("1d");
  expect(link.startsWith(`${base}/a/abc123#`)).toBe(true);

  const key = link.split("#")[1];
  const envelope = await decryptEnvelope(received!.body, key);
  expect(envelope.type).toBe("md");
  expect(envelope.name).toBe("notes.md");
  expect(envelope.content).toBe(await Bun.file("samples/notes.md").text());
});
