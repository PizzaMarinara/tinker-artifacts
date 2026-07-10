# tinker-artifacts

Share self-contained HTML/Markdown artifacts as end-to-end-encrypted, expiring links
(wormhole.app model). Cloudflare Worker + KV on the server, a single-file bun CLI on
the client. The decryption key travels only in the URL fragment — the server never
sees plaintext.

## Deploy (once)

```sh
bun install
bunx wrangler kv namespace create ARTIFACTS   # paste the id into wrangler.toml
bunx wrangler secret put AUTH_TOKEN           # pick a long random token
bun run deploy
```

## Configure the CLI

Env vars (or `~/.config/tinker-share/config` with the same KEY=VALUE lines):

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

Prints (and copies) `https://…/a/<id>#<key>`. Share the FULL link — the part after
`#` is the decryption key and never reaches the server. Artifacts auto-delete when
the TTL expires (KV `expirationTtl`, no cleanup jobs).

## Limits

- Self-contained `.html`/`.md` only (inline your assets; external requests are blocked by CSP).
- Max 20 MB per artifact.
- Anyone with the full link can read the artifact until it expires.

## Develop

```sh
echo 'AUTH_TOKEN=dev-token' > .dev.vars
bun run dev                                # wrangler dev on :8787
bun test                                   # unit tests
TINKER_SHARE_URL=http://localhost:8787 TINKER_SHARE_TOKEN=dev-token bun run smoke
```

Viewer page: edit `server/viewer.html` / `server/viewer-md.js`, then `bun run gen`
(dev/deploy scripts run it automatically). `server/viewer-html.ts` is generated —
never edit it by hand.
