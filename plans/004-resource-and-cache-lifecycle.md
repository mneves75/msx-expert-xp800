# Plan 004: Reset owned GPU state and complete procedural cache keys

> **Executor instructions**: Follow each step and proof. The primary session maintains
> the plan index. Do not commit, push, tag, or deploy.
>
> **Drift check (run first)**:
> `git diff --stat b7369ef..HEAD -- src/models/Keyboard.ts src/models/CrtMonitor.ts src/textures/procedural.ts src/textures/__checks__.ts`
> Any mismatch with the excerpts below is a STOP condition.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug / tests
- **Planned at**: commit `b7369ef`, 2026-08-07

## Why this matters

`KeyboardModule.dispose()` destroys GPU objects but leaves references in material/atlas
caches, so a rebuild can reuse disposed resources. The CRT rocker casts a shadow while
its update rotates it, but the frozen shadow atlas is not invalidated. Finally,
procedural decal cache keys omit byte-affecting inputs, so semantically different calls
can return the same texture.

## Current state

- `src/models/Keyboard.ts:1297-1320` owns tone/material/atlas caches.
- `src/models/Keyboard.ts:1714-1724` disposes arrays but does not clear caches/dirty state.
- `src/models/Joystick.ts:518` is the rebuild exemplar: dispose before rebuilding.
- `src/models/CrtMonitor.ts:1792` sets rocker `castShadow`; `:2108-2114` rotates it.
- `src/textures/procedural.ts:729-752` uses `ink`/`seed` but omits them from `silk:` key.
- `src/textures/procedural.ts:917-932` uses per-legend `fontScale` but omits it from the
  atlas cache key.
- `src/textures/__checks__.ts:91-121` does not clean global cache in `finally`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Texture proof | `node tools/verify-textures.mjs` | deterministic hashes pass, cache collision checks pass |
| Interaction | `node tools/verify-interactions2.mjs` | all checks pass |
| Visual | `node tools/shoot.mjs --pose keyboard,top,front --out .scratch/review-resources` | exit 0; no console/WebGL error |

## Scope

**In scope**:
- `src/models/Keyboard.ts`
- `src/models/CrtMonitor.ts`
- `src/textures/procedural.ts`
- `src/textures/__checks__.ts`

**Out of scope**:
- Texture algorithms, baseline pixel changes, material calibrations, CRT geometry.
- A new cache abstraction or test framework.

## Steps

### Step 1: Make Keyboard rebuild from empty ownership

Call `dispose()` at the start of `build()` (safe on empty arrays), then assign the current
renderer. In `dispose()`, clear `toneCache`, `capAtlas`, shell/panel/in-use material
references, dirty instanced meshes, renderer, active keys, and key registry after owned
resources are disposed.

**Verify**: a local browser probe unregisters/registers the same module or directly
builds twice without WebGL errors; keyboard capture remains valid.

### Step 2: Invalidate the frozen shadow atlas for the CRT rocker

After calculating `rockerMoving`, set `renderer.shadowMap.needsUpdate = true` only while
the shadow-casting rocker moves. No new render loop or light is needed.

**Verify**: power transition interaction passes and a before/after frame shows the rocker
shadow following its pose.

### Step 3: Include every option that changes decal bytes in cache identity

Add normalized `ink` and `seed` to the generic silkscreen key. Add each legend's
`fontScale` to the atlas callback identity; generic width/height/wear/relief/gloss are
already in the outer key. Do not hash arbitrary callbacks or add a cache layer.

**Verify**: identical calls reuse a map; changing ink, seed, or fontScale produces a
different cached map.

### Step 4: Leave cache cleanup deterministic on failure

Wrap `verifyProceduralTextures()` after the initial cold-cache reset in `try/finally`,
with `disposeTextureCache()` in `finally`. Add the three small cache partition assertions
to this existing runnable check.

**Verify**: texture tool exits 0 twice in succession with identical hashes.

## Test plan

- Keyboard first build, dispose, second build.
- CRT on/off rocker movement with frozen shadows.
- Same vs changed ink, seed, and legend fontScale cache identity.
- Existing deterministic texture hashes unchanged.

## Done criteria

- [x] No disposed Keyboard resource remains reachable from a cache.
- [x] Moving rocker invalidates the shadow atlas.
- [x] Byte-affecting decal options partition the cache with unambiguous field identity.
- [x] Cache cleanup executes even when generation throws.
- [x] All listed checks pass; existing texture hashes do not change.

## STOP conditions

- The cache-key change alters existing texture bytes or deterministic hashes.
- A second Keyboard build requires changing the Engine lifecycle contract.
- Shadow invalidation wakes frames after the rocker settles.

## Maintenance notes

Any future option used by `decalMapsFromCanvas` or a legend draw callback must either be
part of the caller cache key or deliberately documented as non-byte-affecting.
