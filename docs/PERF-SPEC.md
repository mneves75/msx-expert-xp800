# Performance Spec — Depth-Only AO and Real Pass Toggles

Addendum (2026-08-10, v0.2.0-beta4): boot-time shader-compile latency on iOS Safari is
addressed separately — per-module `compileAsync` submissions under
`KHR_parallel_shader_compile` overlapped with texture upload and PostFX warm-up, and on
coarse pointers the n8ao pass defers its compile past first reveal (see SPEC §7 and
`CHANGELOG.md`). This document's pass-cost numbers are unaffected.

Status: **implemented** (2026-08-07, v0.2.0-beta3). Phase 1 and Phase 2 landed as
specified: `n8ao@2.0.0` replaced NormalPass+SSAOEffect, `setAOEnabled` +
`QualityProfile.ao` are the single toggle, and the AO-off rung sits at tier 2 of the
now five-tier ladder. After numbers (same machine as baseline, paired A/B within run):
frozen-chain PostFX submissions 159 → 39 desktop and 105 → 39 mobile (NormalPass ladder
line gone; n8ao adds 6 draws); dedicated AO pair desktop 9.59 → 7.87 ms (Δ 1.72 vs
2.40 baseline), mobile 7.57 → 6.29 ms (Δ 1.28 vs 2.18); at the rung's real tier-2
position the saving is 0.46 ms desktop / 0.17 ms mobile — honest per §6.3, the rung's
value is the 124/70-submission CPU relief, not GPU ms. Artifacts:
`.scratch/profile/n8ao-{desktop-1080,mobile-portrait-dpr3,rung2-desktop-1080,rung2-mobile-portrait-dpr3}.json`.
Baseline measured 2026-08-07 on the uncommitted beta2 tree (CRT ×1.624 + portrait
reframe on top of `05f16d6`), M5 Pro, ANGLE→Metal, Vite dev server. All numbers
in this document are from that one machine; claims about weaker devices are
hypotheses until measured there.
Artifacts: `.scratch/profile/spec-baseline-desktop-1080.json`,
`.scratch/profile/spec-baseline-mobile-portrait-dpr3.json`.

