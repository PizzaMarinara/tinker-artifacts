# Tinker

**End-to-end-encrypted, self-expiring share links for HTML & Markdown artifacts. Self-hosted.**

![license](https://img.shields.io/badge/license-MIT-blue) ![runtime](https://img.shields.io/badge/runtime-Bun-black) ![deploy](https://img.shields.io/badge/deploy-Cloudflare%20%7C%20self--host-orange) ![deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

```sh
$ tinker-share push report.html --ttl 7d
https://share.example.com/a/7xDXugysoXbE6TVoVYUo1w#0eCrt5TqtFgRbtfvdys3Zzt89ddQpKdAZralvH-dlXA
```

Send that link to anyone. Their browser decrypts and renders the artifact. After 7 days it's gone. **The server never sees the content, even though you run it:** the decryption key lives only in the part of the URL after `#`, which browsers never send over the network.

Tinker is built for the artifacts coding agents now produce all the time (self-contained HTML reports, dashboards, Markdown write-ups) when you want to share one as a link without handing it to a service you don't control.

## Features

- 🔒 **True end-to-end encryption.** AES-256-GCM in the browser/CLI via WebCrypto; the server stores only ciphertext it cannot read. You can [prove it](GUIDE.md#why-the-server-owner-cannot-decrypt-your-data), not just take it on trust.
- ⏳ **Temporary by default.** Every artifact has a TTL (1h/1d/7d/30d, configurable), and storage expires it on its own: no cleanup jobs.
- 🗑️ **Early deletion.** Every upload also returns a private, one-time deletion link.
- 🤖 **Agent-native.** A single zero-dependency CLI plus a [skill](skills/share-artifact/SKILL.md) any coding harness (Claude Code, Codex, and the like) can drive.
- 🚀 **Runs anywhere.** A Cloudflare Worker (serverless, free tier) or a self-hosted Bun server on any VPS, homelab, or spare box. SQLite by default, optional Redis.
- 🔑 **Signed uploads.** Ed25519 request signatures ([RFC 9421](https://datatracker.ietf.org/doc/rfc9421/)); the server holds only public keys.
- 🪶 **Boring to operate.** No build pipeline, no runtime dependencies, no external services in the default setups.

## Quick start

You need [Bun](https://bun.sh). Pick where the server runs.

### Run the server

**Cloudflare Workers** (serverless, zero maintenance):

```sh
bun install
bunx wrangler kv namespace create ARTIFACTS   # paste the id into wrangler.toml
bun cli/tinker-share.ts keygen <your-name>    # prints "<your-name>:<pubkey>"
bunx wrangler secret put UPLOAD_KEYS          # paste that line
bun run deploy
```

**Self-hosted** (your own box; SQLite, no external services):

```sh
bun install
cp .env.example .env
bun cli/tinker-share.ts keygen <your-name>    # prints "<your-name>:<pubkey>", put it in .env as UPLOAD_KEYS
bun run start                                 # serves on :8080
```

For Docker, Redis, TLS behind a reverse proxy, and adding more uploaders, see the [deployment guide](GUIDE.md#deployment).

### Share something

Install the CLI onto your `PATH` (from the checkout; after this the clone is no longer needed):

```sh
bun pm pack --destination /tmp
bun install -g /tmp/tinker-artifacts-0.1.0.tgz
```

`keygen` (above) already saved your signing key to `~/.config/tinker-share/config`. Point the CLI at your server and push:

```sh
export TINKER_SHARE_URL=https://your-instance.example.com

tinker-share push report.html            # default TTL (7d)
tinker-share push notes.md --ttl 1h      # 1h | 1d | 7d | 30d
tinker-share delete "https://…/d/<id>#<token>"   # delete early
```

`push` prints a **view link** to share (also copied to your clipboard on macOS) and a **deletion link** shown only once. Keep that second one private.

Only self-contained `.html`/`.md` files. The size cap is **20 MiB after encryption** — encryption adds roughly 5–10% to typical HTML/Markdown, so source files up to ~18 MB are safely inside it. Inline your assets — the viewer's CSP blocks every request an artifact makes on its own (scripts, fetches, images), so it can't silently phone home. The one exception: links the reader deliberately clicks open normally in a new tab.

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
          └── send view link ──────────────────────────────────────────▶ 5. fetch page + ciphertext
                                         serve ciphertext ─────────────▶ 6. read key from #fragment
                                                                          7. decrypt & render in-browser
                                                                             (sandboxed iframe)
```

The key rides in the URL **fragment** (`#…`), which [per web standards](https://www.rfc-editor.org/rfc/rfc3986#section-3.5) browsers keep client-side and never put in a request. It never reaches server logs, the CDN, or TLS traffic. The server only ever holds an opaque encrypted blob.

For the full story, the [documentation](GUIDE.md) explains the encryption [in plain terms](GUIDE.md#the-encryption-in-plain-terms) and [precisely](GUIDE.md#the-encryption-precisely), walks through [why the operator can't decrypt](GUIDE.md#why-the-server-owner-cannot-decrypt-your-data) with a step you can verify yourself, and lays out an [honest threat model](GUIDE.md#threat-model).

## For AI agents

Point your harness at [`skills/share-artifact/SKILL.md`](skills/share-artifact/SKILL.md). It teaches the agent to `keygen` once, `push` artifacts, present both links correctly (treating the deletion link as a show-once secret), and `delete` on request. It works as a Claude Code skill or as plain AGENTS.md-style instructions.

## Documentation

- **[Full guide](GUIDE.md)** covers encryption internals, the threat model, the deployment reference, the CLI reference, configuration, and architecture.
- **[Agent skill](skills/share-artifact/SKILL.md)** is how coding agents use it.
- **[Contributing & development](GUIDE.md#development)** covers tests, the page-generation step, and project layout.

## License

[MIT](LICENSE) © 2026 Enrico Fantini
