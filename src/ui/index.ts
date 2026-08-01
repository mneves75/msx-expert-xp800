/**
 * Ponto de entrada da camada de UI.
 *
 * `main.ts` importa `createHud` e `destroyHud` estaticamente de `Hud.ts`. Este barril
 * mantém apenas a superfície pública nomeada e os tipos do HUD para consumidores que
 * preferem importar a camada como um todo.
 */

export {
  createHud,
  destroyHud,
  type HudCartridge,
  type HudHandle,
  type HudIntent,
  type HudIntentType,
  type HudInteractions,
  type HudSlotState,
  type HudState,
  type SlotId,
} from './Hud'
