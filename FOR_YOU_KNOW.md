# FOR YOU KNOW — How This Project Fits Together

This is a working, interactive replica of the **Gradiente Expert XP-800**, a Brazilian
MSX from 1985 styled like stereo equipment. With empty cartridge slots, the CRT displays
a built-in BASIC prompt. Inserting a cartridge hands the screen to WebMSX with C-BIOS.
The result is closer to a functioning film prop than a static 3D model.

## Architecture

`src/core/types.ts` is the constitution: every physical object implements `SceneModule`,
and `Engine` composes those modules without knowing their internals. Physical models
share contracts and `MaterialLibrary`, which keeps every plastic and
metal surface in the same photographic world.

The interaction layer coordinates the models through explicit APIs. The HUD reads that
layer's state through one subscription, like a dashboard wired to the instrument panel.
It does not guess whether an operation succeeded or maintain a second copy of slot state.

```text
Engine
├── core: camera, lighting, materials, post-processing, adaptive quality
├── models: main unit, keyboard, CRT, cartridges, joystick, desk
├── emulator: routed screen source, WebMSX bridge, procedural screen, Z80 game
├── interaction: picking, spring physics, and hardware state
└── textures: deterministic procedural generators
```

Each module owns its GPU resources and releases them in `dispose()`. The CRT consumes the
`ScreenSource` interface, so it does not care whether WebMSX or the procedural renderer is
driving the pixels.

The complete scene, interaction layer, HUD, and post-processing chain are required. A
failure in any of them aborts bootstrap, keeps `window.__msxReady` false, and disposes the
partial application; optional prewarming and adaptive quality may degrade safely.

## Decisions that protect the project

- WebMSX declares no license. It is never shipped, copied, bundled, or proxied; the app
  loads one commit-pinned, SRI-verified CDN artifact at runtime.
- Models, textures, and lighting assets are procedural. The site stays below 3 MB
  gzipped, excluding the hotlinked emulator.
- The real XP-800 has no reset key. Pushing either cartridge cover performs soft reset.
- On phones the HUD is a modal bottom sheet: its close control stays visible while the
  contents scroll, and tapping the backdrop or pulling the grip down also dismisses it.
  Closing returns focus to the launcher.
- Photographs outrank the written spec, but every photograph-driven correction must also
  update `docs/SPEC.md` with the measurement and source.

## Render-on-demand

The update loop keeps state alive, but `Engine` presents a frame only while something is
changing. A module returns `false` from `update()` when settled; render-coupled work runs
in `beforeRender()`. At rest the scene presents zero frames, and the frozen film grain
makes consecutive captures byte-identical.

While active, presentation is capped near 60 Hz even on 120/144 Hz displays. A
2560×1440 physical-pixel ceiling prevents mobile DPR from silently multiplying the GPU
load, and the CRT's own 60 Hz dirty scheduler follows the useful drawing-buffer size
instead of always rendering its maximum target.

External mutations must call `window.__msx.engine.requestRender(2)`. Changes to
shadow-casting geometry must also set `renderer.shadowMap.needsUpdate = true`, because the
shadow atlas is frozen between real changes.

## Lessons worth keeping

- **A seated cartridge can be at rest before reaching its commanded depth.** Connector
  friction and the detent balance the spring near 95% travel. Comparing position with
  the command kept the entire renderer awake forever; checking force and velocity lets
  it sleep without changing the cartridge's physical trajectory or seated pose.
- **Disposing geometry does not dispose instance buffers.** An InstancedMesh owns its
  matrix/color buffers separately. Each model releases those buffers explicitly, while
  shared atlas textures remain owned by the central cache.
- **A guard must prove it can reject a bad result.** Missing screen samples and empty
  interaction placeholders once passed verification. Required scene data and observed
  behavior now determine success, with planted failures testing the guards themselves.
- **The most expensive thing in the frame was a picture nobody saw.** SSAO needed a
  normal buffer, and the NormalPass that produced it re-drew the entire scene a second
  time — 124 of 284 desktop draw calls for an intermediate no viewer ever looks at.
  Swapping to n8ao, which reconstructs normals from the depth the renderer already has,
  deleted that whole submission at every quality tier. When profiling, ask what each
  draw is *for*, not just what it costs.
- **A stable spring at 60 fps may explode below it.** The keycap integrator crossed its
  semi-implicit Euler limit below about 51 fps (`h < 0.828/ω`). One invalid matrix then
  corrupted the entire instanced keyboard. Subdivide the time step; do not merely clamp
  it.
- **A material-looking defect may be post-processing.** Bloom threshold 1.0 admitted the
  light keycaps and washed out the QWERTY block. A/B isolation found the cause; threshold
  1.45 and intensity 0.6 fixed it. Test post effects before retuning materials.
- **Dormant sources need reconciliation.** The procedural screen cannot observe
  cartridge changes while WebMSX is active. On resume, rebuild its slots from desired
  state instead of trusting stale internal state.
- **A faster micro-benchmark can make the page slower.** Four texture workers reduced
  isolated generation from 750 ms to 227 ms (3.4×) with identical bytes, yet delayed
  `__msxReady` by 5–7%. The cooperative generator was already off the critical path, so
  worker startup was pure overhead.
- **Measure graphics in the real frame loop.** Sequential `gl.finish()` tests produced
  physically impossible pass costs under ANGLE/Metal. Use interleaved A/B rounds with
  rAF and disabled vsync; compare full-page readiness as well as isolated work.
- **Two visual anchors currently fail their own tests.** The console-top/keyboard-shell
  ratio is 0.85/0.74/0.69 in the render versus 0.36/0.28/0.25 in the photograph, and
  exposure 0.72 measures keycaps at rgb(172,169,162), not rgb(184,181,175). Treat these as
  open lighting-calibration defects, not reasons to rewrite the documented targets.
- **Tiny transmissive meshes can tax the whole scene.** Two indicator lenses enabled a
  renderer-wide transmission prepass. Removing transmission from those millimetric parts,
  then scheduling reflection/CRT work by elapsed time, reduced the 1080p scene from 258
  to 137 draw calls and the mobile scene from 129 to 71.
- **Shader support must be proved on the active renderer.** SMAA compiled in Chromium but
  failed on Safari/Metal and blanked the useful render. A 16×16 runtime probe now selects
  FXAA only for the incompatible path; user-agent guesses would have hidden the real
  boundary and lowered quality unnecessarily.
- **A bright inset is not proof that the screen fits.** The luminance gate deliberately
  samples inside the bezel, while responsive framing uses the uninset projected screen.
  Capture artifacts record requested/effective DPR and use p99, not a single hot pixel.
- **Input cancellation is not a click.** The keyboard bridge owns only strokes it accepted;
  repeats and keyup stay inside that path even if focus moves to an input, uncaptured
  shortcuts pass through, and pointer cancel or blur releases hardware without toggling
  cartridges or voltage.

## The cartridge game

The red **Super Cósmico** cartridge contains an authorial space-snake game assembled by
`SuperCosmicoRom.ts` and executed by the emulated Z80. The black cartridge can run a
user-owned file selected through **Carregar ROM…**; bytes stay in memory. This provides a
real emulator demonstration without distributing copyrighted commercial ROMs.

For visual work, run `node tools/shoot.mjs`, open the PNGs, and compare them with
`reference/raw/`. The capture gate can reject an unlit scene, but only a human comparison
can judge photographic fidelity.
