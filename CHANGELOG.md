# Changelog

Notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/mneves75/msx-expert-xp800/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mneves75/msx-expert-xp800/releases/tag/v0.1.0
