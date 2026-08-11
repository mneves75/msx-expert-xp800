# Security Policy

## Supported versions

Only the latest deployed version is supported. The application is a static site with no
backend, authentication, or server-side user-data storage.

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/mneves75/msx-expert-xp800/security/advisories/new).
Do not open a public issue. Expect an initial response within seven days.

## Scope

- WebMSX is the only third-party runtime dependency. It loads from a commit-pinned
  jsDelivr URL with Subresource Integrity; a modified response is rejected and the app
  falls back to its procedural screen.
- `public/_headers` limits scripts to `'self'` and `cdn.jsdelivr.net`, and sets CSP,
  HSTS, `nosniff`, and frame-denial headers. Practical bypass reports are welcome.
- User-selected ROM bytes stay in browser memory and are never persisted or uploaded.

## Verification

- CI runs `pnpm audit --audit-level moderate` before lint, type checking, and build.
- Deployment verification checks CSP, HSTS, `nosniff`, frame denial, emulator loading,
  CRT warm-up, and cartridge insertion against the real response.
- Staging uses a separate Worker name, so validation cannot overwrite production.
- The 2026-08-10 review covered source sinks, generated assets, dependency advisories,
  the pinned WebMSX bytes/SRI digest, and response headers. It found no exploitable
  critical, high, or medium application vulnerability; the transitive `nanoid` advisory
  was corrected by pinning 3.3.17.
