---
name: share-artifact
description: Use when the user asks to share, publish, or send an HTML/Markdown artifact, report, dashboard, or page as a link: encrypts it end-to-end and returns a shareable view URL plus a private early-deletion URL (the server never sees plaintext). Also use to delete a previously shared artifact early.
---

# Share Artifact

Share a self-contained HTML or Markdown file as an encrypted, expiring link; optionally delete it early.

## One-time setup (per machine)

The CLI signs uploads with an Ed25519 key (RFC 9421). Config lives in env vars or `~/.config/tinker-share/config`.

1. Needs `tinker-share` on `PATH` (from a repo checkout: `bun pm pack --destination /tmp && bun install -g /tmp/tinker-artifacts-0.1.0.tgz`; or run `bun <checkout>/cli/tinker-share.ts` directly), `TINKER_SHARE_URL` (the instance URL), plus a key (`TINKER_SHARE_KEY` / `TINKER_SHARE_KEY_NAME`).
2. No key yet → run `tinker-share keygen <name>` and give the user the printed `name:pubkey` line: "send this to your instance operator to add to UPLOAD_KEYS".
3. Push returns HTTP 401 → the key isn't registered (or was revoked). Ask the user to confirm the line was added. If the line was lost, run `keygen` again (this REPLACES the machine's key; the old registration becomes useless) and send the new line.

## Sharing

    tinker-share push <file> [--ttl <duration>]

- Files must be SELF-CONTAINED `.html`/`.htm`/`.md`/`.markdown` (inline CSS/JS/images as data: URIs; the viewer blocks external requests).
- TTL values are deployment-configured (default menu: 1h, 1d, 7d, 30d; default 7d). An invalid TTL gets a 400 that lists the allowed values; relay them.
- Output is TWO links. Present BOTH to the user, exactly like this:
  - **View link** (shareable): give the FULL link including everything after `#`: the fragment is the decryption key and never reaches the server.
  - **Deletion link** (show-once secret): label it clearly, e.g. "Deletion link — do NOT share: anyone with it can delete this artifact early. Save it somewhere private; it will not be shown again."
- NEVER write the deletion link into shared documents, commit messages, issue trackers, or logs. If the user wants it stored, let them choose where.
- Mention when the artifact expires (the TTL used).

## Deleting early

    tinker-share delete "<deletion-url>"

Use when the user asks to retract/remove a shared artifact. Needs the deletion link. Without it, early deletion is impossible; the artifact disappears at TTL expiry.

## Troubleshooting

- HTTP 401 → key missing/unregistered/revoked (see setup step 3).
- HTTP 400 with "invalid ttl" → relay the allowed values from the error.
- HTTP 413 → encrypted upload over 20 MiB (source files up to ~18 MB fit); slim the artifact.
- "Unsupported file type" → convert to a single self-contained .html or .md first.
- Viewer shows "Decryption failed" → the link was truncated; re-send the full URL including the `#…` part.
