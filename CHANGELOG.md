# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

First public release.

### Added

- `tinker-share` CLI: `keygen`, `push` (AES-256-GCM client-side encryption, Ed25519-signed uploads per RFC 9421), `delete`.
- Server with one platform-neutral request core and two entries: Cloudflare Workers (KV) and self-hosted Bun (SQLite, optional Redis).
- Browser viewer that decrypts via the URL fragment key and renders HTML/Markdown in a sandboxed iframe; delete and landing pages.
- TTL-based expiry (configurable menu), private early-deletion links.
- 20 MiB encrypted-artifact limit, enforced at the exact byte boundary.
- Docker image, CI (tests, Redis, Docker smoke), SECURITY.md, CONTRIBUTING.md, agent skill.
