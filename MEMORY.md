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
- The mobile HUD is a modal bottom sheet with a sticky close control, backdrop-tap, and
  downward-grip-swipe dismissal. Closing restores focus to its launcher, and
  `verify-interactions2.mjs` owns the visibility and hit-target regression checks.
- Modules return `false` from `update()` when settled; render-coupled work belongs in
  `beforeRender()`. External mutations call `engine.requestRender(2)`, and moved or hidden
  shadow casters also invalidate the frozen shadow map.
- `wrangler.jsonc` keeps production and `msx-expert-xp800-staging` as separate Cloudflare
  Worker targets. Staging uses `pnpm deploy:staging`; production remains `pnpm deploy`.
- Active presentation is capped near 60 Hz, the drawing buffer at 2560×1440 physical
  pixels, and the CRT target at 1536×1152. Profiling explicitly disables the presentation
  cap when measuring raw frame cost.
- Coarse pointers and reduced-motion users start without idle auto-rotation. SMAA remains
  the preferred antialiaser, with FXAA selected only after a real renderer probe fails.

## Measured calibrations

- AgX exposure: **0.72**. The original ROI sweep reported keycaps at
  rgb(184,181,175) against `#B8B5AC` = rgb(184,181,172); the current render no longer
  reproduces that result, as recorded below.
- Bloom: **threshold 1.45, intensity 0.6**. A/B showed that threshold 1.0 admitted the
  light keycaps and washed out the QWERTY block.
- Keycap roughness: **0.55 fresh / 0.36 worn**. The former 0.42/0.28 values produced
  excessive softbox glare; the 1985 ABS reference is more matte.
- CRT: **scale 1.624** (exactly 40% above 1.16), `position.z = −0.465`. Its
  table-level/front-face origin keeps the feet and console gap anchored while making the
  ~21.4-inch monitor easier to view.
- Key travel: **2.6 mm**, confirmed numerically across all nine key classes.
- Black keyboard panel: `#141414`, roughness **0.90**, specular intensity **0.08**. The
  reference remains black under flash; the former `#232323` and 0.80/0.30 response lifted
  and shifted blue under IBL.

## Audit evidence — 2026-09-05

- At the same desktop profile pose, scene submissions fell from **112 to 110**,
  frozen/full submissions from **151/245 to 149/243**, and shader programs from
  **78 to 74**. These are work counters, not a claimed frame-time improvement;
  interleaved timing samples remained noisy. Mobile simulation measured **108**
  scene submissions at 390×844, requested DPR 3, effective DPR 2.
- A seated cartridge formerly kept the powered-off scene rendering because its
  detent equilibrium differed from the commanded endpoint. The corrected rest
  predicate preserves the trajectory and yields **zero** renderer submissions
  during the one-second settled check. The physics regression covers 30/60/144 Hz.
- Real WebGL disposal verification freed all **36** uploaded instance attributes.
  The nine retained procedural texture hashes are unchanged.
- The managed offline verification passes build, lint, guard controls, key mapping,
  textures, physics and **43/43** interaction checks. Online verification also plays
  the real WebMSX game through movement, wall death, restart and joystick input.
- Detailed decisions and release evidence are in `memory/2026-09-05.md` and the
  audit plan. Physical mobile hardware and non-Apple GPUs remain unverified.

## Performance evidence — 2026-08-07

- At 1920×1080 DPR 1, scene draw calls fell from **258 to 137**, full/frozen submissions
  from **523/429 to 402/308**, and triangles from **677,173 to 507,817**.
- At 390×844 DPR 1, scene calls fell from **129 to 71**, full/frozen submissions from
  **328/234 to 270/176**, and triangles from **584,617 to 445,825**.
- A requested mobile DPR 3 resolves to renderer DPR 2 and a 780×1688 drawing buffer. The
  artifact records viewport, effective DPR, drawing buffer, CPU count, and load average.
- With full projected-screen framing, current scene-only counts are **112** / **467,609**
  triangles at 1920×1080 DPR 1 and **110** / **477,637** at 390×844 requested DPR 3;
  both remain under the <150 budget. The counts are frustum-dependent, so compare
  performance only at an identical pose.
- Depth-only AO (n8ao 2.0.0) replaced NormalPass+SSAO in v0.2.0-beta3: PostFX
  submissions fell from **159 to 39** desktop and **105 to 39** mobile, and the paired
  AO cost from **2.40 to 1.72 ms** desktop / **2.18 to 1.28 ms** mobile. The adaptive
  ladder is five tiers; AO-off is tier 2, before any DPR cap, because the submission
  saving holds at any resolution while resolution drops are the most visible loss on a
  text-bearing CRT. Full spec and after-numbers: `docs/PERF-SPEC.md`.

## Open measured mismatches

- The console-top/keyboard-shell RGB ratio measures **0.85/0.74/0.69** in the render
  versus **0.36/0.28/0.25** in `CF3000_and_XP800.jpg`. The albedo ratio is already close;
  the top receives about twice the keyboard's illumination. Fix lighting distribution,
  not shell color, and verify with `tools/tune-case.mjs`.
- Exposure 0.72 now measures QWERTY keycaps at **rgb(172,169,162)**, while exposure 1.0
  produces **rgb(184,181,175)**. Re-run `tools/tune-exposure.mjs` before changing the
  documented exposure target.

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
- A tiny `MeshPhysicalMaterial.transmission` can create a scene-wide prepass. Reserve
  transmission for optics whose refraction is visible; clearcoat/opacity is enough for
  indicator lenses.
- Coarse state publication needs semantic endpoints in addition to numeric deltas. A 2%
  threshold could leave the HUD cached at 99%; publish the ready and zero crossings
  explicitly.
- Geometry fit and luminance sampling need different ROIs. A 14%-inset phosphor sample
  can prove the tube is lit but cannot prove that its full projected bounds fit the
  viewport; record both, and gate fit on the uninset box.
- Physical input ownership starts at accepted keydown and ends at its matching keyup.
  Forced hardware release keeps a tombstone until keyup or a fresh non-repeat keydown;
  handle owned events before any later text-entry exclusion, swallow repeats, pass
  through chords never accepted, and treat pointer cancellation as release without
  click-only side effects.
- A required render pipeline must fail closed. Silent direct-render fallbacks can publish
  a partial visual result as ready and make capture/deployment probes approve the wrong
  product.
- Rewriting Git history does not immediately remove an orphaned object from GitHub's API.
  Sensitive material must never enter a published repository in the first place.
