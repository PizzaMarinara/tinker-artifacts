#!/usr/bin/env bun
// tinker-share — encrypt a self-contained HTML/Markdown artifact, upload it,
// print a wormhole-style share link (key only in the URL fragment).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import "../shared/sig.js";

const tsig = (globalThis as any).tinkerSig;

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
  keyName: string;
  privateKey: string; // standard base64 of the PKCS#8 Ed25519 private key
}

function configPath(env: Record<string, string | undefined>): string {
  return `${env.HOME ?? ""}/.config/tinker-share/config`;
}

function readConfigFile(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(configPath(env), "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const file = readConfigFile(env);
  const url = env.TINKER_SHARE_URL ?? file.TINKER_SHARE_URL;
  const keyName = env.TINKER_SHARE_KEY_NAME ?? file.TINKER_SHARE_KEY_NAME;
  const privateKey = env.TINKER_SHARE_KEY ?? file.TINKER_SHARE_KEY;
  if (!url || !keyName || !privateKey) {
    throw new Error(
      "Missing config. Set TINKER_SHARE_URL and create a key with `tinker-share keygen <name>` " +
        "(env vars or ~/.config/tinker-share/config).",
    );
  }
  return { url: url.replace(/\/+$/, ""), keyName, privateKey };
}

export async function keygen(
  name: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ line: string }> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const dir = `${env.HOME ?? ""}/.config/tinker-share`;
  mkdirSync(dir, { recursive: true });
  const path = configPath(env);
  let lines: string[] = [];
  try {
    lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("TINKER_SHARE_KEY")); // drops KEY and KEY_NAME
  } catch {}
  lines.push(`TINKER_SHARE_KEY_NAME=${name}`);
  lines.push(`TINKER_SHARE_KEY=${tsig.b64Encode(priv)}`);
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync mode is ignored if the file already existed
  return { line: `${name}:${tsig.b64uEncode(pub)}` };
}

async function signHeaders(
  method: string,
  path: string,
  query: string, // "?" when empty, else "?k=v"
  body: Uint8Array,
  config: Config,
): Promise<Record<string, string>> {
  const cd = await tsig.contentDigestHeader(body);
  const created = Math.floor(Date.now() / 1000);
  const base = tsig.buildSignatureBase(method, path, query, cd, created, config.keyName);
  const key = await crypto.subtle.importKey("pkcs8", tsig.b64Decode(config.privateKey), "Ed25519", false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(base)));
  return {
    "Content-Digest": cd,
    "Signature-Input": tsig.buildSignatureInput(created, config.keyName),
    Signature: "sig1=:" + tsig.b64Encode(sig) + ":",
  };
}

const EXT_TO_TYPE: Record<string, Envelope["type"]> = { html: "html", htm: "html", md: "md", markdown: "md" };

export async function push(
  file: string,
  ttl: string | null,
  config: Config,
): Promise<{ viewUrl: string; deleteUrl: string }> {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  const type = EXT_TO_TYPE[ext];
  if (!type) throw new Error(`Unsupported file type ".${ext}" — only .html/.htm/.md/.markdown`);
  const content = await Bun.file(file).text();
  const name = file.split("/").pop()!;
  const { blob, key } = await encryptEnvelope({ type, name, content });
  const query = ttl ? `?ttl=${encodeURIComponent(ttl)}` : "";
  const headers = await signHeaders("PUT", "/api/artifacts", query === "" ? "?" : query, blob, config);
  const res = await fetch(`${config.url}/api/artifacts${query}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/octet-stream" },
    body: blob,
  });
  if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status}): ${await res.text()}`);
  const { id, deleteToken } = (await res.json()) as { id?: string; deleteToken?: string };
  if (!id || !deleteToken) throw new Error("Malformed server response (missing id/deleteToken)");
  return {
    viewUrl: `${config.url}/a/${id}#${key}`,
    deleteUrl: `${config.url}/d/${id}#${deleteToken}`,
  };
}

export async function deleteArtifact(deletionUrl: string): Promise<void> {
  const m = deletionUrl.match(/^(https?:\/\/[^/]+)\/d\/([A-Za-z0-9_-]+)#(.+)$/);
  if (!m) throw new Error("Not a deletion URL (expected https://…/d/<id>#<token>)");
  const res = await fetch(`${m[1]}/api/artifacts/${m[2]}`, {
    method: "DELETE",
    headers: { "X-Delete-Token": m[3] },
  });
  if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status}): ${await res.text()}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const usage = [
    "usage: tinker-share <command>",
    "  keygen [name]              create this machine's upload keypair (default name: hostname)",
    "  push <file> [--ttl <dur>]  encrypt + upload a .html/.md artifact, print view/delete links",
    "  delete <deletion-url>      delete an artifact early using its deletion link",
  ].join("\n");
  try {
    if (args[0] === "keygen") {
      const name = args[1] ?? hostname().split(".")[0];
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error("Key name must match [A-Za-z0-9_.-]{1,64}");
      const { line } = await keygen(name);
      console.log("Key created. Ask your instance operator to add this line to UPLOAD_KEYS:");
      console.log(line);
    } else if (args[0] === "push" && args[1] && !args[1].startsWith("--")) {
      const ttlIdx = args.indexOf("--ttl");
      const ttl = ttlIdx === -1 ? null : (args[ttlIdx + 1] ?? "");
      if (ttlIdx !== -1 && !ttl) {
        console.error(usage);
        process.exit(1);
      }
      const { viewUrl, deleteUrl } = await push(args[1], ttl, loadConfig());
      console.log("View link (share this):");
      console.log(viewUrl);
      console.log("");
      console.log("Deletion link (KEEP PRIVATE — anyone with it can delete this artifact early; shown only this once):");
      console.log(deleteUrl);
      try {
        const p = Bun.spawn(["pbcopy"], { stdin: "pipe" });
        p.stdin.write(viewUrl);
        await p.stdin.end();
        await p.exited;
        console.error("(view link copied to clipboard)");
      } catch {}
    } else if (args[0] === "delete" && args[1]) {
      await deleteArtifact(args[1]);
      console.log("Artifact deleted.");
    } else {
      console.error(usage);
      process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
