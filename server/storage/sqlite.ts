import { Database } from "bun:sqlite";
import type { ArtifactMetadata, Storage } from "../core";

// File-based storage for the self-hosted server. TTL is the absolute `exp`
// column: expired rows read as null (lazy) and are bulk-removed by sweep().
export function sqliteStorage(path: string): Storage & { sweep(): number; close(): void } {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(
    "CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, body BLOB NOT NULL, by TEXT NOT NULL, del_hash TEXT NOT NULL, exp INTEGER NOT NULL)",
  );
  const insert = db.query(
    "INSERT OR REPLACE INTO artifacts (id, body, by, del_hash, exp) VALUES (?, ?, ?, ?, ?)",
  );
  const select = db.query("SELECT body, by, del_hash, exp FROM artifacts WHERE id = ?");
  const del = db.query("DELETE FROM artifacts WHERE id = ?");
  const sweepStmt = db.query("DELETE FROM artifacts WHERE exp <= ?");

  return {
    async put(id, body, opts) {
      insert.run(id, body, opts.metadata.by, opts.metadata.delHash, opts.metadata.exp);
    },
    async get(id) {
      const row = select.get(id) as
        | { body: Uint8Array; by: string; del_hash: string; exp: number }
        | null;
      if (!row || row.exp <= Math.floor(Date.now() / 1000)) return null;
      return { body: new Uint8Array(row.body), metadata: { by: row.by, delHash: row.del_hash, exp: row.exp } };
    },
    async delete(id) {
      del.run(id);
    },
    sweep() {
      return sweepStmt.run(Math.floor(Date.now() / 1000)).changes;
    },
    close() {
      db.close();
    },
  };
}
