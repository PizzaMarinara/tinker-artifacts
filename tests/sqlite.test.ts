import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactMetadata } from "../server/core";
import { sqliteStorage } from "../server/storage/sqlite";

function tmpDb() {
  return join(mkdtempSync(join(tmpdir(), "tinker-sqlite-")), "t.db");
}
const meta = (exp: number): ArtifactMetadata => ({ by: "test", delHash: "h", exp });

test("put/get round-trips body and metadata exactly", async () => {
  const s = sqliteStorage(tmpDb());
  const body = crypto.getRandomValues(new Uint8Array(4096));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  await s.put("id1", body, { ttlSeconds: 3600, metadata: meta(exp) });
  const got = await s.get("id1");
  expect(got).not.toBeNull();
  expect(got!.body).toEqual(body);
  expect(got!.metadata).toEqual(meta(exp));
  expect(await s.get("missing")).toBeNull();
  s.close();
});

test("expired rows read as null (lazy expiry)", async () => {
  const s = sqliteStorage(tmpDb());
  const past = Math.floor(Date.now() / 1000) - 1;
  await s.put("old", new Uint8Array([1, 2, 3]), { ttlSeconds: 60, metadata: meta(past) });
  expect(await s.get("old")).toBeNull();
  s.close();
});

test("sweep deletes only expired rows and returns the count", async () => {
  const s = sqliteStorage(tmpDb());
  const now = Math.floor(Date.now() / 1000);
  await s.put("live", new Uint8Array([1]), { ttlSeconds: 60, metadata: meta(now + 60) });
  await s.put("dead1", new Uint8Array([2]), { ttlSeconds: 60, metadata: meta(now - 1) });
  await s.put("dead2", new Uint8Array([3]), { ttlSeconds: 60, metadata: meta(now - 10) });
  expect(s.sweep()).toBe(2);
  expect((await s.get("live"))!.body).toEqual(new Uint8Array([1]));
  s.close();
});

test("delete removes a row", async () => {
  const s = sqliteStorage(tmpDb());
  const exp = Math.floor(Date.now() / 1000) + 60;
  await s.put("x", new Uint8Array([9]), { ttlSeconds: 60, metadata: meta(exp) });
  await s.delete("x");
  expect(await s.get("x")).toBeNull();
  s.close();
});

test("put replaces an existing id", async () => {
  const s = sqliteStorage(tmpDb());
  const exp = Math.floor(Date.now() / 1000) + 60;
  await s.put("dup", new Uint8Array([1]), { ttlSeconds: 60, metadata: meta(exp) });
  await s.put("dup", new Uint8Array([2, 2]), { ttlSeconds: 60, metadata: { by: "b2", delHash: "h2", exp } });
  const got = await s.get("dup");
  expect(got!.body).toEqual(new Uint8Array([2, 2]));
  expect(got!.metadata.by).toBe("b2");
  s.close();
});
