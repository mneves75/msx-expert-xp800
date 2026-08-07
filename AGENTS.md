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
git-ignored images locally). If an expert can identify the render, it is not done; the
target is product photography, not "good for WebGL."

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

`Engine` composes `SceneModule`s from `src/core/types.ts`. Modules import only shared
contracts and `MaterialLibrary`, own their GPU resources, and release them in `dispose()`.
`Engine` disposes them in reverse order and never deep-disposes their internals.

## Verification — pick the tool that matches the question

Source inspection cannot judge this project. Use the tool whose trigger matches:

| You changed / suspect… | Run | It tells you |
|---|---|---|
| Anything visible | `node tools/shoot.mjs` (15 poses; `--pose x,y` for a subset) | Renders + a lit-subject gate that fails the batch if the CRT is dark when it shouldn't be |
| Interaction logic, power, cartridges, HUD state | `node tools/verify-interactions2.mjs` | 20 functional PASS/FAIL checks against the live app (I4c needs the CDN — it exercises the real WebMSX promotion) |
| Keyboard layout or key mapping | `node tools/verify-keymap.mjs` | Every modeled key vs both screen sources (incl. `Ç` and `NumpadEqual`) |
| Exposure, lighting, or tone mapping | `node tools/tune-exposure.mjs` | Measured keycap RGB vs the spec target at several exposures |
| The deployed site | `node tools/verify-prod.mjs [url]` | Asserts CSP/HSTS/nosniff/X-Frame-Options on the real response, then that the emulator loads under that CSP, the tube warms, and a cartridge inserts — exiting non-zero on any failure |
| Frame cost, draw calls, pass cost, CPU hotspots | `node tools/profile.mjs --label <name> [--width N --height N --dpr N]` | rAF frame times (vsync and the app presentation cap off), effective DPR/drawing buffer, host load, per-pass A/B in interleaved rounds, draw-call counters (with/without frozen shadows), CDP CPU profile → `.scratch/profile/<name>.json`. Compare labels before claiming a perf win |
| The Super Cósmico game ROM, key input into the emulator | `node tools/probe-game.mjs [url]` | Plays the game on the real WebMSX reading canvas pixels: splash → field → autonomous movement → wall death freezes with the field intact → key restart. Needs the CDN |

The dev server runs on :5173 (`pnpm dev`). The page exposes `window.__msxReady`,
`window.__msxCamera(pose)`, and `window.__msx.{interactions,postFX,cameraRig,…}` — the
capture harness depends on that contract; if you change camera or bootstrap code, keep it.

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
and local paths.
