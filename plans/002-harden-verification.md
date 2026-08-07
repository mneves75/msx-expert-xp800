# Plan 002: Harden deployment and CI verification

> **Executor instructions**: Follow every step and verification command. The primary
> session maintains the plan index. Do not commit, push, tag, or deploy.
>
> **Drift check (run first)**:
> `git diff --stat b7369ef..HEAD -- tools/verify-prod.mjs tools/verify-interactions.mjs tools/verify-interactions2.mjs rules .github/workflows/ci.yml package.json`
> Any mismatch with Current state is a STOP condition.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/001-honest-responsive-capture.md`
- **Category**: security / tests / dx
- **Planned at**: commit `b7369ef`, 2026-08-07

## Why this matters

The deployment gate currently treats every `style-src` CSP error as expected, although
the contract allows exactly two violations created only after WebMSX boots. It can hide a
first-party CSP regression. Separately, the old interaction verifier reports success
without observing input, and CI does not parse the release-critical `.mjs` tools with the
repository-pinned ast-grep binary.

## Current state

- `tools/verify-prod.mjs:20-30` uses `/style-src/i` as a global allowlist.
- `public/_headers:22-26` documents exactly two WebMSX inline-style violations.
- `tools/verify-prod.mjs:92-94` duplicates a stale camera target and assumes `shots/`.
- `tools/verify-interactions.mjs` contains no-effect green assertions; docs point to v2.
- `tools/verify-interactions2.mjs` sets `typedOk = true` without observing `sendKey`.
- `.github/workflows/ci.yml` uses a separate ast-grep action rather than `pnpm lint`.
- `rules/no-syntax-error.yml` covers TypeScript only; tools are JavaScript modules.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| JS parse gate | `pnpm lint` | `.mjs` and `.ts` parse; exit 0 with only known warnings |
| Node parse proof | `find tools -maxdepth 1 -name '*.mjs' -exec node --check {} +` | exit 0 |
| Interaction | `node tools/verify-interactions2.mjs` | all checks PASS, including observed down/up events |
| Staging headers | `node tools/verify-prod.mjs https://msx-expert-xp800-staging.mvneves.workers.dev` | exit 0; zero pre-WebMSX and exactly two post-WebMSX style violations |

## Scope

**In scope**:
- `tools/verify-prod.mjs`
- `tools/verify-interactions2.mjs`
- delete `tools/verify-interactions.mjs`
- `rules/no-syntax-error-javascript.yml`
- `.github/workflows/ci.yml`

**Out of scope**:
- CSP relaxation, `unsafe-inline`, WebMSX vendoring, production deploy, GitHub settings.
- Full GPU/Playwright execution in CI.
- A new test framework or new dependency.

## Steps

### Step 1: Classify CSP violations by phase and count

Collect all CSP console violations separately. Assert zero before cartridge/WebMSX boot.
After promotion, assert exactly two violations and require both to be inline `style-src`
violations; any extra or different CSP violation fails. Keep non-CSP errors in `errs`.

**Verify**: staging command exits 0 and prints pre/post counts. Injecting a first-party
inline style locally must produce a failure rather than joining the allowlist.

### Step 2: Make the deployment artifact current and reliable

Write under `.scratch/verify-prod` after recursive `mkdir`. Call the current responsive
camera's `resetPose(true)` instead of duplicating a numeric pose. Use generic wording
(`implantação verificada`) because the same gate verifies staging.

**Verify**: remove only `.scratch/verify-prod` in a disposable test context, rerun staging
verification, and confirm the screenshot is created.

### Step 3: Make I6 observe the screen boundary

Temporarily wrap the runtime screen pipeline's `sendKey` method during `tapKey` calls,
record down/up pairs, and restore it in `finally`. I6 passes only if every requested key
reaches the pipeline with both transitions. Do not widen the public TypeScript API.

**Verify**: the interaction command exits 0; replacing the wrapper's event list with an
empty list makes I6 fail in a deliberate local mutation test.

### Step 4: Delete the obsolete verifier

Delete `tools/verify-interactions.mjs`. Repository rules forbid compatibility wrappers;
all docs already name v2.

**Verify**: `git ls-files tools/verify-interactions.mjs` returns no path, and a repository
search finds no documentation invoking it.

### Step 5: Parse JavaScript tools with the pinned linter in CI

Add a JavaScript `kind: ERROR` ast-grep rule analogous to the TypeScript rule. Replace
the external ast-grep action step with `run: pnpm lint`, using the pinned local CLI.

**Verify**: `pnpm lint` parses all `.mjs`; a disposable malformed `.mjs` fixture makes it
exit non-zero, then remove the fixture.

## Test plan

- Staging CSP phase/count and screenshot directory creation.
- Real interaction path with five key down/up pairs.
- Local JavaScript parse fixture and `node --check` over every tool.
- `pnpm verify` and `pnpm build` after the changes.

## Done criteria

- [x] First-party CSP violations cannot be allowlisted by generic text.
- [x] Exactly two WebMSX style violations are asserted after promotion.
- [x] I6 observes real pipeline events.
- [x] Obsolete verifier is deleted.
- [x] CI and local hooks use the same pinned ast-grep parser.
- [x] Local commands exit 0; current-build live proof awaits the next authorized staging deploy.

## STOP conditions

- Staging emits a different CSP count; capture exact messages and report, do not relax CSP.
- Runtime `screen.sendKey` cannot be safely wrapped/restored.
- JavaScript ast-grep language does not scan `.mjs`; use the smallest `node --check`
  script instead, without adding a dependency.

## Maintenance notes

If WebMSX changes its injected style count, re-establish the behavior against the pinned
commit before changing the expected count. The gate is intentionally strict.
