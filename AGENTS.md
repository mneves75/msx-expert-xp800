# AGENTS.md — Gradiente Expert XP-800 3D

Reading order: this file → `docs/SPEC.md` → `src/core/types.ts` → `MEMORY.md` and the
newest `memory/YYYY-MM-DD.md`. The spec owns dimensions and values; memory owns decisions
and lessons not derivable from code. This repository is public, so committed memory must
never contain vendor accounts, quotas, costs, private paths, maintainer quotes, or details
of an unfixed security issue.

## What this is, and what "good" means

This is a Cloudflare-hosted Three.js reconstruction of the December 1985 Brazilian MSX1
**Gradiente Expert XP-800**, with WebMSX/C-BIOS on a period CRT. Quality and interaction
reference: `https://ps1-pi.vercel.app/`. Acceptance is a blind side-by-side against
`reference/raw/` (provenance and licenses in `reference/raw/CREDITS.md`; fetch the four
git-ignored images locally). The visual target is product photography. Preserve measured
appearance during maintenance; report known calibration gaps rather than claiming that
functional checks prove photographic identity.

## Invariants

Each boundary protects a deliberate decision; violating one is not cleanup.

1. **Never self-host WebMSX** — it has no declared license (verified:
   `gh api repos/ppeccin/WebMSX --jq '.license'` → `null`; the `license.txt` its headers
   cite does not exist), so redistribution is unlicensed. The emulator loads at runtime
   from this commit-pinned, SRI-verified URL and nothing else:

   ```
   https://cdn.jsdelivr.net/gh/ppeccin/WebMSX@4f4009e86d3e0bb9be7dcd7f0a582b0cd411d660/release/stable/6.0/cbios/embedded/wmsx.js
   integrity="sha384-ZrKfFA57c2hR6DHPG3q0c55xd7wx70ZQLpoWj87znFJaebQcxkKRDJQxZFh+B49S"
   ```

   Do not vendor, bundle, commit, or proxy `wmsx.js`. Offline behavior is the job of
   `src/emulator/ProceduralScreen.ts`. C-BIOS only — no copyrighted MSX ROMs, ever.
   Cartridge content is **authorial Z80 built in code** (`SuperCosmicoRom.ts`,
   `buildDemoRom`), and the HUD's "Carregar ROM…" runs a user's own file entirely
   in-browser — bytes stay in memory, are never persisted, uploaded, or served.
   Neither path distributes anything; do not turn either into one.

2. **Everything is procedural** — every mesh and every texture is generated in code; no
   downloaded models, texture packs, or HDRIs. Budget < 3 MB gzipped excluding the
   hotlinked emulator. This is why the site loads instantly, and it is load-bearing.

3. **The spec is the source of truth, and photographs outrank the spec.** `docs/SPEC.md`
   holds every dimension, hex value, and material target — do not invent values it lacks.
   If a reference photograph contradicts it, the photograph wins: fix the spec in the same
   change and say so. Several spec values are *measured calibrations* marked with their
   measurement provenance (keycap roughness, exposure, bloom threshold, CRT scale) —
   re-run the cited measurement before changing one; "looks better to me" is how the
   QWERTY-wash defect got in the first time.

4. **User-facing text is Brazilian Portuguese** with correct diacritics — this is a
   Brazilian machine and the audience is Brazilian. Code identifiers, APIs, and paths
   stay in English.

## Stack and conventions

Stack: `three@0.185.1`, `postprocessing@6.39.3`, Vite 8 (rolldown; `manualChunks` must be
the function form), and strict TypeScript with `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. No `any`; use `unknown` plus guards. Use pnpm only. Run
Wrangler under Node, never Bun, which hangs after its first Cloudflare API call.

`Engine` composes `SceneModule`s from `src/core/types.ts`. Physical models share contracts
and `MaterialLibrary`; the interaction layer coordinates their explicit control APIs.
Each module releases its owned GPU resources in `dispose()`, including InstancedMesh
buffers. Shared cached textures belong to the cache. `Engine` disposes modules in reverse
order and never deep-disposes their internals. The HUD consumes one typed interaction
subscription; do not add a second state store or event-discovery path.

## Setup and independent checkouts

Use Node 22+ and the pnpm version in `packageManager`:

```bash
pnpm install --frozen-lockfile
pnpm setup:hooks                   # install the blocking ast-grep Git hook
pnpm exec playwright install chromium
pnpm dev                           # interactive Vite server on :5173
pnpm verify:all                    # build and offline browser QA; owns its server
pnpm verify:online                 # separate real CDN emulator/game integration checks
```

`pnpm verify:all` chooses a free port. For a manually started server use
`pnpm dev --host 127.0.0.1 --port 5174 --strictPort`, and point tools at it with
`MSX_URL=http://127.0.0.1:5174`. Each checkout needs its own node_modules and scratch
outputs; share the pnpm store, never a running server. Create a worktree only when the
user asks. Never terminate another checkout's listener to free your preferred port.

## Agent workflow

