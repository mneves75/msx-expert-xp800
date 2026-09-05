# Changelog

Notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-09-05

### Fixed

- Let seated cartridges settle at their physical detent so a powered-off scene can stop rendering without changing the insertion animation.
- Keep HUD slot state authoritative when an insertion is rejected, and release owned instanced GPU buffers during teardown.
- Derive desk contact shadows from visible geometry and actual instance transforms, removing an invisible quad that enlarged the console's shadow.
- Keep Tab and Shift+Tab focus inside the mobile control panel while it is open.

### Removed

- Deleted HUD compatibility/discovery scaffolding, duplicate CRT processing paths, unused texture generators and cartridge variants, and superseded incident probes.

### Changed

- Added portable managed offline/online browser verification, observed animation and input assertions, failing-control tests for capture/security guards, and a reproducible SwiftShader CI gate.
- Consolidated agent instructions in AGENTS.md, documented isolated checkout setup, and embedded the package version in deployed HTML.

### Security

- Disabled WebMSX query-string configuration overrides, patched transitive nanoid to 3.3.18, and made deployment checks reject missing or broadened CSP directives.

## [0.2.0-beta7] — 2026-08-10

### Fixed

- Restored pointer hit testing on the sticky mobile sheet header, keeping its close button and pull-down grip usable above scrolled controls.

## [0.2.0-beta6] — 2026-08-10

### Fixed

- Kept the mobile control panel's close action visible while scrolling and added backdrop-tap dismissal.

### Security

- Pinned transitive `nanoid` to 3.3.17, clearing the high-severity advisory in the Vite/PostCSS build chain.

## [0.2.0-beta5] — 2026-08-10

### Removed

- The beta4 parallel shader compilation (`compileAsync` under `KHR_parallel_shader_compile`) — a controlled cold-cache A/B on the iOS simulator measured it as a net regression (24.6 s vs 19.9 s baseline to scene-ready): the programs it links are not the ones the real warm-up renders use, because light and shadow specializations recompile, so boot paid program generation twice. The sliced warm-up path is the boot compiler again.

### Changed

- The mobile AO deferral from beta4 is retained — it measured as the only net win (18.9 s cold vs 19.9 s baseline on the same device and load window, with warm visits around 2.2 s) and the AO fade-in lands about a second after the scene reveals.

## [0.2.0-beta4] — 2026-08-10

### Changed

- Scene shader programs now compile in parallel with the rest of the boot through `KHR_parallel_shader_compile`: each module's subtree is submitted in its own slice right after registration and the driver links while textures upload and post-processing warms, with the previous sliced warm-up unchanged as the fallback when the extension is absent.
- On coarse-pointer (mobile) devices the n8ao ambient-occlusion pass — the largest shader in the app — no longer compiles before the first frame: the scene reveals without AO and the pass warms and re-enables during idle time right after readiness, skipped permanently once the adaptive ladder reaches the AO-off tier. Capture and automation (`navigator.webdriver`) keep the previous frame-one-with-AO behavior.

## [0.2.0-beta3] — 2026-08-07

### Added

- Real ambient-occlusion toggle (`PostFX.setAOEnabled`, `QualityProfile.ao`) and a new adaptive-quality rung that switches AO off before any resolution drop, expanding the ladder to five monotone-down tiers.
- `--lock-tier` flag and a dedicated interleaved AO on/off pair measurement in the profiling tool.

### Changed

- Replaced the normal-pass SSAO with depth-only ambient occlusion (n8ao), eliminating a full second scene submission at every tier: 120 fewer desktop and 66 fewer mobile draw calls, with the AO cost falling from 2.40 ms to 1.72 ms on desktop and from 2.18 ms to 1.28 ms on mobile.

- Reframed desktop and portrait defaults against the CRT's full projected bounds and made required scene, interaction, HUD, and post-processing components fail boot closed.
- Made capture artifacts record requested and effective DPR, drawing-buffer dimensions, and robust p99 screen luminance instead of a single-pixel peak.

### Fixed

- Prevented physical-key repeats from escaping to browser/WebMSX handlers, preserved uncaptured Ctrl/Meta chords, and stopped canceled pointer gestures from triggering click-only hardware actions.
- Made keyboard rebuilds release cached GPU state, refreshed frozen shadows while the CRT rocker moves, and completed procedural texture cache identities.
- Hardened interaction, game, deployment, and JavaScript syntax probes so off-screen targets, partial scenes, render-pipeline failures, and unexpected CSP violations cannot report false success.

## [0.2.0-beta2] — 2026-08-07

### Changed

- Increased the CRT scale exactly 40%, from 1.16 to 1.624 (about 15.3 to 21.4 inches), while preserving its table and console-gap anchors for easier viewing.
- Reframed the default desktop and portrait cameras around the larger screen.
- Made performance checks validate the app-selected responsive camera and made structural lint reproducible in clean clones.

## [0.2.0-beta1] — 2026-08-07

### Added

- Added an isolated Cloudflare staging Worker and `pnpm deploy:staging`; production deployment remains a separate command.
- Added DPR-aware performance profiles with actual renderer pixel ratio, drawing-buffer dimensions, host CPU data, and load averages.

### Changed

