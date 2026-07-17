# Security Policy

## Supported versions

Tinker is pre-1.0. Only the latest commit on `main` is supported; there are no maintained release branches. Self-hosters should track `main`.

## Reporting a vulnerability

Please report vulnerabilities privately via [GitHub private vulnerability reporting](https://github.com/PizzaMarinara/tinker-artifacts/security/advisories/new). Do **not** open a public issue for security problems.

This is a spare-time project: reports are handled on a best-effort basis. You'll normally hear back within a couple of weeks; there is no formal SLA. Please give the maintainer reasonable time to ship a fix before disclosing publicly.

## Security boundary

Read the [threat model](GUIDE.md#threat-model) first. In short, by design:

- **The link is the capability.** Anyone holding a full view link (including the `#fragment` key) can read the artifact until expiry; anyone holding a deletion link can delete it. That is intended behavior, and reports about it are out of scope.
- **The server never sees plaintext**, but a compromised or malicious server can serve a tampered viewer page that steals keys from visitors' fragments. This is inherent to all in-browser cryptography; Tinker's answer is that you host the viewer yourself.
- **Metadata is visible to the operator**: blob sizes, upload times, requester IPs, uploader key names.
- **Artifacts cannot make automatic outbound requests** (CSP), but links a reader deliberately clicks navigate externally.

## In scope

Anything that breaks the guarantees above: for example, plaintext or key material reaching the server, the viewer leaking the fragment to the network, sandbox/CSP escapes enabling silent exfiltration, upload-auth bypass, or the deletion-token comparison being bypassable.

## Out of scope

- Consequences of sharing a link with the wrong person, or links copied out of chat logs / browser history.
- A malicious *instance operator* attacking their own users (see the boundary above; hosting is the trust anchor).
- Denial of service against your own self-hosted instance.
