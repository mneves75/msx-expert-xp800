# Security Policy

## Supported versions

Only the latest deployed version is supported. The application is a static site with no
backend, authentication, or server-side user-data storage.

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/mneves75/msx-expert-xp800/security/advisories/new).
Do not open a public issue. Expect an initial response within seven days.

## Scope

- WebMSX is the only third-party script loaded from another origin. It loads from a commit-pinned
  jsDelivr URL with Subresource Integrity; a modified response is rejected and the app
  falls back to its procedural screen.
- `public/_headers` limits scripts to `'self'` and the exact pinned WebMSX URL, and sets CSP,
  HSTS, `nosniff`, and frame-denial headers. Practical bypass reports are welcome.
- User-selected ROM bytes stay in browser memory and are never persisted or uploaded.
- WebMSX URL-parameter configuration is disabled, so page query strings cannot replace
  the application's fixed emulator configuration. ROM files are limited to 2 MB before
  their contents are read.

## Verification

- CI runs `pnpm audit --audit-level moderate` before lint, type checking, and build.
- Deployment verification checks CSP, HSTS, `nosniff`, frame denial, emulator loading,
  CRT warm-up, and cartridge insertion against the real response.
- Staging uses a separate Worker name, so validation cannot overwrite production.
- Header checks parse each required directive and reject broadened script/connect
  sources and unsafe inline/eval grants. Positive and negative controls test the guards.
- The 2026-09-05 audit found that the previous `nanoid` 3.3.17 override remained affected
  by [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8). The override
  now uses the patched 3.3.18 line within the consumer's existing major version.
