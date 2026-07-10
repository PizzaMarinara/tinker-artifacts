#!/usr/bin/env bun
// tinker-share — encrypt a self-contained HTML/Markdown artifact, upload it,
// print a wormhole-style share link (key only in the URL fragment).

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
