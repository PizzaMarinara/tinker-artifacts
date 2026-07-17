# Tinker — Guide

Reference material beyond the [README](README.md) quick start.

## Contents

- [How it works](#how-it-works)
- [The encryption, in plain terms](#the-encryption-in-plain-terms)
- [The encryption, precisely](#the-encryption-precisely)
- [Why the server owner cannot decrypt your data](#why-the-server-owner-cannot-decrypt-your-data)
- [Threat model](#threat-model)
- [Upload authentication](#upload-authentication)
- [Deployment](#deployment)
- [Configuration reference](#configuration-reference)
- [CLI reference](#cli-reference)
- [Limits](#limits)
- [Architecture](#architecture)
- [Development](#development)

---

## How it works

```
 you / your agent                        your server                          recipient's browser
──────────────────                      ─────────────                         ────────────────────
 1. generate random key ──┐
 2. encrypt file locally  │
    (AES-256-GCM)         │
 3. upload CIPHERTEXT ────┼───────────▶  store blob + TTL
                          │              return random id
 4. build the links: view /a/<id>#<key> · delete /d/<id>#<token> ◀─────┘
          │
          └── send view link ──────────────────────────────────────────▶ 5. fetch /a/<id> (viewer page)
                                         serve static viewer ──────────▶ 6. fetch ciphertext by id
                                         serve ciphertext ─────────────▶ 7. read key from the #fragment
                                                                          8. decrypt IN THE BROWSER
                                                                          9. render in a sandboxed iframe
```

The crucial detail is step 4: the encryption key is placed in the **URL fragment** — the part after `#`. Everything else about the link (the domain, the path, the id) reaches the server; the fragment never does.

## The encryption, in plain terms

Imagine mailing someone a locked box through a storage depot:

1. Before handing the box to the depot, **you** put the contents in and snap on a padlock. The depot only ever touches the locked box.
2. The depot gives you a claim ticket (the artifact id): a random number that says *where* the box is but has nothing to do with the lock.
3. You send your friend one message: the depot's address, the claim ticket, **and the key**. The key part of that message is written in a special ink the depot physically cannot see when your friend shows up with the ticket.
4. Your friend collects the locked box, walks outside, and opens it with the key. The depot saw a locked box arrive and a locked box leave. That's all it ever had.

The "special ink" is not a metaphorical hand-wave — it's how URLs actually work. The fragment (`#...`) is defined by the web's own standards as **client-side only**: browsers use it locally and strip it from every network request. The server can't log what it never receives.

## The encryption, precisely

All cryptography uses the [WebCrypto API](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto) — the same audited primitives built into every modern browser and runtime. No crypto libraries, no hand-rolled algorithms.

Per artifact, the CLI ([`cli/tinker-share.ts`](cli/tinker-share.ts)):

1. Builds a plaintext envelope `{"type": "html"|"md", "name": ..., "content": ...}`, so even the **filename and file type** are encrypted.
2. Generates a fresh random **256-bit key** and **96-bit IV** from the OS CSPRNG (`crypto.getRandomValues`). Keys are never reused across artifacts.
3. Encrypts with **AES-256-GCM**. GCM is *authenticated* encryption: the ciphertext carries an integrity tag, so a blob that was tampered with (or a wrong key) doesn't decrypt into garbage; decryption *fails*, loudly. A test flips one ciphertext bit and asserts exactly that ([`tests/crypto.test.ts`](tests/crypto.test.ts)).
4. Uploads `IV ‖ ciphertext` as an opaque byte blob. The server generates a random 128-bit id for it — the id is unrelated to the key, so knowing the id (which the server does) tells you nothing about the key (which it doesn't).
5. Prints `https://<host>/a/<id>#<key>` with the key base64url-encoded in the fragment.

The viewer page ([`server/viewer.html`](server/viewer.html)) mirrors this in reverse: it reads the key from `location.hash`, fetches the ciphertext, decrypts with WebCrypto in the browser, and renders the result inside an `<iframe sandbox>` with no same-origin access — so even the artifact's own JavaScript can't touch the viewer page, your cookies, or the API.

## Why the server owner cannot decrypt your data

This is the claim that matters, so here is the argument piece by piece. Each part is checkable in this repo or in public standards:

1. **Encryption happens before upload.** The CLI encrypts locally and the HTTP request body contains only `IV ‖ ciphertext`. Grep [`cli/tinker-share.ts`](cli/tinker-share.ts): the only thing `fetch` ever sends is the encrypted blob. The key variable is never serialized into any request.
2. **The key lives only in the fragment, and fragments never leave the client.** [RFC 3986 §3.5](https://www.rfc-editor.org/rfc/rfc3986#section-3.5) and the [WHATWG URL/Fetch standards](https://fetch.spec.whatwg.org/) define the fragment as client-side: browsers remove it from the request line of every HTTP request and from the `Referer` header. It doesn't appear in server access logs, CDN logs, or TLS traffic; it is never transmitted at all. (The viewer additionally sets `Referrer-Policy: no-referrer` and `noindex`, as belt-and-suspenders.)
3. **The server code has no decryption path.** The request logic is one small file, [`server/core.ts`](server/core.ts), while the entries [`server/cf.ts`](server/cf.ts) and [`server/server.ts`](server/server.ts) just wire it to storage. Read all of it. It stores bytes, returns bytes, and serves a static page. It imports no crypto beyond hashing a delete token, receives no key, and has nowhere to get one.
4. **The key space is not guessable.** 256-bit random keys from a CSPRNG; brute force is not a conversation.
5. **Verify it yourself, live.** Push an artifact, then fetch what the server has:

   ```sh
   curl https://<host>/api/artifacts/<id> | xxd | head
   ```

   You'll see uniform random bytes: no HTML tags, no words, no structure. That *is* the entirety of what the server operator, Cloudflare, or anyone who steals the store possesses. You can also open DevTools → Network on the viewer page and confirm the request for the page and the ciphertext contain no fragment.

This is the same `#fragment`-secret pattern used by Excalidraw share links and the late Firefox Send: client-side keys riding in the one part of a URL the network never sees.

## Threat model

What this protects against, and what it doesn't:

| Protected against | Not protected against |
|---|---|
| Server operator reading content | **Anyone you give the full link to.** The link *is* the key |
| Cloudflare / storage compromise reading content | Recipients re-sharing the link before it expires |
| Ciphertext tampering (GCM auth fails closed) | Metadata: the server sees blob sizes, upload times, requester IPs |
| Search engines / link scanners (noindex, key not in any request) | A **malicious server operator** shipping a tampered viewer page that steals keys from visitors' fragments. This is inherent to all in-browser crypto; here you *are* the operator, so you're trusting yourself and your host's integrity |
| Forgotten cleanup (storage-level TTL expiry) | Links sitting in chat logs/browser history. The fragment is stored by *clients* (history, bookmarks), just never sent over the network |
| Early deletion by anyone holding the deletion link | Losing the deletion link. There is no other way to delete early (wait for TTL) |

Pick TTLs accordingly: short for sensitive things.

## Upload authentication

Viewing is open to anyone with a link (the link is the capability). **Uploading** is gated so strangers can't use your storage.

Each upload is an Ed25519-signed request following a strict [RFC 9421](https://datatracker.ietf.org/doc/rfc9421/) HTTP-message-signature profile:

- The uploader's machine holds an Ed25519 **private** key (created by `tinker-share keygen`, stored in `~/.config/tinker-share/config`, mode `600`).
- The server holds only **public** keys, in the `UPLOAD_KEYS` env var as comma-separated `name:pubkey` pairs. Nothing usable ever transits the wire or sits in server config.
- Each `PUT` carries `Signature-Input` / `Signature` / `Content-Digest` headers covering `@method`, `@path`, `@query`, and the body digest, signed with the private key and bound to a Unix timestamp (`created`).
- The server verifies: strict profile shape, `created` within ±300 s, `keyid` present in `UPLOAD_KEYS`, digest matches the body, signature valid. Anything else → a single generic `401`.

**Registering / revoking uploaders:** each person runs `keygen` and sends you their `name:pubkey` line; append it (comma-separated) to `UPLOAD_KEYS` and redeploy / restart. Revoke by removing the line. Re-running `keygen` on a machine replaces that machine's key (the old registration becomes useless).

**Accepted residual risk:** a captured upload request can be replayed within its 300 s window, which can only create a duplicate artifact. There's no nonce store; that's the deliberate cost of keeping the server database-free.

Deletion is authorized differently, by the **capability token** in the deletion link's fragment rather than by a signature. The server stores only the token's SHA-256 hash; presenting the token (via the `/d/<id>#<token>` page or `tinker-share delete`) hashes and compares in constant time. Anyone holding the deletion link can delete, so treat it as a secret.

## Deployment

Two supported targets. Both run the identical request core; they differ only in the entry adapter and where blobs are stored.

### Cloudflare Workers

Serverless, zero maintenance, free tier is plenty. Storage is Workers KV with native TTL expiry — nothing to clean up.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/PizzaMarinara/tinker-artifacts)
*(the button works once this repo is public; you still run the `keygen` + `UPLOAD_KEYS` steps below)*

```sh
bun install
bunx wrangler kv namespace create ARTIFACTS   # paste the id into wrangler.toml
bun cli/tinker-share.ts keygen <your-name>    # prints "<your-name>:<pubkey>"
bunx wrangler secret put UPLOAD_KEYS          # paste that line (comma-separate to add more people)
bun run deploy
```

Configure retention (optional) in `wrangler.toml`:

```toml
[vars]
TTL_OPTIONS = "1h,1d,7d,30d"   # comma-separated <n>m|h|d list, 60s–365d each
DEFAULT_TTL = "7d"             # must be one of TTL_OPTIONS
```

### Self-hosted (VPS, homelab, company box)

Runs anywhere Bun or Docker runs. Default storage is a single SQLite file — no external services.

```sh
bun install
cp .env.example .env
bun cli/tinker-share.ts keygen <your-name>    # put the printed line in .env as UPLOAD_KEYS
bun run start                                 # serves on :8080 (PORT to change)
```

With Docker (SQLite persisted in a named volume):

```sh
docker build -t tinker-artifacts .
docker run -d -p 8080:8080 -v tinker-data:/data \
  -e UPLOAD_KEYS="<your-name>:<pubkey>" \
  tinker-artifacts
```

The server speaks plain HTTP; put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front for HTTPS, and set the CLI's `TINKER_SHARE_URL` to that public URL. **TLS matters:** the fragment key never leaves the browser, but the ciphertext, ids, and signed uploads still travel over the wire — HTTPS protects those in transit.

#### Storage backends (`STORAGE`)

| `STORAGE` | Needs | TTL cleanup | Use when |
|---|---|---|---|
| `sqlite` (default) | just a file (`SQLITE_PATH`) | in-process sweep every 60 s + lazy-on-read | single instance — homelab, one VPS |
| `redis` | a Redis/Valkey server (`REDIS_URL`) | native key expiry | multiple instances behind a load balancer, or you already run Redis |

## Configuration reference

Server configuration is entirely environment variables (self-host reads `.env` / the process env; Cloudflare reads `wrangler.toml` `[vars]` and secrets). See [`.env.example`](.env.example).

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `UPLOAD_KEYS` | both | *(none → all uploads 401)* | Comma-separated `name:pubkey` Ed25519 public keys allowed to upload. Set as a Cloudflare **secret**. |
| `TTL_OPTIONS` | both | `1h,1d,7d,30d` | Allowed TTL menu. Each is `<n>m\|h\|d`, clamped to 60 s–365 d. |
| `DEFAULT_TTL` | both | `7d` | TTL used when `push` omits `--ttl`. Must be one of `TTL_OPTIONS`. |
| `PORT` | self-host | `8080` | HTTP port for the Bun server. |
| `STORAGE` | self-host | `sqlite` | `sqlite` or `redis`. |
| `SQLITE_PATH` | self-host | `./tinker.db` | SQLite database file (use a volume path in Docker, e.g. `/data/tinker.db`). |
| `REDIS_URL` | self-host | *(required if `STORAGE=redis`)* | e.g. `redis://:password@host:6379`. |

CLI configuration lives in `~/.config/tinker-share/config` (written by `keygen`) or the matching env vars:

| Variable | Meaning |
|---|---|
| `TINKER_SHARE_URL` | Base URL of your instance. |
| `TINKER_SHARE_KEY` | This machine's Ed25519 private key (PKCS#8, base64). Written by `keygen`. |
| `TINKER_SHARE_KEY_NAME` | The `keyid` matching a `name:` in the server's `UPLOAD_KEYS`. |

## CLI reference

`cli/tinker-share.ts` — run with `bun cli/tinker-share.ts <cmd>` or an alias.

### `keygen [name]`

Generates this machine's Ed25519 keypair, writes the private key to `~/.config/tinker-share/config` (mode `600`, preserving other config lines), and prints the `name:pubkey` line to register on the server. `name` defaults to the machine hostname; it must match `[A-Za-z0-9_.-]{1,64}`. Re-running replaces the machine's key.

### `push <file> [--ttl <duration>]`

Encrypts a self-contained `.html`/`.htm`/`.md`/`.markdown` file and uploads it. `--ttl` must be one of the deployment's `TTL_OPTIONS` (default `DEFAULT_TTL`); an invalid value returns a `400` listing the allowed ones. Prints:

- the **view link** `…/a/<id>#<key>` (also copied to the clipboard on macOS via `pbcopy`), and
- the **deletion link** `…/d/<id>#<token>`, shown only once — keep it private.

### `delete <deletion-url>`

Deletes an artifact early, given its deletion link. No browser needed. Without the deletion link there is no way to delete before the TTL expires.

## Limits

- Self-contained `.html` / `.md` only. Inline your CSS/JS/images (data: URIs) — the viewer's CSP blocks external requests, which is a feature: artifacts can't phone home.
- Max **20 MB** per artifact (server-enforced; also under Cloudflare KV's value cap).
- Markdown renders via a small built-in renderer (headings, lists, tables, code blocks, links); HTML renders as-is inside the sandboxed iframe.
- Anyone with the full view link can read the artifact until it expires or is deleted.

## Architecture

One request core, thin per-platform entries, pluggable storage:

```
shared/sig.js            RFC 9421 signing/verification helpers (used by CLI, server, tests)
cli/tinker-share.ts      CLI: crypto envelope + keygen + signed push + delete
server/core.ts           platform-neutral handler: routing, auth, TTL, pages, over a Storage interface
server/cf.ts             Cloudflare entry: KV storage adapter + `export default { fetch }`
server/server.ts         self-host entry: Bun.serve + config/storage selection + TTL sweep
server/storage/sqlite.ts bun:sqlite adapter (lazy expiry + sweep)
server/storage/redis.ts  Bun.RedisClient adapter (native EX TTL)
server/viewer.html       decrypt-and-render viewer page (+ delete.html, landing.html)
skills/share-artifact/SKILL.md           agent instructions
```

The `Storage` interface is three methods (`put` / `get` / `delete`), so adding a backend is a small, self-contained adapter. `server/core.ts` never knows which one it's talking to.

The viewer/delete/landing pages are authored as `.html` (plus `viewer-md.js`) and **inlined** into committed TypeScript string modules (`server/*-html.ts`) by `bun run gen`, so the server serves them with zero build tooling. Those generated files are checked in and drift-tested; never edit them by hand.

## Development

```sh
cp .dev.vars.example .dev.vars
bun cli/tinker-share.ts keygen dev        # paste the printed line into .dev.vars as UPLOAD_KEYS
bun run dev                               # Cloudflare dev (wrangler) on :8787
bun run start                             # OR the self-host server on :8080 (bun:sqlite)
bun test                                  # full test suite
TINKER_SHARE_URL=http://localhost:8787 bun run smoke   # end-to-end lifecycle check
```

- **After editing any page source** (`server/viewer.html`, `server/delete.html`, `server/landing.html`, `server/viewer-md.js`), run `bun run gen` to regenerate the `server/*-html.ts` modules. The `dev`, `deploy`, `start`, and `smoke` scripts run it automatically; commit the regenerated files.
- **Redis adapter tests** are skipped unless `REDIS_URL` is set: `REDIS_URL=redis://localhost:6379 bun test tests/redis.test.ts`.
- Zero runtime dependencies is a hard rule; the only devDependency is `wrangler`.
