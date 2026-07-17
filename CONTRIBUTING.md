# Contributing

Thanks for helping out. Tinker is deliberately small; the best contributions keep it that way.

## Ground rules

- **Zero runtime dependencies is a hard rule.** The only devDependency is `wrangler`. Don't add packages for what a few lines (or the platform) can do.
- **Small, focused changes.** One concern per PR; no drive-by refactors.
- **Don't expand product scope**: no accounts, dashboards, analytics, permanent publishing, or arbitrary-file support.
- **Never edit generated `server/*-html.ts` files by hand**; see the page workflow below.

## Setup

You need [Bun](https://bun.sh).

```sh
bun install --frozen-lockfile
cp .env.example .env                      # self-host server config
cp .dev.vars.example .dev.vars            # Cloudflare dev config
bun cli/tinker-share.ts keygen dev        # paste the printed line into .env / .dev.vars as UPLOAD_KEYS
```

Never commit `.env`, `.dev.vars`, or any private key material. Real secrets belong only in your local copies of those files (both are gitignored).

## Running

```sh
bun run start                             # self-host server on :8080 (bun:sqlite)
bun run dev                               # Cloudflare dev (wrangler) on :8787
```

## Testing

```sh
bun test                                  # full suite
REDIS_URL=redis://localhost:6379 bun test tests/redis.test.ts   # Redis adapter (needs a local Redis/Valkey)
TINKER_SHARE_URL=http://localhost:8080 bun run smoke            # end-to-end lifecycle against a running server
```

Redis tests are skipped unless `REDIS_URL` is set. CI runs the default suite, the Redis suite against a service container, and a Docker build/startup smoke test.

Every behavioral change needs the smallest relevant automated test. Changes to the viewer, delete, or landing pages additionally need a real browser check (load the page from a running server; for viewer changes, push and open a real artifact).

## Generated pages

The HTML pages (`server/viewer.html`, `server/delete.html`, `server/landing.html`, plus `server/viewer-md.js`) are inlined into committed TypeScript modules by:

```sh
bun run gen
```

After editing any page source, run it and **commit the regenerated `server/*-html.ts` files**; a drift test fails otherwise. Never edit the generated files directly.
