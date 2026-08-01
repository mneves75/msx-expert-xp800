import { proceduralKeyForCode, webMsxKeyForCode } from './Keymap.ts'
import { proceduralCharactersForCode } from './ProceduralScreen.ts'

export interface KeymapCheck {
  readonly code: string
  readonly pass: boolean
  readonly detail: string
}

export interface KeymapCheckResult {
  readonly checked: number
  readonly passed: number
  readonly checks: readonly KeymapCheck[]
}

/**
 * Verificação de desenvolvimento chamada por `tools/verify-keymap.mjs`.
 *
 * A lista vem do layout realmente construído pelo módulo do teclado; assim uma
 * tecla nova não pode aparecer no modelo sem quebrar esta verificação.
 */
export function verifyEmulatorKeymaps(modeledCodes: readonly string[]): KeymapCheckResult {
  const checks: KeymapCheck[] = []
  for (const code of modeledCodes) {
    const webmsx = webMsxKeyForCode(code)
    const procedural = proceduralKeyForCode(code)
    checks.push({
      code,
      pass: webmsx !== null && procedural === webmsx,
      detail: `WebMSX=${webmsx ?? 'sem mapa'}; procedural=${procedural ?? 'sem mapa'}`,
    })
  }

  for (const [code, expected] of [
    ['Cedilla', 'DEAD'],
    ['NumpadEqual', 'EQUAL'],
  ] as const) {
    const webmsx = webMsxKeyForCode(code)
    const procedural = proceduralKeyForCode(code)
    checks.push({
      code: `${code} (contrato)`,
      pass: webmsx === expected && procedural === expected,
      detail: `esperado=${expected}; WebMSX=${webmsx ?? 'sem mapa'}; procedural=${procedural ?? 'sem mapa'}`,
    })
  }

  for (const [code, expected] of [
    ['Cedilla', ['Ç', 'ç']],
    ['NumpadEqual', ['=', '=']],
  ] as const) {
    const actual = proceduralCharactersForCode(code)
    checks.push({
      code: `${code} (caractere procedural)`,
      pass:
        actual !== null &&
        actual[0] === expected[0] &&
        actual[1] === expected[1],
      detail: `esperado=${expected.join('/')}; procedural=${actual?.join('/') ?? 'sem mapa'}`,
    })
  }

  return {
    checked: checks.length,
    passed: checks.filter((check) => check.pass).length,
    checks,
  }
}
