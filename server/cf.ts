import { handle, type ArtifactMetadata, type Storage } from "./core";

// Minimal KV surface we use — avoids the @cloudflare/workers-types devDependency.
export interface KVNamespace {
  put(key: string, value: ArrayBuffer, opts: { expirationTtl: number; metadata: ArtifactMetadata }): Promise<void>;
  getWithMetadata(
    key: string,
    type: "arrayBuffer",
  ): Promise<{ value: ArrayBuffer | null; metadata: ArtifactMetadata | null }>;
  delete(key: string): Promise<void>;
}

export interface Env {
  ARTIFACTS: KVNamespace;
  UPLOAD_KEYS?: string;
  TTL_OPTIONS?: string;
  DEFAULT_TTL?: string;
}

export function kvStorage(kv: KVNamespace): Storage {
  return {
    async put(id, body, opts) {
      await kv.put(id, body.slice().buffer, { expirationTtl: opts.ttlSeconds, metadata: opts.metadata });
    },
    async get(id) {
      const { value, metadata } = await kv.getWithMetadata(id, "arrayBuffer");
      if (!value || !metadata) return null;
      return { body: new Uint8Array(value), metadata };
    },
    async delete(id) {
      await kv.delete(id);
    },
  };
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, {
      storage: kvStorage(env.ARTIFACTS),
      config: { uploadKeys: env.UPLOAD_KEYS, ttlOptions: env.TTL_OPTIONS, defaultTtl: env.DEFAULT_TTL },
    });
  },
};
