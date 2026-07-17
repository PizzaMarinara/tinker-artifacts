import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStorage, resolveConfig } from "../server/server";

function tmpDbPath() {
  return join(mkdtempSync(join(tmpdir(), "tinker-srv-")), "t.db");
}

test("resolveConfig maps env vars to CoreConfig", () => {
  expect(resolveConfig({ UPLOAD_KEYS: "a:b", TTL_OPTIONS: "1h,2h", DEFAULT_TTL: "1h" })).toEqual({
    uploadKeys: "a:b",
    ttlOptions: "1h,2h",
    defaultTtl: "1h",
  });
  expect(resolveConfig({})).toEqual({ uploadKeys: undefined, ttlOptions: undefined, defaultTtl: undefined });
});

test("makeStorage defaults to sqlite and round-trips through it", async () => {
  const { storage, sweep, close } = makeStorage({ SQLITE_PATH: tmpDbPath() });
  expect(typeof sweep).toBe("function");
  const exp = Math.floor(Date.now() / 1000) + 60;
  await storage.put("k", new Uint8Array([7]), { ttlSeconds: 60, metadata: { by: "t", delHash: "h", exp } });
  expect((await storage.get("k"))!.body).toEqual(new Uint8Array([7]));
  close?.();
});

test("makeStorage(redis) requires REDIS_URL; unknown STORAGE throws", () => {
  expect(() => makeStorage({ STORAGE: "redis" })).toThrow("REDIS_URL");
  expect(() => makeStorage({ STORAGE: "elasticsearch" })).toThrow("unknown STORAGE");
});
