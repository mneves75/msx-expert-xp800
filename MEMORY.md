# MEMORY — Gradiente Expert XP-800 3D

Curated project decisions and measurements. Read this with the newest
`memory/YYYY-MM-DD.md`; implementation details belong in code and current rules belong in
`AGENTS.md`.

## Product and architecture decisions

- The project is a product-photography-grade Three.js replica of the 1985 Gradiente
  Expert XP-800: a stereo-style main unit and detached keyboard, not a wedge computer.
- WebMSX has no declared license and is runtime-hotlinked only from the pinned,
  SRI-verified jsDelivr URL. Never vendor or proxy it.
- All geometry and textures are procedural; the gzipped project budget is below 3 MB,
  excluding WebMSX.
- Empty cartridge slots use the procedural BASIC screen. Insertion promotes to WebMSX;
  ejecting the last cartridge returns to BASIC. A source that resumes after dormancy must
  reconcile its slots with desired state.
- Pushing either slot cover performs soft reset; the real machine has no reset key.
- The red cartridge runs the authorial Z80 game **Super Cósmico**. The black cartridge
  runs a user-selected ROM of at most 2 MB; bytes remain in browser memory.
- Modules return `false` from `update()` when settled; render-coupled work belongs in
  `beforeRender()`. External mutations call `engine.requestRender(2)`, and moved or hidden
  shadow casters also invalidate the frozen shadow map.
- `wrangler.jsonc` defines one Cloudflare Worker with no separate environment. Staging
  and production currently refer to the same deployed artifact.

## Measured calibrations

- AgX exposure: **0.72**. The original ROI sweep reported keycaps at
  rgb(184,181,175) against `#B8B5AC` = rgb(184,181,172); the current render no longer
  reproduces that result, as recorded below.
- Bloom: **threshold 1.45, intensity 0.6**. A/B showed that threshold 1.0 admitted the
  light keycaps and washed out the QWERTY block.
- Keycap roughness: **0.55 fresh / 0.36 worn**. The former 0.42/0.28 values produced
  excessive softbox glare; the 1985 ABS reference is more matte.
- CRT: **scale 1.16**, `position.z = −0.465`, preserving the rear gap while making the
  monitor dominate the composition.
- Key travel: **2.6 mm**, confirmed numerically across all nine key classes.
- Black keyboard panel: `#141414`, roughness **0.90**, specular intensity **0.08**. The
  reference remains black under flash; the former `#232323` and 0.80/0.30 response lifted
  and shifted blue under IBL.

## Open measured mismatches

- The console-top/keyboard-shell RGB ratio measures **0.85/0.74/0.69** in the render
  versus **0.36/0.28/0.25** in `CF3000_and_XP800.jpg`. The albedo ratio is already close;
  the top receives about twice the keyboard's illumination. Fix lighting distribution,
  not shell color, and verify with `tools/tune-case.mjs`.
- Exposure 0.72 now measures QWERTY keycaps at **rgb(172,169,162)**, while exposure 1.0
  produces **rgb(184,181,175)**. Re-run `tools/tune-exposure.mjs` before changing the
  documented exposure target.
- At 1080p, idle draw calls decompose as **258 scene + 136 NormalPass + 19 SSAO/bloom +
  12 DoF + 3 SMAA = 429**; a shadow refresh reaches **523**. This exceeds the target of
  150 even before post-processing. NormalPass is the largest isolated lever.

## Expensive lessons

- The keycap spring became unstable below about **51 fps** because the clamped
  semi-implicit Euler step exceeded `h < 0.828/ω` (**19.7 ms at ω = 42**). One NaN
  corrupted the shared `InstancedMesh`. Subdivide long frames; do not clamp to 1/30 s.
- A stubborn surface defect may come from post-processing. The QWERTY glare survived
  material changes because bloom, not roughness, caused it. Isolate effects before
  changing calibrated materials.
- Four texture workers reduced isolated generation from **750 ms to 227 ms (3.4×)** with
  identical bytes but delayed real-page `__msxReady` by **5–7%**. The cooperative
  generator was already off the critical path; worker startup made the product slower.
- Sequential graphics benchmarks drift. `gl.finish()` under headless ANGLE/Metal did not
  provide a trustworthy completion barrier. Use interleaved rAF A/B rounds with vsync
  disabled, and reject performance gains below the measured noise floor.
- Rewriting Git history does not immediately remove an orphaned object from GitHub's API.
  Sensitive material must never enter a published repository in the first place.