Origin: techniques evaluated from [Claude-of-Duty PR #2](https://github.com/mshumer/Claude-of-Duty/pull/2)
(GPU texture baking, static shadow-caster merging, depth-pass draw collapsing,
runtime feature toggles). Two transfer in adapted form; the rest were rejected
on recorded evidence (§5).

## 1. Baseline

| | desktop 1920×1080 DPR1 | mobile 390×844 DPR3 |
|---|---|---|
| chain, shadows frozen | 284 draws | 176 draws |
| — NormalPass alone | **124** | **70** |
| — SSAO+Bloom pass | 19 | 19 |
| scene only | 125 | 71 |
| power-on frame mean | 10.3 ms (p95 20.5) | 6.7 ms (p95 9.4) |
| A/B: full chain | 9.38 ms | 4.24 ms |
| A/B: minus normal+SSAO+bloom | 6.98 ms (**−2.40**) | 2.05 ms (**−2.18**) |

Trust rule for the A/B table: only the paired `fullChain` vs
`minus:normal+occlusionAndBloom` comparison is load-bearing. Rows that read
~17.1 ms (`minus:antialias`, `renderPassOnly`) are cadence-locked to ~58 Hz —
an artifact of the measurement falling back into vsync pacing, not a real cost.
Never quote a single-pass delta from that table.

CPU profile is uniform-upload bound (`uniformMatrix4fv` 36% desktop / 31%
mobile), i.e. draw-call-count bound. NormalPass is a full second scene
submission whose only consumer is SSAO. **The conclusion the spec hangs on:**
NormalPass + SSAO together cost ~25% of the desktop frame and ~50% of the
mobile frame at tier 0, and NormalPass is 44%/40% of all frozen-chain draws.

## 2. Scope and sequencing

1. **Phase 1 — depth-only AO (n8ao spike, then adoption).** Eliminates
   NormalPass at every tier, not just when quality drops.
2. **Phase 2 — real AO toggle + a new AdaptiveQuality rung.** One method on the
   PostFX seam, consumed by AdaptiveQuality and `window.__msx` only.
3. **Fallback (§4) only if the Phase-1 spike fails its gates.**

Phase 1 goes first because its outcome reshapes Phase 2: with n8ao, SSAO leaves
the fused SSAO+Bloom `EffectPass`, bloom naturally gets its own pass, and the
AO toggle collapses to a `.enabled` flip. Building the toggle first would mean
building pass-swap machinery Phase 1 then deletes.

Non-goals: user-facing quality UI (the HUD stays power/wireframe/X-ray/rotate —
deliberate product restraint); startup time (§5); shadow pass (§5); the mobile
portrait idle cost (17.1 ms/frame from the CRT phosphor sim — real, observed,
**out of scope**, belongs to a future emulator-scheduling round).

## 3. Phase 1 — replace NormalPass+SSAOEffect with n8ao

**Verified facts (2026-08-07):**

- `postprocessing` 6.x `SSAOEffect` **requires** a normal buffer; no depth-only
  mode exists in the 6.x line. A depth-only SSAO is planned for v7
  ([pmndrs/postprocessing#573](https://github.com/pmndrs/postprocessing/issues/573)),
  which is beta; this repo is on 6.39.3.
- [`n8ao`](https://github.com/N8python/n8ao) reconstructs normals from the
  depth buffer (no normal pass) and ships `N8AOPostPass` for pmndrs
  composers (add after RenderPass). v2.0.0 published 2026-07-12, active repo,
  487 stars. Peer deps satisfied by this tree: `postprocessing >=6.30.0`
  (have 6.39.3), `three >=0.137` (have 0.185.1).

**Design:** swap `NormalPass` + `SSAOEffect` for one `N8AOPostPass` placed
after the render pass; remove SSAO from the SSAO+Bloom `EffectPass`, leaving it
bloom-only. Quality profiles map their SSAO fields to n8ao's equivalents
(samples, radius, denoise, half-resolution mode for the low profile).
`N8AOPostPass.gammaCorrection` auto-configures from pipeline position — verify
it lands correct given the AgX tone-mapping pass downstream.

**Expected win:** −124/−70 draws at *every* tier (the entire NormalPass), plus
whatever n8ao's AO evaluation saves or costs vs the current SSAO — measured,
not assumed, by the spike.

**Spike gates (timebox: half a day; all must pass or fall back to §4):**

1. Works against the composer's MSAA-4 half-float buffer on the high profile
   (depth resolve interaction is the named unknown).
2. Full `tools/shoot.mjs` pose set at tier 0 passes the perceptual bar vs
   `reference/raw/` — the AO *will* differ; the gate decides if it matters.
   Known n8ao caveat to inspect for: AO blurs on moving objects (pressed keys,
   joystick) — likely invisible at this project's AO opacity, but look.
3. `tools/profile.mjs` shows the NormalPass ladder line gone and no frame-time
   regression on either target.

## 4. Fallback — only if the spike fails

Keep NormalPass + SSAOEffect and build the toggle the harder way:

- Prebuild **two** effect passes at init: SSAO+Bloom (exists) and bloom-only
  (new); exactly one enabled, both sized on resize. **Ownership rule
  (verified in the installed build): `EffectPass.dispose()` disposes its
  effects — a shared `BloomEffect` across two passes double-disposes at
  teardown. One pass owns the effects; the other's list is cleared before
  dispose.**
- `setAOEnabled(false)` also disables NormalPass (sole consumer); the coupling
  stays inside the one method.
- Optional second step, measured separately: a static normal-proxy mesh
  (world-space merged position+normal geometry for static meshes, per-object
  path for animating modules, mover-eviction on matrixWorld change).
  **`InstancedMesh` is excluded by rule** — keycaps are already ~1 draw per
  geometry×colour and merging expands 89 instances for near-zero draw savings.

## 5. Considered and rejected (do not re-litigate without new evidence)

- **GPU procedural-texture baking** (the PR's headline change): all of
  `src/textures/procedural.ts` is CPU, but generation is already cooperatively
  sliced off the critical path behind the boot veil. The repo has a measured
  negative result for this exact shape: 4 workers made isolated generation 3.4×
  faster and real `__msxReady` 5–7% *slower* (`MEMORY.md`, 2026-07-31). Boot is
  bounded by shader compile + context warm-up. Reopen only with an end-to-end
  `__msxReady` win, never an isolated bake benchmark.
- **Static shadow-caster merging**: msx froze the shadow atlas
  (`renderer.shadowMap.autoUpdate = false`); the 94-draw shadow pass only
  re-renders when a module dirties it. Steady-state cost ≈ 0.
- **Multi-material group collapse** (the PR's literal mechanism): msx has
  almost no multi-material meshes (only the cartridge).
- **Depth-only mode in postprocessing 6.x**: does not exist (verified); v7's
  planned SSAO rewrite is the thing to revisit on a future major upgrade.
- **Motion-blur default-off / settings menu**: no motion blur exists here; no
  user-facing quality UI wanted (§2).

## 6. Phase 2 — AO toggle and adaptive rung

1. `PostFX` gains **one** method, `setAOEnabled(on: boolean)` — with n8ao this
   flips the AO pass's `enabled`; in the fallback it also owns the NormalPass
   coupling. Never exposed as two independent knobs.
2. `QualityProfile` gains `ao: boolean`, wired through `applyProfile()` next to
   the existing DoF toggle, so profiles and direct calls stay one mechanism.
3. AdaptiveQuality gains one rung: **AO off**, inserted between the low-profile
   drop and the first DPR cap. Monotone-down-only, the 2 s cooldown, and the
   `navigator.webdriver` tier-0 lock stay untouched. Rationale for the
   position: the draw-call saving (124/70 submissions of CPU-side uniform
   churn) holds at any resolution scale, and resolution drops are the most
   visible degradation on a text-bearing CRT screen, so they stay last.
   **Honest caveat:** the −2.40/−2.18 ms A/B was measured at tier-0 *high*
   profile; at the rung's actual position (after the low-profile drop) the
   GPU-ms saving is smaller and unmeasured — the profiler run in §7 measures
   the rung where it actually sits before the claim goes in the changelog.
4. Debug API: `window.__msx.postFX.setAOEnabled`. No HUD surface.
5. Render-on-demand contract: external toggles call
   `window.__msx.engine.requestRender(2)`; nothing may mark modules active or
   force continuous presentation.

## 7. Verification gates (every change, no exceptions)

1. `pnpm verify` (lint + typecheck).
2. `node tools/profile.mjs --label <change>-desktop-1080` and
   `--label <change>-mobile-portrait-dpr3 --width 390 --height 844 --dpr 3`;
   compare against the spec-baseline artifacts, honoring §1's A/B trust rule.
   Phase 1 must show the NormalPass ladder line gone; Phase 2 must measure the
   new rung at its real position (lock AdaptiveQuality to the rung, profile).
3. `node tools/shoot.mjs` full pose set at tier 0, inspected against
   `reference/raw/` — the perceptual-parity bar. Two blocked `style-src`
   requests after WebMSX starts remain expected.
4. `node tools/verify-interactions2.mjs` (pass changes must not disturb picking
   or interaction state).
5. Update this spec's status to **implemented** with after numbers; changelog
   entry per house style.
