# Plan 005: Close deep-review lifecycle and probe gaps

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans 002–004
- **Category**: correctness / lifecycle / tests
- **Planned at**: commit `b7369ef`, 2026-08-07

## Why this matters

The full-source review found four paths that could approve or preserve a partial product:
required bootstrap components could be skipped, PostFX failure silently switched render
contracts, canceled pointer gestures could execute clicks, and the game probe could drag
an off-screen joystick while claiming to test the 3D path.

## Implemented

- Required scene modules, interaction, HUD, and PostFX abort bootstrap and dispose the
  partial application; runtime render failure stops the engine and sets `isHealthy=false`.
- Capture, interaction, and deployment probes assert engine health; the destructive
  PostFX regression runs only on its disposable browser page.
- Pointer cancel/blur release held state without click-only cartridge or voltage actions;
  picker occluders share one owned material.
- Removed the unused transmissive `crtGlass` API and corrected stale material/white-point
  documentation.
- The WebMSX game probe centers the joystick before projection and rejects any target
  outside the viewport instead of clamping coordinates.

## Proof

- [x] TypeScript, JavaScript syntax, ast-grep, and production build pass.
- [x] Interaction probe passes 20/20, including reset ownership, cancellation, and
  fail-closed rendering.
- [x] Super Cósmico passes splash, movement, game-over, restart, held-key, and real 3D
  joystick/GTSTCK checks (`rowDiff=144`).
- [x] Full capture batch and desktop/mobile profiles pass with healthy rendering.
- [x] No critical, high, or medium application security finding remains.

## Deferred, not hidden

- The open lighting-ratio mismatch needs a visually confirmed ROI before any material or
  exposure change. No speculative calibration was made.
- Current-build deployment proof waits for a separately authorized staging deployment.
