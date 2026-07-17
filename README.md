# tinker-artifacts

Self-hosted, end-to-end-encrypted, self-expiring links for HTML and Markdown artifacts.

```sh
$ tinker-share push report.html --ttl 7d
https://share.example.com/a/7xDXugysoXbE6TVoVYUo1w#0eCrt5TqtFgRbtfvdys3Zzt89ddQpKdAZralvH-dlXA
```

Send that link to anyone. They open it, the page decrypts in their browser, and the artifact renders. After 7 days it's gone. The server — even though you run it — never sees the content.

## Why this exists

Coding agents (Claude Code, Codex, and friends) increasingly produce **artifacts**: self-contained HTML reports, dashboards, and Markdown write-ups. Sharing them usually means either a hosted service you don't control, or pasting files around by hand.

tinker-artifacts is the third option: a tiny sharing service you deploy yourself (a Cloudflare Worker, or a self-hosted server on any box), a single-file CLI any agent or shell can call, and a [skill](skill/SKILL.md) that teaches agents to use it. The design copies the model popularized by [wormhole.app](https://wormhole.app/): **temporary by default, encrypted end-to-end, shareable with one link**.

Design goals:

- **Harness-agnostic** — the client is one bun script with zero dependencies; anything that can run a shell command can share an artifact.
- **Temporary** — every artifact has a TTL (1h / 1d / 7d / 30d) and is deleted by the storage layer itself, not by a cleanup job you have to remember to run.
- **Private by construction** — the server stores ciphertext it cannot decrypt. Not "we promise not to look" — *cannot*, and you can verify it (see below).
- **Boring to operate** — small, no build pipeline, no runtime dependencies, and no external services in the default setups (Cloudflare KV, or a single SQLite file when self-hosted). Free-tier Cloudflare covers personal use.

## How it works

```
 you / your agent                        your Worker (Cloudflare)              recipient's browser
──────────────────                      ─────────────────────────             ────────────────────
 1. generate random key ──┐
 2. encrypt file locally  │
    (AES-256-GCM)         │
 3. upload CIPHERTEXT ────┼───────────▶  store blob in KV with TTL
                          │              return random id
 4. build the links: view /a/<id>#<key> · delete /d/<id>#<token> ◀─────┘
          │
          └── send link ────────────────────────────────────────────────▶ 5. fetch /a/<id>  (viewer page)
                                         serve static viewer ──────────▶ 6. fetch ciphertext by id
                                         serve ciphertext ─────────────▶ 7. read key from the #fragment
                                                                          8. decrypt IN THE BROWSER
                                                                          9. render in a sandboxed iframe
```

The crucial detail is step 4: the encryption key is placed in the **URL fragment** — the part after `#`. Everything else about the link (the domain, the path, the id) reaches the server; the fragment never does.

## The encryption, in plain terms

Imagine mailing someone a locked box through a storage depot:

1. Before handing the box to the depot, **you** put the contents in and snap on a padlock. The depot only ever touches the locked box.
2. The depot gives you a claim ticket (the artifact id) — a random number that says *where* the box is, but has nothing to do with the lock.
3. You send your friend one message: the depot's address, the claim ticket, **and the key** — but the key part of the message is written in a special ink that the depot physically cannot see when your friend shows up with the ticket.
4. Your friend collects the locked box, walks outside, and opens it with the key. The depot saw a locked box arrive and a locked box leave. That's all it ever had.

The "special ink" is not a metaphorical hand-wave — it's how URLs actually work. The fragment (`#...`) is defined by the web's own standards as **client-side only**: browsers use it locally and strip it from every network request. The server can't log what it never receives.

## The encryption, precisely

All cryptography uses the [WebCrypto API](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto) — the same audited primitives built into every modern browser and runtime. No crypto libraries, no hand-rolled algorithms.

Per artifact, the CLI ([`cli/tinker-share.ts`](cli/tinker-share.ts)):

1. Builds a plaintext envelope `{"type": "html"|"md", "name": ..., "content": ...}` — so even the **filename and file type** are encrypted.
2. Generates a fresh random **256-bit key** and **96-bit IV** from the OS CSPRNG (`crypto.getRandomValues`, [lines 24–25](cli/tinker-share.ts#L24-L25)). Keys are never reused across artifacts.
3. Encrypts with **AES-256-GCM**. GCM is *authenticated* encryption: the ciphertext carries an integrity tag, so a blob that was tampered with (or a wrong key) doesn't decrypt into garbage — decryption *fails*, loudly. There is a test that flips one ciphertext bit and asserts exactly that ([`tests/crypto.test.ts`](tests/crypto.test.ts)).
4. Uploads `IV ‖ ciphertext` as an opaque byte blob. The server generates a random 128-bit id for it — the id is unrelated to the key, so knowing the id (which the server does) tells you nothing about the key (which it doesn't).
5. Prints `https://<host>/a/<id>#<key>` with the key base64url-encoded in the fragment.

The viewer page ([`server/viewer.html`](server/viewer.html)) mirrors this in reverse: it reads the key from `location.hash` ([line 34](server/viewer.html#L34)), fetches the ciphertext, decrypts with WebCrypto in the browser, and renders the result inside an `<iframe sandbox>` with no same-origin access — so even the artifact's own JavaScript can't touch the viewer page, your cookies, or the API.

## Why the server owner cannot decrypt your data

This is the claim that matters, so here is the argument piece by piece — each part is checkable in this repo or in public standards:

1. **Encryption happens before upload.** The CLI encrypts locally and the HTTP request body contains only `IV ‖ ciphertext` — grep [`cli/tinker-share.ts`](cli/tinker-share.ts): the only thing `fetch` ever sends is the encrypted blob. The key variable is never serialized into any request.
2. **The key lives only in the fragment, and fragments never leave the client.** [RFC 3986 §3.5](https://www.rfc-editor.org/rfc/rfc3986#section-3.5) and the [WHATWG URL/Fetch standards](https://fetch.spec.whatwg.org/) define the fragment as client-side: browsers remove it from the request line of every HTTP request and from the `Referer` header. It doesn't appear in server access logs, CDN logs, or TLS traffic — it is never transmitted at all. (The viewer additionally sets `Referrer-Policy: no-referrer` and `noindex`, as belt-and-suspenders.)
3. **The server code has no decryption path.** The request logic is one small file, [`server/core.ts`](server/core.ts) (the entries [`server/cf.ts`](server/cf.ts) and [`server/server.ts`](server/server.ts) just wire it to storage); read all of it. It stores bytes, returns bytes, and serves a static page. It imports no crypto beyond hashing a delete token, receives no key, and has nowhere to get one.
4. **The key space is not guessable.** 256-bit random keys from a CSPRNG; brute force is not a conversation.
5. **Verify it yourself, live.** Push an artifact, then fetch what the server has:

   ```sh
   curl https://<host>/api/artifacts/<id> | xxd | head
   ```

   You'll see uniform random bytes — no HTML tags, no words, no structure. That *is* the entirety of what the server operator, Cloudflare, or anyone who steals the KV store possesses. You can also open DevTools → Network on the viewer page and confirm the request for the page and the ciphertext contain no fragment.

This is the same construction wormhole.app describes for its "the key never reaches us" property, and the same `#fragment`-secret pattern used by Excalidraw share links and the late Firefox Send: client-side keys riding in the one part of a URL the network never sees.

## Honest threat model

What this protects against, and what it doesn't:

| Protected against | Not protected against |
|---|---|
| Server operator reading content | **Anyone you give the full link to** — the link *is* the key |
| Cloudflare / storage compromise reading content | Recipients re-sharing the link before it expires |
| Ciphertext tampering (GCM auth fails closed) | Metadata: the server sees blob sizes, upload times, requester IPs |
| Search engines / link scanners (noindex, key not in any request) | A **malicious server operator** shipping a tampered viewer page that steals keys from visitors' fragments — inherent to all in-browser crypto (wormhole.app included). Here you *are* the operator, so you're trusting yourself and your Cloudflare account's integrity |
| Forgotten cleanup (storage-level TTL expiry) | Links sitting in chat logs/browser history — the fragment is stored by *clients* (history, bookmarks), just never sent over the network |
| Early deletion by anyone holding the deletion link | Losing the deletion link — there is no other way to delete early (wait for TTL) |

Pick TTLs accordingly: short for sensitive things.

## Who does what

- **Uploaders** (you, your agents) push artifacts via the CLI or the [agent skill](skill/SKILL.md). Uploads are authenticated with **Ed25519 request signatures** ([RFC 9421](https://datatracker.ietf.org/doc/rfc9421/) profile): your machine holds a private key, the server holds only public keys. Nothing usable ever transits or sits in server config.
- **Viewers** just open a link. No account, no key, no install.

Every push returns two links:

- **View link** `…/a/<id>#<key>` — share it; the part after `#` decrypts in the recipient's browser.
- **Deletion link** `…/d/<id>#<token>` — KEEP PRIVATE. Opening it deletes the artifact immediately, before its scheduled expiry. It is shown once at upload; anyone holding it can delete (and that's the only way to delete early). Like the view key, the token travels in the URL fragment and never reaches server logs; the server stores only its SHA-256 hash.

## Deploy

Two supported ways to run the server. Both share the same code, auth, and E2E model; pick by whether you want zero-ops serverless or your own box.

### Option A — Cloudflare Workers (serverless, zero maintenance)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/PizzaMarinara/tinker-artifacts)
*(button works once this repo is public; it still needs the `keygen` + `UPLOAD_KEYS` steps below)*

Requires [bun](https://bun.sh) and a Cloudflare account (free tier is fine).

```sh
bun install
bunx wrangler kv namespace create ARTIFACTS   # paste the id into wrangler.toml
bun cli/tinker-share.ts keygen <your-name>    # prints "<your-name>:<pubkey>"
bunx wrangler secret put UPLOAD_KEYS          # paste that line (comma-separate to add more people later)
bun run deploy
```

Storage is Workers KV with native TTL expiry — nothing to clean up.

### Option B — Self-hosted (your VPS, homelab, or company box)

Runs anywhere [bun](https://bun.sh) or Docker runs. Default storage is a single SQLite file — no external services.

```sh
bun install
cp .env.example .env
bun cli/tinker-share.ts keygen <your-name>    # prints "<your-name>:<pubkey>"; put it in .env as UPLOAD_KEYS
bun run start                                 # serves on :8080 (PORT to change)
```

Or with Docker (SQLite persisted in a volume):

```sh
docker build -t tinker-artifacts .
docker run -d -p 8080:8080 -v tinker-data:/data \
  -e UPLOAD_KEYS="<your-name>:<pubkey>" \
  tinker-artifacts
```

Put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front for HTTPS, and set `TINKER_SHARE_URL` on the CLI to that public URL.

**Storage backends** (`STORAGE` env):

| `STORAGE` | Needs | TTL cleanup | Use when |
|---|---|---|---|
| `sqlite` (default) | just a file (`SQLITE_PATH`) | in-process sweep every 60 s + lazy-on-read | single instance — homelab, one VPS |
| `redis` | a Redis/Valkey server (`REDIS_URL`) | native key expiry | multiple instances behind a load balancer, or you already run Redis |

All server config is environment variables (see `.env.example`): `UPLOAD_KEYS`, `TTL_OPTIONS`, `DEFAULT_TTL`, `PORT`, `STORAGE`, `SQLITE_PATH`, `REDIS_URL`. Register more uploaders by appending comma-separated `name:pubkey` pairs to `UPLOAD_KEYS`; revoke by removing one.

## Configure the CLI

`keygen` already stored your key in `~/.config/tinker-share/config`. Add the server URL (env var or a `TINKER_SHARE_URL=…` line in that same file):

```sh
export TINKER_SHARE_URL=https://tinker-artifacts.<you>.workers.dev
```

Optional: `alias tinker-share="bun /path/to/tinker-artifacts/cli/tinker-share.ts"`

## Use

```sh
tinker-share push report.html            # deployment default TTL (7d out of the box)
tinker-share push notes.md --ttl 1h      # any TTL your deployment allows
tinker-share delete "https://…/d/<id>#<token>"   # early deletion, no browser needed
```

`push` prints the view link (also copied to your clipboard on macOS) and the deletion link — the deletion link is shown only this once.

## Retention

Artifacts self-delete at their TTL via KV `expirationTtl` — no cleanup jobs. Instance operators configure the menu in `wrangler.toml`:

```toml
[vars]
TTL_OPTIONS = "1h,1d,7d,30d"   # any comma-separated <n>m|h|d list, 60s–365d each
DEFAULT_TTL = "7d"             # must be one of TTL_OPTIONS
```

## Security model (upload side)

Each `PUT` carries RFC 9421 `Signature-Input`/`Signature` headers over `@method`, `@path`, `@query`, and `content-digest`, signed with Ed25519 and bound to a timestamp (±300 s accepted). The server verifies against `UPLOAD_KEYS` and rejects everything else with a generic 401. Residual risk, accepted for zero-database simplicity: a captured request can be replayed within its 300 s window, which can only duplicate an upload.

## Limits

- Self-contained `.html` / `.md` only (inline your assets; the viewer's CSP blocks external requests — a feature: artifacts can't phone home).
- Max 20 MB per artifact (server-enforced; also under Cloudflare KV's value cap).
- Anyone with the full view link can read the artifact until it expires or is deleted.

## Develop

```sh
cp .dev.vars.example .dev.vars
bun cli/tinker-share.ts keygen dev        # paste printed line into .dev.vars
bun run dev                               # wrangler dev on :8787
bun run start                             # OR: self-host server on :8080 (bun:sqlite)
bun test                                  # unit tests
TINKER_SHARE_URL=http://localhost:8787 bun run smoke   # full lifecycle vs the dev server
```

Pages (`server/viewer.html`, `server/delete.html`, `server/landing.html`, `server/viewer-md.js`) are inlined into the Worker by `bun run gen` → `server/*-html.ts` (generated, committed, drift-tested — never edit those by hand; dev/deploy/test flows regenerate them).
