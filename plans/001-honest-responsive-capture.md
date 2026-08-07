# Plan 001: Make responsive capture proof honest

> **Executor instructions**: Follow every step and run every verification command. The
> primary session maintains `plans/README.md`. Do not commit, push, tag, or deploy.
>
> **Drift check (run first)**:
> `git diff --stat b7369ef..HEAD -- src/core/CameraRig.ts tools/capture-guard.mjs tools/shoot.mjs tools/profile.mjs docs/SPEC.md MEMORY.md memory/2026-08-07.md CHANGELOG.md`
> If any source/tool file changed, compare it with the excerpts below before proceeding.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug / tests
- **Planned at**: commit `b7369ef`, 2026-08-07

## Why this matters

The beta2 profiler claimed the enlarged screen fit desktop and portrait viewports, but it
checked a 14%-inset luminance ROI. Back-solving the recorded mobile artifact produces a
full screen box of `x=-0.192..1.192`; desktop produces `y=-0.0656`. The same release also
passed `--dpr 3` to `shoot.mjs`, although that tool hardcodes DPR 1. These are proof bugs:
the visual change may be valid, but the evidence does not establish it.

## Current state

- `tools/capture-guard.mjs:85-132` — `objectRoi()` always insets each edge by 14%.
- `tools/profile.mjs:116-131` — uses that inset ROI as a clipping gate.
- `tools/shoot.mjs:126-129` — hardcodes `deviceScaleFactor: 1`; unknown poses only warn.
- `tools/shoot.mjs:61-72` — computes p99 but gates on `max`, so one hot pixel can pass.
- `src/core/CameraRig.ts:79-105` — beta2 desktop distance/target are `1.12/[0,.24,-.06]`;
  portrait is `0.99/[0,.23,-.12]`.
- Measured without editing source: portrait screen fits at roughly distance 1.50; desktop
  needs a higher target or more distance. Preserve a large readable screen, not the whole
  cabinet, because the request is easy CRT viewing.
- `docs/SPEC.md` owns visual values; photographs outrank it. Do not change scale 1.624.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Static gate | `pnpm verify` | exit 0; only documented GLSL warnings |
| Build | `pnpm build` | exit 0 |
| Desktop proof | `node tools/profile.mjs --width 1920 --height 1080 --dpr 1 --frames 20 --bench-frames 30 --cpu-ms 250 --label review-desktop` | exit 0; full `screenRoi` inside 0..1 |
| Mobile proof | `node tools/profile.mjs --width 390 --height 844 --dpr 3 --frames 20 --bench-frames 30 --cpu-ms 250 --label review-mobile` | exit 0; full `screenRoi` inside 0..1 and actual DPR/buffer recorded |
| Capture | `node tools/shoot.mjs --pose hero,front,screen --out .scratch/review-capture --dpr 2` | exit 0; sidecar records requested/actual DPR |

## Scope

**In scope**:
- `src/core/CameraRig.ts`
- `tools/capture-guard.mjs`
- `tools/shoot.mjs`
- `tools/profile.mjs`
- `docs/SPEC.md`, `MEMORY.md`, `memory/2026-08-07.md`, `CHANGELOG.md`

**Out of scope**:
- CRT scale, geometry, materials, lights, post-processing, and public APIs.
- Performance optimizations without an A/B measurement.
- Release/version/tag/deployment work.

## Git workflow

- Stay on `main`; do not create a branch or commit in this execution.
- Preserve unrelated changes and never push.

## Steps

### Step 1: Separate measurement ROI from fit ROI

Add an `inset` argument to `objectRoi`, defaulting to the existing 0.14 for luminance.
Validate `0 <= inset < 0.5`. Make `profile.mjs` call it with `0`, while `shoot.mjs`
keeps the default. This fixes the root cause once without duplicating projection math.

**Verify**: run both profile commands above. Before camera calibration they must fail with
`responsive default clips the CRT screen`; after Step 2 they must pass.

### Step 2: Calibrate desktop and portrait defaults against the full screen

Keep scale 1.624. Raise the desktop target enough to retain beta2's screen size without
top clipping. Increase portrait distance enough to fit the full screen horizontally with
a small margin. Apply the same hero/front values in `shoot.mjs`.

**Verify**: both profile JSON files contain `screenRoi.x/y >= 0` and
`x+width/y+height <= 1`.

### Step 3: Make `shoot.mjs` prove the requested capture

Parse a positive `--dpr`; use it as `deviceScaleFactor`; record requested and actual
viewport/DPR/drawing-buffer values in `capture.json`. Reject unknown poses before opening
the browser. Validate numeric width, height, settle, FOV, and DPR inputs. Replace the
single-pixel `max` gate with the already-measured p99; use a threshold separated from the
historical dead screen (~12) and current lit hero (~125–130 p99).

**Verify**:
- `node tools/shoot.mjs --pose does-not-exist` exits non-zero before browser launch.
- `node tools/shoot.mjs --pose hero --out .scratch/review-capture --dpr 2` exits 0 and
  reports DPR 2 in its sidecar.
- A lit hero clears mean and p99; no gate depends on `max`.

### Step 4: Validate all profiler inputs

Use the existing positive-number parser. Width, height, frame counts, bench frames, and
CPU duration must be positive integers; the rAF count must exceed the five discarded
warm-up samples. Restrict `--label` to a single safe filename component.

**Verify**:
- `node tools/profile.mjs --frames 5` exits non-zero with a clear input error.
- `node tools/profile.mjs --label ../escape` exits non-zero and writes nothing outside
  `.scratch/profile`.

### Step 5: Correct documentation claims

Record that prior beta2 viewport proof used an inset ROI and has been superseded. Add an
Unreleased changelog bullet for corrected responsive framing and proof. Do not rewrite
historical measurements; distinguish the old artifact from the corrected one.

**Verify**: `git diff --check` exits 0 and no doc claims the old inset ROI proved full fit.

## Test plan

- Invalid CLI cases: bad pose, DPR 0, width NaN, five rAF frames, traversal label.
- Desktop 1920×1080 DPR1 and mobile 390×844 requested DPR3.
- Lit-subject regression at hero/front/screen using robust p99.
- Inspect the desktop and mobile PNGs in a real browser/device after capture.

## Done criteria

- [x] Both full-screen ROIs are within 0..1.
- [x] Capture sidecar proves requested and actual DPR/buffer.
- [x] Invalid inputs fail before expensive browser work.
- [x] Pinned local lint, typecheck, and production build exit 0 (pnpm wrapper caveat in index).
- [x] Documentation no longer overstates beta2 evidence.
- [x] No in-scope visual value except camera framing changed.
- [x] The `front` capture tuple matches the responsive portrait pose.

## STOP conditions

- Fitting the screen requires changing scale, FOV, model geometry, or max camera distance.
- Corrected camera makes the keyboard/main unit unusable in the hero composition.
- A current lit hero has p99 below 100; remeasure rather than lowering blindly.

## Maintenance notes

Use inset 0 only for geometry fit and 0.14 for phosphor luminance. A future screen geometry
change must rerun both profile viewports; a future threshold change needs lit and dead pixel
evidence in the same sidecar vocabulary.
