# Plan 003: Keep physical-key ownership inside the keyboard bridge

> **Executor instructions**: Run each proof. The primary session maintains the index.
> Do not commit, push, tag, or deploy.
>
> **Drift check (run first)**:
> `git diff --stat b7369ef..HEAD -- src/interaction/Interactions.ts tools/verify-interactions2.mjs`
> Reconcile any drift before editing.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: `plans/002-harden-verification.md`
- **Category**: bug / tests
- **Planned at**: commit `b7369ef`, 2026-08-07

## Why this matters

The capture-phase bridge is documented as the sole owner of modeled keyboard input, but
`onKeyDown` returns on `event.repeat` before swallowing browser defaults or stopping the
event. Held Space/arrows/Tab can scroll or focus the page and reach WebMSX's global
handler. `onKeyUp` also captures modeled keys whose Ctrl/Meta keydown the bridge allowed
through, which can strand the downstream key.

## Current state

- `src/interaction/Interactions.ts:587-590` declares single keyboard authority.
- `src/interaction/Interactions.ts:1900-1934` drops repeats too early and resolves keyup
  independently from accepted keydown.
- `releaseAllKeys()` is called by power-off, reset, blur, visibility loss, and dispose.
- The existing aggregated MSX key-owner map handles rig/joystick ownership; do not reuse
  it for DOM physical-code ownership.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Interaction | `node tools/verify-interactions2.mjs` | repeat/default/propagation and input checks pass |
| Key map | `node tools/verify-keymap.mjs` | 93/93 PASS |

## Scope

**In scope**:
- `src/interaction/Interactions.ts`
- `tools/verify-interactions2.mjs`

**Out of scope**:
- Emulator keymap, joystick ownership algorithm, browser shortcut policy, new public API.

## Steps

### Step 1: Track only DOM keys accepted by the bridge

Add a map from physical `KeyboardEvent.code` to resolved MSX key code. On an accepted
non-repeat keydown, store it before `pressKey`. On a repeat for an owned physical code,
apply the same default prevention policy, stop propagation, and do not press again.
Ctrl/Meta and unhandled Alt events remain unowned and pass through.

**Verify**: TypeScript passes and no duplicate call to `pressKey` occurs for repeats.

### Step 2: Release only owned keyups and clear ownership globally

On keyup, look up/delete the physical code; if absent, pass the event through. If owned,
stop propagation and release the stored resolved code. Clear the map in
`releaseAllKeys()` so power/blur/visibility/dispose cannot leave stale ownership.

**Verify**: a Ctrl+modeled-key down/up pair bubbles; an owned Space down/repeat/up pair
does not bubble and produces exactly one down/up pair at `ScreenSource.sendKey`.

### Step 3: Add the smallest browser-event regression checks

Extend `verify-interactions2.mjs` using synthetic cancelable bubbling keyboard events.
Assert first and repeated Space are prevented and do not reach a document listener;
assert Ctrl+KeyC down/up pass through; assert screen instrumentation sees one Space
down/up pair.

**Verify**: interaction command reports named PASS checks and exits 0.

## Test plan

- Owned: Space keydown, repeated keydown, keyup.
- Passed through: Ctrl+KeyC down and keyup.
- Lifecycle: call `releaseAllKeys` indirectly with blur/power-off and ensure next keydown
  is treated as new ownership.

## Done criteria

- [x] Repeats cannot trigger browser defaults or the WebMSX global path.
- [x] Passed-through chord keyups are not captured.
- [x] Exactly one emulator down/up pair occurs for a held key.
- [x] Reset/power/blur release retains DOM suppression until keyup or a fresh keydown.
- [x] Owned repeats and keyup remain captured if focus moves to a text entry.
- [x] All listed commands pass through their exact local binaries.

## STOP conditions

- Synthetic events do not exercise the capture listener in Chromium.
- Fix requires changing WebMSX or public `InteractionsHandle`.

## Maintenance notes

The DOM ownership map answers “did this bridge capture this physical stroke?”; the
existing MSX owner map answers “which internal source still holds this MSX key?” Keep
those responsibilities separate.
