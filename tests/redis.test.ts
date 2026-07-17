import { expect, test } from "bun:test";
import type { ArtifactMetadata } from "../server/core";
import { redisStorage } from "../server/storage/redis";

const URL = process.env.REDIS_URL;
const meta = (exp: number): ArtifactMetadata => ({ by: "test", delHash: "h", exp });

test.skipIf(!URL)("redis put/get/delete round-trips binary body + metadata", async () => {
  const s = redisStorage(URL!);
  const id = "rtest-" + Math.floor(Date.now() / 1000);
  const body = crypto.getRandomValues(new Uint8Array(2048));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  await s.put(id, body, { ttlSeconds: 3600, metadata: meta(exp) });
  const got = await s.get(id);
  expect(got).not.toBeNull();
  expect(got!.body).toEqual(body);
  expect(got!.metadata).toEqual(meta(exp));
  await s.delete(id);
  expect(await s.get(id)).toBeNull();
  s.close();
});

test.skipIf(!URL)("redis honors short TTL expiry", async () => {
  const s = redisStorage(URL!);
  const id = "rttl-" + Math.floor(Date.now() / 1000);
  await s.put(id, new Uint8Array([1, 2, 3]), { ttlSeconds: 1, metadata: meta(Math.floor(Date.now() / 1000) + 1) });
  await Bun.sleep(1200);
  expect(await s.get(id)).toBeNull();
  s.close();
});