Establish the requested outcome, read its callers and choose the smallest supported
change. Delete unused paths before adding abstractions. Batch independent reads, keep
edits targeted, and delegate substantial independent work only with disjoint ownership.
Preserve the objective, decisions and proof paths when context gets compacted.

Run the matching checks below once; repeat affected checks after a change or failure.
Do not invent a new test framework for a check that the browser harness already covers.
Separate offline fallback proof from online integration proof: a skipped CDN check is
not a pass. Finish with the result, evidence and actual limitations in concise prose.
Model selection belongs to the agent runtime, not this repository. This workflow follows
the [Fable 5.1 guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1)
and [GPT-6 Astra guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra),
checked 2026-09-05.

## Verification — pick the tool that matches the question

Source inspection cannot judge this project. Use the tool whose trigger matches:

| You changed / suspect… | Run | It tells you |
|---|---|---|
| Anything visible | `node tools/shoot.mjs` (15 poses; `--pose x,y` for a subset) | Renders + a lit-subject gate that fails the batch if the CRT is dark when it shouldn't be |
| Interaction logic, power, cartridges, HUD state | `node tools/verify-interactions2.mjs` | Live behavioral checks (online mode requires actual WebMSX promotion) |
| Keyboard layout or key mapping | `node tools/verify-keymap.mjs` | Every modeled key vs both screen sources (incl. `Ç` and `NumpadEqual`) |
| Exposure, lighting, or tone mapping | `node tools/tune-exposure.mjs` | Measured keycap RGB vs the spec target at several exposures |
| The deployed site | `node tools/verify-prod.mjs [url]` | Asserts CSP/HSTS/nosniff/X-Frame-Options on the real response, then that the emulator loads under that CSP, the tube warms, and a cartridge inserts — exiting non-zero on any failure |
| Frame cost, draw calls, pass cost, CPU hotspots | `node tools/profile.mjs --label <name> [--width N --height N --dpr N]` | rAF frame times (vsync and the app presentation cap off), effective DPR/drawing buffer, host load, per-pass A/B in interleaved rounds, draw-call counters (with/without frozen shadows), CDP CPU profile → `.scratch/profile/<name>.json`. Compare labels before claiming a perf win |
| The Super Cósmico game ROM, key input into the emulator | `node tools/probe-game.mjs [url]` | Plays the game on the real WebMSX reading canvas pixels: splash → field → autonomous movement → wall death freezes with the field intact → key restart. Needs the CDN |

The dev server runs on :5173 (`pnpm dev`). The page exposes `window.__msxReady`,
`window.__msxCamera(pose)`, and `window.__msx.{interactions,postFX,cameraRig,…}` — the
capture harness depends on that contract; if you change camera or bootstrap code, keep it.

`SceneModule.update()` returns `false` when settled. `Engine` then skips presentation
once the camera and every module settle. External changes must call
`window.__msx.engine.requestRender(2)`; changed shadow casters also set
`renderer.shadowMap.needsUpdate = true`. Render-coupled work belongs in `beforeRender()`.
Preserve these contracts, and measure active frame cost separately from idle work.

After capturing, open the PNGs beside `reference/raw/`; an unseen change is not done. If
a visual defect resists a material fix, A/B `window.__msx.postFX.effects` first. The
project's costliest visual detour was chasing a bloom artifact through materials.

## Performance targets

Targets: 60 fps at 1440p on Apple silicon and 1080p on mid-range hardware; fewer than 150
scene draw calls, 900k triangles, and 256 MB texture memory. Active presentation is capped
near 60 Hz, the physical drawing buffer at 2560×1440, and the CRT target at 1536×1152.
Keep keycaps instanced. These targets guide design but are not yet CI-enforced.

## Releases

`package.json` owns the version; `CHANGELOG.md` uses US English and Keep a Changelog.
Releases are tagged `v<semver>` and published as GitHub Releases. Staging uses
`pnpm deploy:staging`; production uses `pnpm deploy`, both under Node. Before deploying,
run `pnpm build`, the applicable verification above, and scan fresh `dist/` for secrets
and local paths. `MSX_EXPECTED_VERSION=<version> node tools/verify-prod.mjs <url>` checks
the generated HTML's `application-version`; compare it and asset
hashes with the candidate before promotion. Staging tags use `v<semver>-betaN`; production
tags use `v<semver>`. Deploy only with user authorization.

## Package management

- **Use pnpm exclusively.** Never use `npm install`, `yarn`, or `bun install` — they ignore `pnpm-lock.yaml` and create duplicate physical copies of every dependency.
- Setup / CI: `pnpm install --frozen-lockfile`
- Add dependency: `pnpm add <pkg>` · dev: `pnpm add -D <pkg>` · workspace pkg: `pnpm --filter <name> add <pkg>`
- Run scripts: `pnpm <script>`
- `node_modules/` is disposable: hardlinked views into the shared pnpm store. Deleting it is always safe; reinstall is fast and offline. Never commit or edit it.
- `pnpm-lock.yaml` is the source of truth: commit it, never hand-edit.
