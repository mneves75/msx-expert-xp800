/**
 * Interaction layer — public surface.
 *
 * ```ts
 * import { createInteractions } from './interaction'
 * const interactions = createInteractions(engine.context) // SceneModule + HUD handle
 * ```
 *
 * `main.ts` wires {@link createInteractions} by a direct static import. This barrel is
 * the explicit public surface for other consumers: named implementations plus their
 * type contracts, with no discovery bootstrap or compatibility namespace.
 *
 * Three files, three jobs:
 *
 * - `Picker.ts` — where the ray hits, what is hovered, which gesture is running.
 * - `Physics.ts` — how things move: keycap stroke, cartridge insertion, flap swing,
 *   cable sag. Reusable on its own; it knows nothing about this machine.
 * - `Interactions.ts` — what any of it *means*: power-on ramps, the cover-push reset,
 *   cartridge transport, the emulator keyboard bridge, display modes.
 */

export {
  createInteractions,
  getInteractions,
  type CartridgeOption,
  type InteractionsHandle,
  type InteractionsModule,
  type InteractionsState,
  type ShortcutHint,
  type SlotId,
} from './Interactions'

export {
  RaycastPicker,
  type OrbitControlLike,
  type PickCursor,
  type PickHit,
  type PickerHandlers,
  type PickerOptions,
} from './Picker'

export {
  Cable,
  CartridgeInsertion,
  HingeFlap,
  KEYCAP_TRAVEL,
  KeycapTravel,
  Spring,
  TubeCable,
  bindTubeToCable,
  catenary,
  clamp,
  clamp01,
  damp,
  type CableOptions,
  type CartridgeInsertionOptions,
  type HingeFlapOptions,
  type KeycapTravelOptions,
  type SpringOptions,
} from './Physics'
