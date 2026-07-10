---
name: share-artifact
description: Use when the user asks to share, publish, or send an HTML/Markdown artifact, report, dashboard, or page as a link — encrypts it end-to-end and returns a temporary shareable URL (wormhole-style; server never sees plaintext).
---

# Share Artifact

Share a self-contained HTML or Markdown file as an encrypted, expiring link.

## Prerequisites

- The `tinker-share` CLI: `bun <repo>/cli/tinker-share.ts` or a `tinker-share` alias on PATH.
- Config via env vars `TINKER_SHARE_URL` + `TINKER_SHARE_TOKEN`, or `~/.config/tinker-share/config`.
- If config is missing, tell the user to set it up (see the repo README) — do not guess values.

## Usage

    tinker-share push <file> [--ttl 1h|1d|7d|30d]

- Default TTL is 7d. Pick shorter TTLs for sensitive content; ask the user only when it matters.
- Accepted files: `.html`, `.htm`, `.md`, `.markdown` — and they must be SELF-CONTAINED.
  Inline all CSS/JS/images (data: URIs) first; the viewer blocks external requests.
- On success it prints the share link to stdout (and copies it to the clipboard on macOS).

## Presenting the result

- Give the user the FULL link including everything after `#`. The fragment is the
  decryption key; without it the artifact cannot be read. It is never sent to the server.
- Mention when it expires (the TTL you used).
- Do not store or log the link anywhere else without asking — anyone with the link can
  read the artifact until it expires.

## Troubleshooting

- HTTP 401 → wrong/missing `TINKER_SHARE_TOKEN`.
- HTTP 413 → file over 20 MB; slim the artifact.
- "Unsupported file type" → convert to a single self-contained .html or .md first.
- Viewer shows "Decryption failed" → the link was truncated; re-send the full URL.