- Capped presentation at approximately 60 Hz and the physical drawing buffer at 2560×1440 pixels, while preserving uncapped raw-cost profiling.
- Disabled idle auto-rotation by default for coarse pointers and reduced-motion users, and made the mobile control sheet opaque without canvas blur.
- Updated Wrangler to 4.119.0 and pinned transitive `undici` 7.29.0.

### Fixed

- Added an SMAA runtime shader probe that falls back to FXAA only on incompatible renderers, restoring the complete scene on Safari/iOS without lowering quality elsewhere.
- Published the CRT's ready and fully-off state at exact endpoints so the HUD cannot remain at “Aquecendo · 99%”.

### Performance

- Reduced the 1080p scene from 258 to 137 draw calls and 677,173 to 507,817 triangles; full/frozen submissions fell from 523/429 to 402/308.
- Reduced the 390×844 mobile scene from 129 to 71 draw calls and 584,617 to 445,825 triangles; full/frozen submissions fell from 328/234 to 270/176.
- Removed transmission from two tiny indicator lenses, scheduled desk reflections by elapsed presentation time, and sized the 60 Hz CRT target to the active drawing buffer with a 1536×1152 ceiling.

### Security

- Added a blocking moderate-severity dependency audit to CI and expanded local secret/private-key ignore patterns.
- Completed a source, dependency, runtime-boundary, SRI, response-header, and generated-artifact review with no exploitable critical, high, or medium application finding.

## [0.1.0] — 2026-08-02

First public release.

### Added

- Interactive, procedurally generated Three.js reconstruction of the Gradiente Expert XP-800: main unit, detached 89-key Brazilian keyboard, period CRT, joystick, cartridges, studio set, materials, wear, and textures.
- Authentic power, cartridge, slot-cover soft-reset, 3D keyboard, physical-keyboard, joystick, wireframe, X-ray, camera-reset, and auto-rotation controls.
- Authorial Z80 game **Super Cósmico**, executed by WebMSX, plus browser-only loading of user-owned `.rom` files up to 2 MB; ROM bytes remain in memory and are never uploaded.
- Procedural TMS9918 screen with a working BASIC prompt when both slots are empty or the emulator CDN is unavailable.
- CRT simulation with curvature, phosphor mask, scanlines, persistence, composite artifacts, halation, reflections, warm-up, shutdown decay, and emitted screen light.
- Capture, interaction, key-map, deployment, game, calibration, load, texture, and rendering-performance verification tools.

### Changed

- WebMSX loads only when a cartridge requires it, from a commit-pinned, SRI-verified jsDelivr URL. The project never redistributes WebMSX or proprietary BIOS or game ROMs.
- The specification matches photograph-derived geometry and materials, including the 31/61 mm shell/fascia split, 5.5 mm shell fillet, 2×5 button cluster, vent counts, calibrated colors, and POWER indicator position.
- Cable spans use the shared catenary solver, and the fill light uses the specified 6000 K temperature.
- Emulator routing follows cartridge state: empty slots use the procedural BASIC screen, insertion promotes to WebMSX, and ejecting the last cartridge returns to BASIC.

### Fixed

- Spring integration remains stable below 51 fps without corrupting the instanced keyboard, while preserving the measured 2.6 mm key travel.
- Cartridge state is reconciled when a dormant screen resumes, preventing stale cartridges and boot/ejection races.
- Local ROM validation, deferred loading while powered off, input ownership, held-key release, and game restart behavior match the live emulator flow.
- The CRT completes phosphor decay after power-off; lifecycle timers and input sources are released during disposal.

### Performance

- Render-on-demand skips presentation while the scene is settled; the frozen shadow atlas redraws only when shadow-casting geometry changes.
- Cooperative procedural generation, staged GPU warm-up, seeded texture caches, and a measured degrade-only quality ladder reduce startup and rendering cost without changing generated texture bytes.

### Security

- Cloudflare response headers enforce CSP, HSTS, `nosniff`, frame denial, and immutable caching for hashed assets; CI actions are commit-pinned.
- Reference photographs without redistribution licenses are excluded from the repository and fetched only for local comparison.

[Unreleased]: https://github.com/mneves75/msx-expert-xp800/compare/v0.2.0-beta7...HEAD
[0.2.0-beta7]: https://github.com/mneves75/msx-expert-xp800/compare/v0.2.0-beta6...v0.2.0-beta7
[0.2.0-beta6]: https://github.com/mneves75/msx-expert-xp800/compare/v0.2.0-beta5...v0.2.0-beta6
[0.2.0-beta5]: https://github.com/mneves75/msx-expert-xp800/compare/v0.2.0-beta4...v0.2.0-beta5
[0.2.0-beta4]: https://github.com/mneves75/msx-expert-xp800/compare/v0.2.0-beta3...v0.2.0-beta4
[0.2.0-beta3]: https://github.com/mneves75/msx-expert-xp800/compare/v0.2.0-beta2...v0.2.0-beta3
[0.2.0-beta2]: https://github.com/mneves75/msx-expert-xp800/compare/v0.2.0-beta1...v0.2.0-beta2
[0.2.0-beta1]: https://github.com/mneves75/msx-expert-xp800/compare/v0.1.0...v0.2.0-beta1
[0.1.0]: https://github.com/mneves75/msx-expert-xp800/releases/tag/v0.1.0
