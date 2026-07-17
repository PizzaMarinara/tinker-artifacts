import { handle, type CoreConfig, type Storage } from "./core";
import { redisStorage } from "./storage/redis";
import { sqliteStorage } from "./storage/sqlite";

export function resolveConfig(env: Record<string, string | undefined> = process.env): CoreConfig {
  return { uploadKeys: env.UPLOAD_KEYS, ttlOptions: env.TTL_OPTIONS, defaultTtl: env.DEFAULT_TTL };
}

export function makeStorage(
  env: Record<string, string | undefined> = process.env,
): { storage: Storage; sweep?: () => number; close?: () => void } {
  const kind = env.STORAGE ?? "sqlite";
  if (kind === "sqlite") {
    const s = sqliteStorage(env.SQLITE_PATH ?? "./tinker.db");
    return { storage: s, sweep: s.sweep, close: s.close };
  }
  if (kind === "redis") {
    if (!env.REDIS_URL) throw new Error("STORAGE=redis requires REDIS_URL");
    const s = redisStorage(env.REDIS_URL);
    return { storage: s, close: s.close };
  }
  throw new Error(`unknown STORAGE "${kind}" (use "sqlite" or "redis")`);
}

if (import.meta.main) {
  const { storage, sweep } = makeStorage();
  const config = resolveConfig();
  if (sweep) {
    const timer = setInterval(() => {
      try {
        sweep();
      } catch (err) {
        console.error("sweep failed:", err);
      }
    }, 60_000);
    (timer as { unref?: () => void }).unref?.();
  }
  const port = Number(process.env.PORT ?? 8080);
  Bun.serve({ port, idleTimeout: 60, fetch: (req) => handle(req, { storage, config }) });
  console.log(`tinker-artifacts listening on :${port} (storage: ${process.env.STORAGE ?? "sqlite"})`);
}
