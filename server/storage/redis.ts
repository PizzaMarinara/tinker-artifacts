import { RedisClient } from "bun";
import type { Storage } from "../core";

// Redis storage for the self-hosted server (STORAGE=redis). Native EX TTL.
// Body is base64-encoded so arbitrary ciphertext bytes survive the string
// client; metadata is a sibling JSON key sharing the same TTL.
export function redisStorage(url: string): Storage & { close(): void } {
  const client = new RedisClient(url);
  return {
    async put(id, body, opts) {
      const b64 = Buffer.from(body).toString("base64");
      const ttl = String(opts.ttlSeconds);
      await client.send("SET", [`art:${id}`, b64, "EX", ttl]);
      await client.send("SET", [`meta:${id}`, JSON.stringify(opts.metadata), "EX", ttl]);
    },
    async get(id) {
      const [b64, metaStr] = await Promise.all([client.get(`art:${id}`), client.get(`meta:${id}`)]);
      if (!b64 || !metaStr) return null;
      return { body: new Uint8Array(Buffer.from(b64, "base64")), metadata: JSON.parse(metaStr) };
    },
    async delete(id) {
      await client.send("DEL", [`art:${id}`, `meta:${id}`]);
    },
    close() {
      client.close();
    },
  };
}
