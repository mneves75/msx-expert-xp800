/**
 * Códigos semânticos do teclado visível → nomes da matriz aceitos por
 * `room.keyboard.processMSXKey()` no WebMSX 6.0 fixado pelo projeto.
 *
 * A fonte procedural consulta a mesma tabela antes de interpretar a tecla. Isso
 * mantém a cobertura das duas fontes idêntica mesmo quando o fallback oferece
 * apenas uma aproximação de uma função especial do MSX.
 */
export const MSX_KEY_BY_CODE: Readonly<Record<string, string>> = Object.freeze({
  Digit0: 'D0',
  Digit1: 'D1',
  Digit2: 'D2',
  Digit3: 'D3',
  Digit4: 'D4',
  Digit5: 'D5',
  Digit6: 'D6',
  Digit7: 'D7',
  Digit8: 'D8',
  Digit9: 'D9',
  Minus: 'MINUS',
  Equal: 'EQUAL',
  Backslash: 'BACKSLASH',
  IntlBackslash: 'BACKSLASH',
  BracketLeft: 'OPEN_BRACKET',
  BracketRight: 'CLOSE_BRACKET',
  Semicolon: 'SEMICOLON',
  Quote: 'QUOTE',
  /**
   * Conferido na fonte fixada do WebMSX:
   * `BuiltInKeyboards.en_BR.DEAD` inclui `VK_BR_CEDILLA`.
   */
  Cedilla: 'DEAD',
  Backquote: 'BACKQUOTE',
  Comma: 'COMMA',
  Period: 'PERIOD',
  Slash: 'SLASH',
  IntlRo: 'SLASH',
  KeyA: 'A',
  KeyB: 'B',
  KeyC: 'C',
  KeyD: 'D',
  KeyE: 'E',
  KeyF: 'F',
  KeyG: 'G',
  KeyH: 'H',
  KeyI: 'I',
  KeyJ: 'J',
  KeyK: 'K',
  KeyL: 'L',
  KeyM: 'M',
  KeyN: 'N',
  KeyO: 'O',
  KeyP: 'P',
  KeyQ: 'Q',
  KeyR: 'R',
  KeyS: 'S',
  KeyT: 'T',
  KeyU: 'U',
  KeyV: 'V',
  KeyW: 'W',
  KeyX: 'X',
  KeyY: 'Y',
  KeyZ: 'Z',
  ShiftLeft: 'SHIFT',
  ShiftRight: 'SHIFT',
  ControlLeft: 'CONTROL',
  ControlRight: 'CONTROL',
  CapsLock: 'CAPSLOCK',
  AltLeft: 'GRAPH',
  AltRight: 'CODE',
  Lang1: 'CODE',
  Lang2: 'GRAPH',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  Escape: 'ESCAPE',
  Tab: 'TAB',
  Pause: 'STOP',
  Backspace: 'BACKSPACE',
  Insert: 'INSERT',
  Delete: 'DELETE',
  Home: 'HOME',
  End: 'SELECT',
  PageUp: 'SELECT',
  Enter: 'ENTER',
  NumpadEnter: 'ENTER',
  Space: 'SPACE',
  ArrowLeft: 'LEFT',
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  ArrowRight: 'RIGHT',
  NumpadMultiply: 'NUM_MULTIPLY',
  NumpadAdd: 'NUM_PLUS',
  NumpadDivide: 'NUM_DIVIDE',
  NumpadSubtract: 'NUM_MINUS',
  NumpadDecimal: 'NUM_PERIOD',
  NumpadComma: 'NUM_COMMA',
  /**
   * A matriz internacional não tem uma segunda tecla de igual. O `=` do
   * teclado numérico do Expert aciona a mesma posição `EQUAL` da tecla principal.
   */
  NumpadEqual: 'EQUAL',
  Numpad0: 'NUM_0',
  Numpad1: 'NUM_1',
  Numpad2: 'NUM_2',
  Numpad3: 'NUM_3',
  Numpad4: 'NUM_4',
  Numpad5: 'NUM_5',
  Numpad6: 'NUM_6',
  Numpad7: 'NUM_7',
  Numpad8: 'NUM_8',
  Numpad9: 'NUM_9',
})

export function webMsxKeyForCode(code: string): string | null {
  return MSX_KEY_BY_CODE[code] ?? null
}

/**
 * A fonte procedural recebe a mesma identidade semântica que o WebMSX. A
 * interpretação visual continua em `ProceduralScreen.sendKey()`.
 */
export function proceduralKeyForCode(code: string): string | null {
  return MSX_KEY_BY_CODE[code] ?? null
}
