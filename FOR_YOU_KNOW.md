# FOR YOU KNOW — How This Project Fits Together

This is a working, interactive replica of the **Gradiente Expert XP-800**, a Brazilian
MSX from 1985 styled like stereo equipment. With empty cartridge slots, the CRT displays
a built-in BASIC prompt. Inserting a cartridge hands the screen to WebMSX with C-BIOS.
The result is closer to a functioning film prop than a static 3D model.

## Architecture

`src/core/types.ts` is the constitution: every physical object implements `SceneModule`,
and `Engine` composes those modules without knowing their internals. Modules never import
one another. They share contracts and `MaterialLibrary`, which keeps every plastic and
metal surface in the same photographic world.

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

## Decisions that protect the project

- WebMSX declares no license. It is never shipped, copied, bundled, or proxied; the app
  loads one commit-pinned, SRI-verified CDN artifact at runtime.
- Models, textures, and lighting assets are procedural. The site stays below 3 MB
  gzipped, excluding the hotlinked emulator.
- The real XP-800 has no reset key. Pushing either cartridge cover performs soft reset.
- Photographs outrank the written spec, but every photograph-driven correction must also
  update `docs/SPEC.md` with the measurement and source.

## Render-on-demand

The update loop keeps state alive, but `Engine` presents a frame only while something is
changing. A module returns `false` from `update()` when settled; render-coupled work runs
in `beforeRender()`. At rest the scene presents zero frames, and the frozen film grain
makes consecutive captures byte-identical.

External mutations must call `window.__msx.engine.requestRender(2)`. Changes to
shadow-casting geometry must also set `renderer.shadowMap.needsUpdate = true`, because the
shadow atlas is frozen between real changes.

## Lessons worth keeping

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
- **The draw-call budget is not met.** At 1080p the scene contributes 258 calls,
  NormalPass 136, SSAO/bloom 19, DoF 12, and SMAA 3, totaling 429; a shadow refresh reaches
  523. NormalPass is the largest isolated lever.

## The cartridge game

The red **Super Cósmico** cartridge contains an authorial space-snake game assembled by
`SuperCosmicoRom.ts` and executed by the emulated Z80. The black cartridge can run a
user-owned file selected through **Carregar ROM…**; bytes stay in memory. This provides a
real emulator demonstration without distributing copyrighted commercial ROMs.

For visual work, run `node tools/shoot.mjs`, open the PNGs, and compare them with
`reference/raw/`. The capture gate can reject an unlit scene, but only a human comparison
can judge photographic fidelity.
