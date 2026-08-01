# CLAUDE.md

Guidance for Claude Code contributors. [`AGENTS.md`](AGENTS.md) is the canonical working
contract; read it first, then `docs/SPEC.md`, `src/core/types.ts`, `MEMORY.md`, and the
newest `memory/YYYY-MM-DD.md`. Do not duplicate or weaken its invariants here.

## Commands

```bash
pnpm install
pnpm dev                  # Vite on :5173
MSX_CAPTURE=1 pnpm dev    # suppress the HMR overlay during capture
pnpm typecheck            # tsc --noEmit
pnpm lint                 # ast-grep scan
pnpm verify               # lint + typecheck
pnpm build                # typecheck + Vite build into dist/
pnpm deploy               # build + Wrangler deploy; Node only, never Bun
```

Use pnpm and Node 22 or newer. In a fresh clone, enable the blocking ast-grep hook with
`git config core.hooksPath .githooks`. CI runs ast-grep, typecheck, build, and a leakage
scan of the generated `dist/`.

## Verification

There is no unit-test suite. Start `pnpm dev` and select the live check from the trigger
table in `AGENTS.md`:

```bash
node tools/shoot.mjs
node tools/verify-interactions2.mjs
node tools/verify-keymap.mjs
node tools/tune-exposure.mjs
node tools/verify-prod.mjs [url]
node tools/profile.mjs --label x
node tools/probe-game.mjs [url]
```

For a focused capture, use `node tools/shoot.mjs --pose hero,keyboard`. Valid pose names
are `hero front back back-flat back-macro-left back-macro-right top keyboard
keyboard-macro slots screen screen-macro raking silhouette cartridge`. Useful options are
`--out`, `--width`, `--height`, `--hud`, `--power off`, `--no-verify`, `--hide`, and `--fov`.

Open every generated PNG and compare it with `reference/raw/`. Two blocked `style-src`
requests after WebMSX starts are expected: its injected styles are unnecessary because
the app samples only its canvas. `public/_headers` documents that measured decision.

## Capture and render-on-demand contract

`tools/shoot.mjs` drives `window.__msxReady`, `window.__msxCamera(pose)`,
`window.__msx.{interactions,postFX,cameraRig,engine,adaptiveQuality}`, and optional
`window.__msxHud`. Preserve this API when changing camera or bootstrap code.

`SceneModule.update()` returns `false` when the module is settled. Once every module and
the camera settle, `Engine` skips presenting frames. External changes that the update
loop cannot observe must call `window.__msx.engine.requestRender(2)`; hiding a shadow
caster must also set `renderer.shadowMap.needsUpdate = true`. Render-coupled work belongs
in `beforeRender()`. The authoritative contract is in `src/core/types.ts`.

## Architecture

- `src/core/`: `Engine`, shared materials, lighting, post-processing, camera, adaptive
  quality, and cooperative startup scheduling.
- `src/models/`: one `SceneModule` per physical object. Keycaps remain instanced.
- `src/emulator/`: screen-source routing, WebMSX bridge, procedural TMS9918 screen,
  **Super Cósmico** ROM builder, key map, and CRT shaders.
- `src/interaction/`: instanced-aware picking, spring/damper physics, and state machine.
- `src/textures/`: seeded procedural texture generators.

Modules never import one another. They depend only on shared contracts and
`MaterialLibrary`, own their GPU resources, and release them in `dispose()`; `Engine`
disposes modules in reverse order without deep-disposing their internals.

Cloudflare Workers Static Assets serves `dist/` with no Worker script. CSP and caching
live in `public/_headers`; the `cdn.jsdelivr.net` allowances exist solely for the pinned,
SRI-verified WebMSX hotlink, so those values must change together.

If a visual defect resists material changes, isolate the post-processing chain with
`window.__msx.postFX.effects` before changing materials. Bloom, not surface roughness,
caused the project's most expensive visual debugging detour.
