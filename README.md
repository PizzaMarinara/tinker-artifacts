# tinker-artifacts

Self-hosted, end-to-end-encrypted, self-expiring links for HTML and Markdown artifacts.

```sh
$ tinker-share push report.html --ttl 7d
https://share.example.com/a/7xDXugysoXbE6TVoVYUo1w#0eCrt5TqtFgRbtfvdys3Zzt89ddQpKdAZralvH-dlXA
```

Send that link to anyone. They open it, the page decrypts in their browser, and the artifact renders. After 7 days it's gone. The server — even though you run it — never sees the content.

## Why this exists

Coding agents (Claude Code, Codex, and friends) increasingly produce **artifacts**: self-contained HTML reports, dashboards, and Markdown write-ups. Sharing them usually means either a hosted service you don't control, or pasting files around by hand.

tinker-artifacts is the third option: a tiny sharing service you deploy yourself (a single Cloudflare Worker), a single-file CLI any agent or shell can call, and a [skill](skill/SKILL.md) that teaches agents to use it. The design copies the model popularized by [wormhole.app](https://wormhole.app/): **temporary by default, encrypted end-to-end, shareable with one link**.

Design goals:

- **Harness-agnostic** — the client is one bun script with zero dependencies; anything that can run a shell command can share an artifact.
- **Temporary** — every artifact has a TTL (1h / 1d / 7d / 30d) and is deleted by the storage layer itself, not by a cleanup job you have to remember to run.
- **Private by construction** — the server stores ciphertext it cannot decrypt. Not "we promise not to look" — *cannot*, and you can verify it (see below).
- **Boring to operate** — ~500 lines total, no database, no build pipeline, no runtime dependencies. Free-tier Cloudflare covers personal use.

## How it works

```
 you / your agent                        your Worker (Cloudflare)              recipient's browser
──────────────────                      ─────────────────────────             ────────────────────
 1. generate random key ──┐
 2. encrypt file locally  │
    (AES-256-GCM)         │
 3. upload CIPHERTEXT ────┼───────────▶  store blob in KV with TTL
                          │              return random id
 4. build the link        │
    /a/<id> # <key> ◀─────┘
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
3. **The server code has no decryption path.** [`server/worker.ts`](server/worker.ts) is ~70 lines; read all of it. It stores bytes, returns bytes, and serves a static page. It imports no crypto, receives no key, and has nowhere to get one.
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

Pick TTLs accordingly: short for sensitive things.

## Deploy (once)

Requires [bun](https://bun.sh) and a Cloudflare account (free tier is fine).

```sh
bun install
bunx wrangler kv namespace create ARTIFACTS   # paste the id into wrangler.toml
bunx wrangler secret put AUTH_TOKEN           # pick a long random token
bun run deploy
```

`AUTH_TOKEN` gates uploads only (so strangers can't use your storage); downloads need nothing but the unguessable link. The Worker fails closed if the secret is missing.

## Configure the CLI

Env vars, or the same `KEY=VALUE` lines in `~/.config/tinker-share/config`:

```sh
export TINKER_SHARE_URL=https://tinker-artifacts.<you>.workers.dev
export TINKER_SHARE_TOKEN=<the token>
```

Optional: make it a command — `alias tinker-share="bun /path/to/tinker-artifacts/cli/tinker-share.ts"`

## Use

```sh
tinker-share push report.html            # default TTL 7d
tinker-share push notes.md --ttl 1h      # 1h | 1d | 7d | 30d
```

Prints (and copies) `https://…/a/<id>#<key>`. Share the **full** link — without the part after `#`, the artifact is undecryptable, by anyone, forever. Artifacts auto-delete at TTL via KV `expirationTtl`; there are no cleanup jobs.

For coding agents, point them at [`skill/SKILL.md`](skill/SKILL.md) — it works as a Claude Code skill or as plain AGENTS.md-style instructions in any harness.

## Limits

- Self-contained `.html` / `.md` only. Inline your CSS/JS/images (data: URIs) — the viewer's CSP blocks all external requests, which is a feature: an artifact can't phone home.
- Max 20 MB per artifact (under the KV 25 MB value cap).
- Markdown gets a minimal built-in renderer (headings, lists, tables, code blocks, links); HTML renders as-is inside the sandbox.

## Develop

```sh
echo 'AUTH_TOKEN=dev-token' > .dev.vars
bun run dev                                # wrangler dev on :8787
bun test                                   # unit tests
TINKER_SHARE_URL=http://localhost:8787 TINKER_SHARE_TOKEN=dev-token bun run smoke
```

Layout: `server/worker.ts` (3 routes), `server/viewer.html` + `server/viewer-md.js` (viewer sources), `cli/tinker-share.ts` (CLI + crypto), `skill/SKILL.md`. The viewer page is inlined into the Worker by `bun run gen` → `server/viewer-html.ts` (generated, committed, drift-tested — never edit by hand; dev/deploy/test regenerate it automatically).
