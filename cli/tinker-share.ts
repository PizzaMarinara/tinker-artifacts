#!/usr/bin/env bun
// tinker-share — encrypt a self-contained HTML/Markdown artifact, upload it,
// print a wormhole-style share link (key only in the URL fragment).
import { readFileSync } from "node:fs";

export function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64uDecode(s: string): Uint8Array {
  const b = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export interface Envelope {
  type: "html" | "md";
  name: string;
  content: string;
}

export async function encryptEnvelope(envelope: Envelope): Promise<{ blob: Uint8Array; key: string }> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(envelope))),
  );
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv);
  blob.set(ct, iv.length);
  return { blob, key: b64uEncode(rawKey) };
}

export async function decryptEnvelope(blob: Uint8Array, keyB64u: string): Promise<Envelope> {
  const key = await crypto.subtle.importKey("raw", b64uDecode(keyB64u), "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12) }, key, blob.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}

export interface Config {
  url: string;
  token: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  let url = env.TINKER_SHARE_URL;
  let token = env.TINKER_SHARE_TOKEN;
  if (!url || !token) {
    try {
      const text = readFileSync(`${env.HOME ?? ""}/.config/tinker-share/config`, "utf8");
      for (const line of text.split("\n")) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (!m) continue;
        if (m[1] === "TINKER_SHARE_URL" && !url) url = m[2];
        if (m[1] === "TINKER_SHARE_TOKEN" && !token) token = m[2];
      }
    } catch {}
  }
  if (!url || !token) {
    throw new Error("Set TINKER_SHARE_URL and TINKER_SHARE_TOKEN (env vars or ~/.config/tinker-share/config)");
  }
  return { url: url.replace(/\/+$/, ""), token };
}

const EXT_TO_TYPE: Record<string, Envelope["type"]> = { html: "html", htm: "html", md: "md", markdown: "md" };
const TTLS = ["1h", "1d", "7d", "30d"];

export async function push(file: string, ttl: string, config: Config): Promise<string> {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  const type = EXT_TO_TYPE[ext];
  if (!type) throw new Error(`Unsupported file type ".${ext}" — only .html/.htm/.md/.markdown`);
  const content = await Bun.file(file).text();
  const name = file.split("/").pop()!;
  const { blob, key } = await encryptEnvelope({ type, name, content });
  const res = await fetch(`${config.url}/api/artifacts?ttl=${ttl}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/octet-stream" },
    body: blob,
  });
  if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status}): ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  return `${config.url}/a/${id}#${key}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const usage = "usage: tinker-share push <file.html|.htm|.md|.markdown> [--ttl 1h|1d|7d|30d]";
  const ttlIdx = args.indexOf("--ttl");
  const ttl = ttlIdx === -1 ? "7d" : (args[ttlIdx + 1] ?? "");
  if (args[0] !== "push" || !args[1] || args[1].startsWith("--") || !TTLS.includes(ttl)) {
    console.error(usage);
    process.exit(1);
  }
  try {
    const link = await push(args[1], ttl, loadConfig());
    console.log(link);
    try {
      const p = Bun.spawn(["pbcopy"], { stdin: "pipe" });
      p.stdin.write(link);
      await p.stdin.end();
      await p.exited;
      console.error("(copied to clipboard)");
    } catch {}
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
