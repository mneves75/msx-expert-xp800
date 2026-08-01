/**
 * Gradiente Expert XP-800 — teclado destacado ("PERSONAL KEYBOARD"). SPEC §3.
 *
 * Tudo aqui é reconstruído a partir de `reference/raw/Gradiente_expert_XP-800_correct.jpg`
 * (foto de topo). Para não inventar medidas, a planta é escrita nas *coordenadas de pixel
 * daquela foto* e convertida para metros por {@link mx}/{@link mz}. A foto tem 1915 px de
 * largura útil de teclado para 0,435 m e 755 px de profundidade para 0,175 m — as duas
 * escalas batem em ~0,3 %, o que confirma que o enquadramento é praticamente ortográfico.
 *
 * Decisões estruturais:
 *  - O casco é uma extrusão com *furos*: o painel preto encaixado, o poço do teclado
 *    numérico e a moldura do cursor são buracos reais na peça, preenchidos por lajes
 *    pretas 3 mm abaixo do topo (SPEC §3). O chanfro da extrusão dá a parede do rebaixo.
 *  - O entalhe diagonal do painel preto (a assinatura da peça) é um vértice do polígono
 *    do furo, não um degrau: (663,418) → (792,555) em px de foto.
 *  - As 89 teclas são desenhadas por `InstancedMesh` agrupadas por (geometria × cor).
 *    Cada tecla ganha uma célula própria num atlas de legendas, endereçada por um
 *    atributo de instância `aLegendCell`, e uma malha-proxy invisível para raycast.
 */

import * as THREE from 'three'

import { yieldToMain } from '../core/cooperative'
import { PALETTE } from '../core/Materials'
import type { InteractiveUserData, ModuleContext, SceneModule } from '../core/types'
import { catenary } from '../interaction/Physics'
import {
  createRng,
  dustAccumulation,
  dustAccumulationAsync,
  hashString,
  silkscreenDecalAsync,
  type DecalMaps,
} from '../textures/procedural'

// ---------------------------------------------------------------------------
// Escala foto → cena
// ---------------------------------------------------------------------------

/** Dimensões externas, SPEC §3. */
const BOARD_W = 0.435
const BOARD_H = 0.03
const BOARD_D = 0.175

/** Recorte útil do teclado na foto de referência (2000 × 1500). */
const PHOTO_X0 = 45
const PHOTO_X1 = 1960
const PHOTO_Z0 = 348
const PHOTO_Z1 = 1103

const PX_M = BOARD_W / (PHOTO_X1 - PHOTO_X0)
const PZ_M = BOARD_D / (PHOTO_Z1 - PHOTO_Z0)
const PHOTO_CX = (PHOTO_X0 + PHOTO_X1) / 2
const PHOTO_CZ = (PHOTO_Z0 + PHOTO_Z1) / 2

/** px da foto → X local (metros, 0 = centro da peça). */
const mx = (px: number): number => (px - PHOTO_CX) * PX_M
/** px da foto → Z local (metros, +Z = frente / borda próxima). */
const mz = (px: number): number => (px - PHOTO_CZ) * PZ_M
/** Largura em px → metros. */
const dx = (px: number): number => px * PX_M
/** Profundidade em px → metros. */
const dz = (px: number): number => px * PZ_M

/** Passo de tecla medido na foto: 88,4 px ≈ 20,1 mm. */
const PITCH = 88.4
/** Folga entre teclas vizinhas, em px de foto. */
const GAP = 4.4

// ---------------------------------------------------------------------------
// Convenções verticais
// ---------------------------------------------------------------------------

/**
 * A peça é uma cunha suave: 30 mm atrás, 24 mm à frente (≈2°, SPEC §3 "slight
 * forward wedge"). Todo o conteúdo de topo mora no grupo `deck`, inclinado nesse
 * ângulo, onde y = 0 é a superfície de plástico prateado.
 */
const WEDGE_DROP = 0.006
const DECK_TILT = Math.atan2(WEDGE_DROP, BOARD_D)
const DECK_Y = BOARD_H - WEDGE_DROP / 2

/** Filete das arestas externas do casco (SPEC §3: 1–2 mm, geometria real). */
const SHELL_BEVEL = 0.0018
/**
 * Filete das lajes pretas encaixadas. Chanfro plano (um segmento): é o que dá o
 * fio de contorno mais claro em volta do rasgo cego e do campo de teclas.
 */
const SLAB_BEVEL = 0.0007

/** Rebaixo do painel preto (SPEC §3). */
const PANEL_INSET = 0.003
/** Espessura da laje preta — para de subir bem antes do plano da mesa. */
const PANEL_THICK = 0.017
/**
 * Quanto a base da capa afunda na laje/casco. Sem isto a face inferior da capa
 * fica coplanar com a superfície de assentamento e briga no z-buffer.
 */
const CAP_SINK = 0.0006

/** Altura da capa padrão acima da laje preta. */
const CAP_H = 0.0088
/**
 * Teclas de perfil baixo (F1..F5, STOP..DELETE). As de função moram 3 mm abaixo
 * do prateado: a esta altura o topo delas fica ~1 mm acima do casco, que é o que
 * a foto mostra — a faixa preta é um platô, não um degrau com blocos em cima.
 */
const CAP_H_LOW = 0.0042
/** Cursor: capas quase rasantes dentro da moldura. */
const CAP_H_CURSOR = 0.0056
/**
 * Recuo da face superior em relação à base, por lado. 1,9 mm sobre um passo de
 * 19 mm deixa o topo com ~80 % da pegada — a proporção medida na foto macro, em
 * que as quatro paredes laterais leem como planos distintos e escuros.
 */
const CAP_TAPER = 0.0019
/** Profundidade da calha cilíndrica no topo da capa. */
const CAP_DISH = 0.00092
/** Curso de acionamento. */
const KEY_TRAVEL = 0.0026

/** Moldura preta em volta do cluster de cursor (SPEC §3.1). */
const CURSOR_BEZEL = 0.0038
/** Fundo do poço do cursor, medido a partir da superfície prateada. */
const CURSOR_FLOOR = -0.007
/** Canal preto entre duas capas de cursor vizinhas. */
const CURSOR_GAP = 0.0025

// ---------------------------------------------------------------------------
// Planta
// ---------------------------------------------------------------------------

/** Famílias de cor de capa (SPEC §3.2). */
type Tone = 'main' | 'mod' | 'stop' | 'gra' | 'cursor' | 'worn'

/** Perfil físico da capa — define qual geometria/InstancedMesh a tecla usa. */
type Profile = 'std' | 'fn' | 'cmd' | 'space' | 'enter' | 'cursor'

interface KeyDef {
  /** `KeyboardEvent.code`, consumido direto pela ponte do emulador. */
  readonly code: string
  /** Tooltip pt-BR. */
  readonly label: string
  /** Legenda principal (linha de baixo). Vazio = capa lisa. */
  readonly legend: string
  /** Legenda de shift (linha de cima). */
  readonly legend2?: string
  /** Centro da capa, em px da foto. */
  readonly cx: number
  readonly cz: number
  /** Pegada da capa, em px da foto. */
  readonly w: number
  readonly d: number
  readonly tone: Tone
  readonly profile: Profile
}

/** Linha do bloco principal: y do centro das capas, em px da foto. */
const ROW_Z = [620, 708.75, 797.5, 886.25, 975] as const
/** Borda esquerda do bloco principal, em px da foto. */
const MAIN_L = 70
/** Borda direita do bloco principal (= borda direita da linha 1). */
const MAIN_R = MAIN_L + 15 * PITCH

/** Constrói uma sequência de teclas de 1u a partir de uma borda esquerda. */
function rowRun(
  left: number,
  z: number,
  tone: Tone,
  items: readonly (readonly [code: string, label: string, legend: string, legend2?: string])[],
): { keys: KeyDef[]; right: number } {
  const keys: KeyDef[] = []
  let cursor = left
  for (const item of items) {
    const [code, label, legend, legend2] = item
    keys.push({
      code,
      label,
      legend,
      ...(legend2 === undefined ? {} : { legend2 }),
      cx: cursor + PITCH / 2,
      cz: z,
      w: PITCH - GAP,
      d: PITCH - GAP,
      tone,
      profile: 'std',
    })
    cursor += PITCH
  }
  return { keys, right: cursor }
}

/** Tecla larga (TAB, CONTROL, SHIFT, CAPS…) medida em unidades de passo. */
function wideKey(
  code: string,
  label: string,
  legend: string,
  left: number,
  z: number,
  units: number,
  tone: Tone,
): KeyDef {
  const width = units * PITCH
  return {
    code,
    label,
    legend,
    cx: left + width / 2,
    cz: z,
    w: width - GAP,
    d: PITCH - GAP,
    tone,
    profile: 'std',
  }
}

function buildLayout(): KeyDef[] {
  const keys: KeyDef[] = []
  const z1 = ROW_Z[0]
  const z2 = ROW_Z[1]
  const z3 = ROW_Z[2]
  const z4 = ROW_Z[3]
  const z5 = ROW_Z[4]

  // ── Linha 1 — ESC 1…0 - = \ BS ────────────────────────────────────────────
  keys.push(
    ...rowRun(MAIN_L, z1, 'mod', [['Escape', 'ESC — escape', 'ESC']]).keys,
    ...rowRun(MAIN_L + PITCH, z1, 'main', [
      ['Digit1', '1 / !', '1', '!'],
      ['Digit2', '2 / @', '2', '@'],
      ['Digit3', '3 / #', '3', '#'],
      ['Digit4', '4 / $', '4', '$'],
      ['Digit5', '5 / %', '5', '%'],
      ['Digit6', '6 / ^', '6', '^'],
      ['Digit7', '7 / &', '7', '&'],
      ['Digit8', '8 / *', '8', '*'],
      ['Digit9', '9 / (', '9', '('],
      ['Digit0', '0 / )', '0', ')'],
      ['Minus', 'hífen / sublinhado', '-', '_'],
      ['Equal', 'igual / mais', '=', '+'],
      ['Backslash', 'barra invertida / pipe', '\\', '|'],
    ]).keys,
  )
  keys.push(
    wideKey('Backspace', 'BS — apagar à esquerda', 'BS', MAIN_L + 14 * PITCH, z1, 1, 'mod'),
  )

  // ── Linha 2 — TAB Q…] + parte alta do Enter ───────────────────────────────
  keys.push(wideKey('Tab', 'TAB — tabulação', 'TAB', MAIN_L, z2, 1.25, 'mod'))
  keys.push(
    ...rowRun(MAIN_L + 1.25 * PITCH, z2, 'main', [
      ['KeyQ', 'Q', 'Q'],
      ['KeyW', 'W', 'W'],
      ['KeyE', 'E', 'E'],
      ['KeyR', 'R', 'R'],
      ['KeyT', 'T', 'T'],
      ['KeyY', 'Y', 'Y'],
      ['KeyU', 'U', 'U'],
      ['KeyI', 'I', 'I'],
      ['KeyO', 'O', 'O'],
      ['KeyP', 'P', 'P'],
      ['BracketLeft', 'colchete esquerdo', '[', '{'],
      ['BracketRight', 'colchete direito', ']', '}'],
    ]).keys,
  )

  // ── Linha 3 — CONTROL A…' ─────────────────────────────────────────────────
  keys.push(wideKey('ControlLeft', 'CONTROL', 'CONTROL', MAIN_L, z3, 1.5, 'mod'))
  keys.push(
    ...rowRun(MAIN_L + 1.5 * PITCH, z3, 'main', [
      ['KeyA', 'A', 'A'],
      ['KeyS', 'S', 'S'],
      ['KeyD', 'D', 'D'],
      ['KeyF', 'F', 'F'],
      ['KeyG', 'G', 'G'],
      ['KeyH', 'H', 'H'],
      ['KeyJ', 'J', 'J'],
      ['KeyK', 'K', 'K'],
      ['KeyL', 'L', 'L'],
      // Identidade semântica própria: a ponte traduz `Cedilla` para a posição
      // VK_BR_CEDILLA do layout brasileiro do WebMSX.
      ['Cedilla', 'Ç — cedilha', 'Ç'],
      ['Semicolon', 'ponto e vírgula / dois-pontos', ';', ':'],
      ['Quote', 'apóstrofo / aspas', "'", '"'],
    ]).keys,
  )

  // ── Linha 4 — SHIFT Z…~ SHIFT ─────────────────────────────────────────────
  const row4L = MAIN_L + 0.5 * PITCH
  keys.push(wideKey('ShiftLeft', 'SHIFT esquerdo', 'SHIFT', row4L, z4, 1.5, 'mod'))
  const row4 = rowRun(row4L + 1.5 * PITCH, z4, 'main', [
    ['KeyZ', 'Z', 'Z'],
    ['KeyX', 'X', 'X'],
    ['KeyC', 'C', 'C'],
    ['KeyV', 'V', 'V'],
    ['KeyB', 'B', 'B'],
    ['KeyN', 'N', 'N'],
    ['KeyM', 'M', 'M'],
    ['Comma', 'vírgula / menor que', ',', '<'],
    ['Period', 'ponto / maior que', '.', '>'],
    ['Slash', 'barra / interrogação', '/', '?'],
    // Tecla de acentos brasileira: ~ ´ em cima, ` ^ embaixo.
    ['Backquote', 'acentos — til, agudo, grave, circunflexo', '` ^', '~ ´'],
  ])
  keys.push(...row4.keys)
  keys.push(wideKey('ShiftRight', 'SHIFT direito', 'SHIFT', row4.right, z4, 1.5, 'mod'))

  // ── Linha 5 — CAPS, L GRA, barra de espaço, R GRA ─────────────────────────
  const capsL = MAIN_L + 1.25 * PITCH
  keys.push(wideKey('CapsLock', 'CAPS LOCK — trava de maiúsculas', 'CAPS\nLOCK', capsL, z5, 1, 'mod'))
  keys.push(wideKey('AltLeft', 'L GRA — gráficos à esquerda', 'L\nGRA', capsL + PITCH, z5, 1, 'gra'))
  const spaceL = capsL + 2 * PITCH
  const spaceW = 810
  keys.push({
    code: 'Space',
    label: 'Barra de espaço',
    legend: '',
    cx: spaceL + spaceW / 2,
    cz: z5,
    w: spaceW - GAP,
    d: PITCH - GAP,
    tone: 'worn',
    profile: 'space',
  })
  keys.push(wideKey('AltRight', 'R GRA — gráficos à direita', 'R\nGRA', spaceL + spaceW + 8, z5, 1, 'gra'))

  // ── Enter — alto, em L, cobrindo as linhas 2 e 3 ───────────────────────────
  keys.push({
    code: 'Enter',
    label: 'Enter',
    legend: '',
    cx: MAIN_R - 0.775 * PITCH,
    cz: (z2 + z3) / 2,
    w: 1.55 * PITCH - GAP,
    d: 2 * PITCH - GAP,
    tone: 'worn',
    profile: 'enter',
  })

  // ── Faixa superior — F1/F6…F5/F10 e STOP…DELETE ───────────────────────────
  const fnZ = 470
  const fnW = 100
  for (let i = 0; i < 5; i++) {
    keys.push({
      code: `F${i + 1}`,
      label: `F${i + 1} / F${i + 6}`,
      legend: `F${i + 1}/F${i + 6}`,
      cx: 138 + i * 108,
      cz: fnZ,
      w: fnW,
      d: 48,
      tone: 'mod',
      profile: 'fn',
    })
  }

  const cmd: readonly (readonly [string, string, string, number, Tone])[] = [
    ['Pause', 'STOP — interrompe o programa', 'STOP', 867, 'stop'],
    ['Home', 'HOME / CLS — cursor ao início, limpa a tela', "HOME 'CLS", 984, 'mod'],
    ['End', 'SELECT', 'SELECT', 1102, 'mod'],
    ['Insert', 'INSERT — inserir', 'INSERT', 1216, 'mod'],
    ['Delete', 'DELETE — apagar', 'DELETE', 1332, 'mod'],
  ]
  for (const [code, label, legend, cx, tone] of cmd) {
    keys.push({ code, label, legend, cx, cz: fnZ, w: 108, d: 48, tone, profile: 'cmd' })
  }

  // ── Teclado numérico — 4 × 4 ──────────────────────────────────────────────
  const padX = [1563, 1651.4, 1739.8, 1828.2] as const
  const padZ = [543, 631.4, 719.8, 808.2] as const
  const pad: readonly (readonly [string, string, string, Tone])[][] = [
    [
      ['Numpad7', '7 (numérico)', '7', 'main'],
      ['Numpad8', '8 (numérico)', '8', 'main'],
      ['Numpad9', '9 (numérico)', '9', 'main'],
      ['NumpadDivide', 'divisão', '/', 'mod'],
    ],
    [
      ['Numpad4', '4 (numérico)', '4', 'main'],
      ['Numpad5', '5 (numérico)', '5', 'main'],
      ['Numpad6', '6 (numérico)', '6', 'main'],
      ['NumpadMultiply', 'multiplicação', '*', 'mod'],
    ],
    [
      ['Numpad1', '1 (numérico)', '1', 'main'],
      ['Numpad2', '2 (numérico)', '2', 'main'],
      ['Numpad3', '3 (numérico)', '3', 'main'],
      ['NumpadSubtract', 'subtração', '-', 'mod'],
    ],
    [
      ['Numpad0', '0 (numérico)', '0', 'main'],
      ['NumpadDecimal', 'ponto decimal', '.', 'main'],
      ['NumpadEqual', 'igual (numérico)', '=', 'main'],
      ['NumpadAdd', 'adição', '+', 'mod'],
    ],
  ]
  for (let r = 0; r < pad.length; r++) {
    const row = pad[r]
    const cz = padZ[r]
    if (row === undefined || cz === undefined) continue
    for (let c = 0; c < row.length; c++) {
      const cell = row[c]
      const cx = padX[c]
      if (cell === undefined || cx === undefined) continue
      const [code, label, legend, tone] = cell
      keys.push({ code, label, legend, cx, cz, w: PITCH - GAP, d: PITCH - GAP, tone, profile: 'std' })
    }
  }

  // ── Cursor — quatro capas azuis em diamante ───────────────────────────────
  for (const [code, label] of [
    ['ArrowUp', 'Cursor para cima'],
    ['ArrowDown', 'Cursor para baixo'],
    ['ArrowLeft', 'Cursor para a esquerda'],
    ['ArrowRight', 'Cursor para a direita'],
  ] as const) {
    keys.push({
      code,
      label,
      legend: '',
      cx: 0,
      cz: 0,
      w: 0,
      d: 0,
      tone: 'cursor',
      profile: 'cursor',
    })
  }

  return keys
}

/** Códigos de todas as teclas realmente modeladas, para a checagem cruzada do emulador. */
export function modeledKeyboardKeyCodes(): readonly string[] {
  return buildLayout().map((key) => key.code)
}

// ---------------------------------------------------------------------------
// Contornos das áreas rebaixadas (px da foto)
// ---------------------------------------------------------------------------

/**
 * Painel preto do bloco principal. O terceiro e o quarto vértices formam o
 * **entalhe diagonal** entre o grupo de teclas de função e o grupo STOP — o
 * detalhe de assinatura do XP-800 (SPEC §3).
 */
const PANEL_OUTLINE: readonly (readonly [number, number])[] = [
  [64, 418],
  [663, 418],
  [792, 555],
  [1420, 555],
  [1420, 1044],
  [64, 1044],
]

/** Poço preto do teclado numérico. */
const PAD_WELL: readonly [number, number, number, number] = [1508, 490, 1880, 862]
/** Moldura preta do cluster de cursor. */
const CURSOR_WELL: readonly [number, number, number, number] = [1508, 878, 1878, 1039]
/** Rasgo raso e cego abaixo das teclas de função. */
const BLANK_SLOT: readonly [number, number, number, number] = [95, 505, 645, 549]
/** Retângulo gravado do indicador "IN USE". */
const INUSE_SLOT: readonly [number, number, number, number] = [812, 505, 1392, 549]
/** Barra escura rebaixada acima do teclado numérico. */
const STRIP_SLOT: readonly [number, number, number, number] = [1500, 380, 1772, 406]
/** Painel vermelho rebaixado do emblema MSX. */
const MSX_SLOT: readonly [number, number, number, number] = [1786, 372, 1858, 412]
/** Sulco fino que separa o bloco principal do numérico. */
const SEAM_X = 1440

// ---------------------------------------------------------------------------
// Utilidades de forma
// ---------------------------------------------------------------------------

/**
 * Ponto de shape a partir de px da foto. As extrusões são feitas no plano XY do
 * `Shape` e depois giradas −90° em X, o que manda +Y da shape para −Z do mundo;
 * por isso o Z entra negado aqui.
 */
function sp(pxX: number, pxZ: number): THREE.Vector2 {
  return new THREE.Vector2(mx(pxX), -mz(pxZ))
}

/** Polígono com cantos arredondados, em coordenadas de shape. */
function roundedShape(points: readonly THREE.Vector2[], radius: number): THREE.Shape {
  const shape = new THREE.Shape()
  const n = points.length
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]
    const cur = points[i]
    const next = points[(i + 1) % n]
    if (prev === undefined || cur === undefined || next === undefined) continue

    const toPrev = new THREE.Vector2().subVectors(prev, cur)
    const toNext = new THREE.Vector2().subVectors(next, cur)
    const r = Math.min(radius, toPrev.length() * 0.45, toNext.length() * 0.45)
    const a = new THREE.Vector2().copy(cur).addScaledVector(toPrev.normalize(), r)
    const b = new THREE.Vector2().copy(cur).addScaledVector(toNext.normalize(), r)

    if (i === 0) shape.moveTo(a.x, a.y)
    else shape.lineTo(a.x, a.y)
    shape.quadraticCurveTo(cur.x, cur.y, b.x, b.y)
  }
  shape.closePath()
  return shape
}

/** Retângulo arredondado a partir de px da foto (x0,z0 = canto de trás/esquerda). */
function rectShape(rect: readonly [number, number, number, number], radius: number): THREE.Shape {
  const [x0, z0, x1, z1] = rect
  return roundedShape([sp(x0, z0), sp(x1, z0), sp(x1, z1), sp(x0, z1)], radius)
}

interface ExtrudeSpec {
  readonly depth: number
  readonly bevel: number
  readonly bevelSegments?: number
  readonly curveSegments?: number
}

/**
 * Extrusão vertical: a shape vira uma laje **exatamente** entre y = 0 e
 * y = `depth`, com o eixo Y da shape mapeado para +Z do mundo.
 *
 * `ExtrudeGeometry` adiciona `bevelThickness` para *fora* das duas pontas — a
 * peça nasce com `depth + 2·bevel` de altura, começando em −bevel. Descontamos
 * isso aqui; sem essa correção o casco fica alto demais e afunda na mesa,
 * enterrando tudo o que é posicionado em relação ao topo.
 */
function extrudeUp(shape: THREE.Shape, spec: ExtrudeSpec): THREE.BufferGeometry {
  const bevel = Math.min(spec.bevel, spec.depth * 0.4)
  const core = Math.max(1e-5, spec.depth - 2 * bevel)
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: core,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: spec.bevelSegments ?? 3,
    curveSegments: spec.curveSegments ?? 4,
    steps: 1,
  })
  geometry.rotateX(-Math.PI / 2)
  if (bevel > 0) geometry.translate(0, bevel, 0)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * Cunha frontal (SPEC §3): escala Y proporcionalmente à profundidade, mantendo a
 * base plana sobre a mesa. O topo passa a ser um plano inclinado ≈2°.
 */
function applyWedge(geometry: THREE.BufferGeometry): void {
  const pos = geometry.getAttribute('position')
  if (!(pos instanceof THREE.BufferAttribute)) return
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i)
    const t = (z + BOARD_D / 2) / BOARD_D
    pos.setY(i, pos.getY(i) * (1 - (WEDGE_DROP / BOARD_H) * t))
  }
  pos.needsUpdate = true
  geometry.computeVertexNormals()
}

// ---------------------------------------------------------------------------
// Geometria das capas
// ---------------------------------------------------------------------------

/** Contorno de tecla arredondado, no plano XZ e centrado na origem. */
function roundedCapOutline(w: number, d: number, radius: number, segments = 4): THREE.Vector2[] {
  const a = w / 2
  const b = d / 2
  const r = Math.min(radius, a * 0.9, b * 0.9)
  const out: THREE.Vector2[] = []
  const corners: readonly (readonly [number, number])[] = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ]
  for (const corner of corners) {
    const sx = corner[0]
    const sz = corner[1]
    // Ângulo inicial de cada quadrante, percorrido no sentido anti-horário em XZ.
    const base = Math.atan2(sz, sx)
    for (let s = 0; s <= segments; s++) {
      const angle = base - Math.PI / 4 + (s / segments) * (Math.PI / 2)
      const cx = sx * (a - r)
      const cz = sz * (b - r)
      out.push(new THREE.Vector2(cx + Math.cos(angle) * r, cz + Math.sin(angle) * r))
    }
  }
  return out
}

/**
 * Deslocamento em mitra de um polígono fechado (sentido anti-horário em XZ).
 * Usado para gerar os anéis da saia da capa a partir do contorno do topo.
 */
function offsetPolygon(points: readonly THREE.Vector2[], amount: number): THREE.Vector2[] {
  const n = points.length
  const normals: THREE.Vector2[] = []
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    if (a === undefined || b === undefined) {
      normals.push(new THREE.Vector2(0, 0))
      continue
    }
    // Em XZ com percurso anti-horário, a normal externa é (dz, −dx).
    normals.push(new THREE.Vector2(b.y - a.y, -(b.x - a.x)).normalize())
  }
  const out: THREE.Vector2[] = []
  for (let i = 0; i < n; i++) {
    const p = points[i]
    const nPrev = normals[(i - 1 + n) % n]
    const nCur = normals[i]
    if (p === undefined || nPrev === undefined || nCur === undefined) continue
    const bisector = new THREE.Vector2().addVectors(nPrev, nCur)
    if (bisector.lengthSq() < 1e-12) {
      out.push(p.clone())
      continue
    }
    bisector.normalize()
    // Limite de mitra: cantos muito agudos não podem explodir para fora.
    const scale = amount / Math.max(0.4, bisector.dot(nCur))
    out.push(new THREE.Vector2(p.x + bisector.x * scale, p.y + bisector.y * scale))
  }
  return out
}

interface CapSpec {
  /** Contorno do topo, XZ, centrado na origem. */
  readonly outline: readonly THREE.Vector2[]
  readonly height: number
  /** Alargamento da base em relação ao topo, por lado. */
  readonly taper: number
  /** Concavidade da calha no eixo X (cilíndrica). */
  readonly dishX: number
  /** Concavidade residual no eixo Z. */
  readonly dishZ: number
  /** Anéis radiais na face superior. */
  readonly rings?: number
}

/**
 * Capa esculpida com calha cilíndrica. Malha radial: a fronteira do topo é
 * exatamente o `outline`, o que deixa os anéis da saia costurarem sem fenda.
 *
 * Atributos: `position`, `normal`, `uv` (grão do ABS) e `legendUv` — este último
 * vale 0..1 só na face superior e −1 no resto, sentinela que o shader usa para
 * decidir onde a tampografia é impressa.
 */
function capGeometry(spec: CapSpec): THREE.BufferGeometry {
  const outline = spec.outline
  const m = outline.length
  const rings = spec.rings ?? 4

  // Centro e semi-extensões vêm da *caixa envolvente*, não da origem: as capas
  // do cursor são polígonos fora do centro (o zero fica no meio da moldura) e um
  // leque radial a partir da origem cobriria a moldura inteira.
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const p of outline) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.y)
    maxZ = Math.max(maxZ, p.y)
  }
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const ax = Math.max((maxX - minX) / 2, 1e-5)
  const bz = Math.max((maxZ - minZ) / 2, 1e-5)

  const positions: number[] = []
  const uvs: number[] = []
  const legend: number[] = []
  const rise: number[] = []
  const indices: number[] = []

  const dishAt = (x: number, z: number): number =>
    spec.height -
    spec.dishX * (1 - ((x - cx) / ax) ** 2) -
    spec.dishZ * (1 - ((z - cz) / bz) ** 2)

  const push = (x: number, y: number, z: number, onTop: boolean): number => {
    const index = positions.length / 3
    const u = (x - cx) / (2 * ax) + 0.5
    const v = (z - cz) / (2 * bz) + 0.5
    positions.push(x, y, z)
    uvs.push(u, v)
    if (onTop) legend.push(u, 1 - v)
    else legend.push(-1, -1)
    // 0 na base, 1 no topo: o shader usa isto para depositar sujeira na saia.
    rise.push(Math.max(0, Math.min(1, y / Math.max(1e-6, spec.height))))
    return index
  }

  // ── Face superior: leque radial do centro até o contorno ──────────────────
  const centre = push(cx, dishAt(cx, cz), cz, true)
  const ringStart: number[] = []
  for (let r = 1; r <= rings; r++) {
    const t = r / rings
    ringStart.push(positions.length / 3)
    for (let i = 0; i < m; i++) {
      const p = outline[i]
      if (p === undefined) continue
      const x = cx + (p.x - cx) * t
      const z = cz + (p.y - cz) * t
      push(x, dishAt(x, z), z, true)
    }
  }

  // Enrolamento anti-horário visto de +Y: normais para cima após computeVertexNormals.
  const first = ringStart[0] ?? 0
  for (let i = 0; i < m; i++) {
    indices.push(centre, first + ((i + 1) % m), first + i)
  }
  for (let r = 0; r < rings - 1; r++) {
    const inner = ringStart[r] ?? 0
    const outer = ringStart[r + 1] ?? 0
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m
      indices.push(inner + i, inner + j, outer + j)
      indices.push(inner + i, outer + j, outer + i)
    }
  }

  // ── Saia: dois raios diferentes, como uma capa injetada de verdade ────────
  // Filete de 0,4 mm no perímetro do topo, parede reta (é ela que dá os quatro
  // planos escuros da foto macro) e filete de 0,8 mm na base. Um único chanfro
  // uniforme — o que havia aqui antes — lê como caixa extrudada.
  const baseFillet = Math.min(0.0008, spec.taper * 0.42)
  const skirt: readonly (readonly [offset: number, y: number])[] = [
    [0, spec.height],
    [0.00012, spec.height - 0.00014],
    [0.0004, spec.height - 0.0005],
    [spec.taper - baseFillet, baseFillet * 0.85],
    [spec.taper - baseFillet * 0.3, baseFillet * 0.28],
    [spec.taper, 0],
  ]
  const skirtStart: number[] = []
  for (const step of skirt) {
    const ring = step[0] === 0 ? outline : offsetPolygon(outline, step[0])
    skirtStart.push(positions.length / 3)
    for (let i = 0; i < m; i++) {
      const p = ring[i]
      if (p === undefined) continue
      const y = step[0] === 0 ? dishAt(p.x, p.y) : step[1]
      push(p.x, y, p.y, false)
    }
  }
  for (let r = 0; r < skirtStart.length - 1; r++) {
    const upper = skirtStart[r] ?? 0
    const lower = skirtStart[r + 1] ?? 0
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m
      indices.push(upper + i, upper + j, lower + j)
      indices.push(upper + i, lower + j, lower + i)
    }
  }

  // ── Fundo fechado: evita vazamento de luz no shadow map ───────────────────
  const base = skirtStart[skirtStart.length - 1] ?? 0
  for (let i = 1; i < m - 1; i++) indices.push(base, base + i + 1, base + i)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('legendUv', new THREE.Float32BufferAttribute(legend, 2))
  geometry.setAttribute('capRise', new THREE.Float32BufferAttribute(rise, 1))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()

  // Normais analíticas na face superior. A malha radial deixaria uma diagonal
  // facetada visível em cada capa — o tipo de artefato que denuncia render.
  const topCount = 1 + rings * m
  const normal = geometry.getAttribute('normal')
  const point = geometry.getAttribute('position')
  for (let i = 0; i < topCount; i++) {
    const dydx = (2 * spec.dishX * (point.getX(i) - cx)) / (ax * ax)
    const dydz = (2 * spec.dishZ * (point.getZ(i) - cz)) / (bz * bz)
    const inv = 1 / Math.hypot(dydx, 1, dydz)
    normal.setXYZ(i, -dydx * inv, inv, -dydz * inv)
  }
  normal.needsUpdate = true
  return geometry
}

/** Contorno em L do Enter: ombro largo na linha de cima, haste estreita embaixo. */
function enterOutline(w: number, d: number): THREE.Vector2[] {
  const a = w / 2
  const b = d / 2
  // A haste inferior ocupa 71 % da largura, alinhada à direita (medido na foto).
  const notchX = a - w * 0.71
  const notchZ = -b + d * 0.47
  const r = 0.0011
  return roundedShapePoints(
    [
      new THREE.Vector2(a, -b),
      new THREE.Vector2(a, b),
      new THREE.Vector2(notchX, b),
      new THREE.Vector2(notchX, notchZ),
      new THREE.Vector2(-a, notchZ),
      new THREE.Vector2(-a, -b),
    ],
    r,
    3,
  )
}

/** Amostra um polígono com cantos arredondados como lista de pontos. */
function roundedShapePoints(
  points: readonly THREE.Vector2[],
  radius: number,
  segments: number,
): THREE.Vector2[] {
  const out: THREE.Vector2[] = []
  const n = points.length
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]
    const cur = points[i]
    const next = points[(i + 1) % n]
    if (prev === undefined || cur === undefined || next === undefined) continue
    const toPrev = new THREE.Vector2().subVectors(prev, cur)
    const toNext = new THREE.Vector2().subVectors(next, cur)
    const r = Math.min(radius, toPrev.length() * 0.45, toNext.length() * 0.45)
    const a = new THREE.Vector2().copy(cur).addScaledVector(toPrev.normalize(), r)
    const b = new THREE.Vector2().copy(cur).addScaledVector(toNext.normalize(), r)
    for (let s = 0; s <= segments; s++) {
      const t = s / segments
      const it = 1 - t
      out.push(
        new THREE.Vector2(
          it * it * a.x + 2 * it * t * cur.x + t * t * b.x,
          it * it * a.y + 2 * it * t * cur.y + t * t * b.y,
        ),
      )
    }
  }
  return out
}

/**
 * As quatro capas do cursor, em **metros**, centradas na moldura. Medidas em
 * `reference/raw/…keyboard_correct.jpg`: esquerda e direita são pentágonos com
 * um vértice apontando para o centro na meia-altura; cima e baixo são trapézios
 * que estreitam em direção ao miolo. Juntas formam o galão da SPEC §3.1.
 *
 * O contorno devolvido já é a *célula* — a capa real é esta célula recuada de
 * meio canal, o que abre os corredores pretos de 2,5 mm que a foto mostra. Fora
 * das quatro células sobra a moldura preta de {@link CURSOR_BEZEL}.
 */
function cursorCell(shape: 'up' | 'left', wellW: number, wellD: number): THREE.Vector2[] {
  const w = wellW - 2 * CURSOR_BEZEL
  const d = wellD - 2 * CURSOR_BEZEL
  const a = w / 2
  const b = d / 2
  // Fração da largura ocupada pelas capas laterais, na borda e na ponta central.
  const edge = 0.26 * w
  const tip = 0.34 * w
  const cell: readonly THREE.Vector2[] =
    shape === 'left'
      ? [
          new THREE.Vector2(-a, -b),
          new THREE.Vector2(-a + edge, -b),
          new THREE.Vector2(-a + tip, 0),
          new THREE.Vector2(-a + edge, b),
          new THREE.Vector2(-a, b),
        ]
      : [
          new THREE.Vector2(-a + edge, -b),
          new THREE.Vector2(a - edge, -b),
          new THREE.Vector2(a - tip, 0),
          new THREE.Vector2(-a + tip, 0),
        ]
  return offsetPolygon(cell, -CURSOR_GAP / 2)
}

// ---------------------------------------------------------------------------
// Atlas de legendas (tampografia) + serigrafia dos emblemas
// ---------------------------------------------------------------------------

const ATLAS_W = 2048
const ATLAS_H = 1024
/** px de atlas por metro de superfície impressa. */
const ATLAS_PPM = 6200
const LEGEND_FONT = '"Arial Narrow", "Helvetica Neue", Helvetica, Arial, sans-serif'
/**
 * Tinta da tampografia. Branco-quente sujo, nunca `#FFFFFF`: a legenda de 1985
 * é um branco-osso que amarelou junto com a capa.
 */
const INK = '#D8D6C6'

interface AtlasItem {
  readonly id: string
  readonly w: number
  readonly h: number
  readonly draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void
}

interface AtlasRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Célula do atlas em espaço UV, pronta para virar atributo de instância. */
type AtlasCell = readonly [u0: number, v0: number, du: number, dv: number]

/** Margem entre células: impede sangramento de uma legenda na vizinha nos mipmaps. */
const ATLAS_PAD = 3

/** Empacotador de prateleiras. Itens mais altos primeiro reduzem o desperdício. */
function packAtlas(items: readonly AtlasItem[]): Map<string, AtlasRect> {
  const order = [...items].sort((a, b) => b.h - a.h)
  const placed = new Map<string, AtlasRect>()
  let cursorX = ATLAS_PAD
  let cursorY = ATLAS_PAD
  let rowH = 0
  for (const item of order) {
    if (cursorX + item.w + ATLAS_PAD > ATLAS_W) {
      cursorX = ATLAS_PAD
      cursorY += rowH + ATLAS_PAD
      rowH = 0
    }
    if (cursorY + item.h + ATLAS_PAD > ATLAS_H) {
      console.warn(`[Keyboard] atlas de legendas estourou em "${item.id}" — legenda omitida.`)
      continue
    }
    placed.set(item.id, { x: cursorX, y: cursorY, w: item.w, h: item.h })
    cursorX += item.w + ATLAS_PAD
    rowH = Math.max(rowH, item.h)
  }
  return placed
}

function rectToCell(rect: AtlasRect): AtlasCell {
  return [rect.x / ATLAS_W, 1 - (rect.y + rect.h) / ATLAS_H, rect.w / ATLAS_W, rect.h / ATLAS_H]
}

/** Ajusta o corpo da fonte para caber em `maxWidth`. Devolve o tamanho usado. */
function fitFont(ctx: CanvasRenderingContext2D, text: string, size: number, maxWidth: number): number {
  let px = size
  ctx.font = `${px.toFixed(1)}px ${LEGEND_FONT}`
  let width = ctx.measureText(text).width
  while (width > maxWidth && px > 3) {
    px *= maxWidth / width
    ctx.font = `${px.toFixed(1)}px ${LEGEND_FONT}`
    width = ctx.measureText(text).width
  }
  return px
}

function drawCentred(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  size: number,
  maxWidth: number,
): void {
  const lines = text.split('\n')
  const lineH = size * 1.1
  const top = cy - ((lines.length - 1) * lineH) / 2
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const px = fitFont(ctx, line, size, maxWidth)
    ctx.fillText(line, cx - ctx.measureText(line).width / 2, top + i * lineH + px * 0.35)
  }
}

/** Uma legenda de tecla, com o desregistro típico da tampografia. */
function drawKeyLegend(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  primary: string,
  secondary: string | undefined,
  seed: number,
): void {
  const rng = createRng(seed)
  ctx.save()
  ctx.translate(w / 2 + (rng() - 0.5) * w * 0.02, h / 2 + (rng() - 0.5) * h * 0.02)
  ctx.rotate((rng() - 0.5) * 0.016)
  ctx.translate(-w / 2, -h / 2)
  // Sangria do tampo: a tinta se espalha um fio ao encostar no plástico, o que
  // mata a aresta vetorial que denuncia render num crop 1:1.
  ctx.filter = `blur(${(0.35 + rng() * 0.25).toFixed(2)}px)`

  const wide = w / h > 1.7
  if (secondary === undefined) {
    const lines = primary.split('\n').length
    const size = wide ? h * 0.56 : h * (lines > 1 ? 0.33 : 0.46)
    ctx.globalAlpha = 0.88 + rng() * 0.12
    drawCentred(ctx, primary, w * 0.5, h * 0.5, size, w * (wide ? 0.84 : 0.8))
  } else {
    // Foto: símbolo de shift em cima e ao centro, base embaixo e à esquerda. O
    // símbolo de shift sempre imprime mais fino que o dígito — na referência o
    // "%" e o "&" saem visivelmente mais fracos que os números.
    ctx.globalAlpha = 0.7 + rng() * 0.16
    drawCentred(ctx, secondary, w * 0.53, h * 0.31, h * 0.33, w * 0.62)
    ctx.globalAlpha = 0.9 + rng() * 0.1
    drawCentred(ctx, primary, w * 0.36, h * 0.74, h * 0.35, w * 0.56)
  }
  ctx.restore()
}

/** Seta em L do Enter, desenhada como silhueta vazada (igual à foto). */
function drawEnterArrow(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  // Seta grande e vazada, ocupando quase toda a haste do L, como na foto: sobe
  // pela direita, dobra e aponta para a esquerda. Coordenadas presas à haste
  // estreita (x ≥ 0,30) e à metade de baixo da capa (y ≥ 0,25).
  const path: readonly (readonly [number, number])[] = [
    [0.68, 0.25],
    [0.84, 0.25],
    [0.84, 0.78],
    [0.46, 0.78],
    [0.46, 0.93],
    [0.24, 0.665],
    [0.46, 0.4],
    [0.46, 0.55],
    [0.68, 0.55],
  ]
  ctx.save()
  ctx.filter = 'blur(0.4px)'
  ctx.beginPath()
  path.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x * w, y * h)
    else ctx.lineTo(x * w, y * h)
  })
  ctx.closePath()
  ctx.lineWidth = Math.max(1.2, h * 0.022)
  ctx.lineJoin = 'miter'
  ctx.stroke()
  ctx.restore()
}

/** `⊚gradiente` — anéis concêntricos seguidos do logotipo em minúsculas pesadas. */
function drawGradiente(ctx: CanvasRenderingContext2D, x: number, cy: number, size: number): number {
  const r = size * 0.46
  ctx.save()
  ctx.lineWidth = size * 0.075
  for (let i = 0; i < 3; i++) {
    ctx.beginPath()
    ctx.arc(x + r, cy, r - i * size * 0.14, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.arc(x + r, cy, size * 0.07, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  const textX = x + r * 2 + size * 0.1
  ctx.font = `700 ${size.toFixed(1)}px ${LEGEND_FONT}`
  ctx.fillText('gradiente', textX, cy + size * 0.36)
  return textX + ctx.measureText('gradiente').width
}

/**
 * `EXPERT` — "E" em caixa cheia, resto em grotesca fina e espaçada.
 *
 * Na foto o emblema é **escuro sobre o prateado** (marca quente, não serigrafia
 * branca), com terminais levemente redondos e um fio de desregistro.
 */
function drawExpert(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const size = h * 0.72
  const boxW = size * 0.78
  ctx.save()
  ctx.fillStyle = '#2A2A28'
  ctx.strokeStyle = '#2A2A28'
  ctx.filter = 'blur(0.6px)'
  ctx.fillRect(0, h * 0.5 - size * 0.6, boxW, size * 1.16)
  // O "E" é recortado do quadrado cheio.
  ctx.globalCompositeOperation = 'destination-out'
  const bar = size * 0.17
  ctx.fillRect(boxW * 0.28, h * 0.5 - size * 0.32, boxW * 0.62, bar * 0.75)
  ctx.fillRect(boxW * 0.28, h * 0.5 - bar * 0.35, boxW * 0.5, bar * 0.75)
  ctx.fillRect(boxW * 0.28, h * 0.5 + size * 0.24, boxW * 0.62, bar * 0.75)
  ctx.restore()
  ctx.save()
  ctx.fillStyle = '#2A2A28'
  ctx.filter = 'blur(0.6px)'
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(size * 0.1).toFixed(1)}px`
  const left = boxW + size * 0.12
  fitFont(ctx, 'XPERT', size, Math.max(1, w - left))
  ctx.fillText('XPERT', left, h * 0.5 + size * 0.38)
  ctx.restore()
}

/**
 * `MSX` — só a tipografia. O fundo vermelho é o painel rebaixado de
 * {@link MSX_SLOT}, geometria de verdade, com sombra na borda.
 */
function drawMsx(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.save()
  ctx.fillStyle = '#EDE9E0'
  ctx.filter = 'blur(0.5px)'
  ctx.font = `700 ${(h * 0.6).toFixed(1)}px ${LEGEND_FONT}`
  const label = 'MSX'
  const size = fitFont(ctx, label, h * 0.6, w * 0.78)
  ctx.fillText(label, (w - ctx.measureText(label).width) / 2, h * 0.5 + size * 0.35)
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Material instanciado com legenda
// ---------------------------------------------------------------------------

const LEGEND_VERT_HEAD = /* glsl */ `
attribute vec2 legendUv;
attribute vec4 aLegendCell;
attribute float capRise;
attribute vec3 aCapVar;
varying vec2 vLegendUv;
varying vec4 vLegendCell;
varying float vCapRise;
varying vec3 vCapVar;
`

const LEGEND_FRAG_HEAD = /* glsl */ `
uniform sampler2D uLegendMap;
varying vec2 vLegendUv;
varying vec4 vLegendCell;
varying float vCapRise;
varying vec3 vCapVar;
vec4 msxInk = vec4(0.0);
float msxGrime = 0.0;
float msxPolish = 0.0;
`

/**
 * Sujeira de fresta + tampografia. A sujeira vem primeiro: numa capa de 41 anos
 * a base da saia é sempre mais escura e mais fosca que o topo, porque é ali que
 * poeira e óleo se acumulam e nenhuma flanela alcança. Sem isso as 89 capas leem
 * como plástico recém-moldado (SPEC §4).
 */
const LEGEND_FRAG_COLOR = /* glsl */ `
// Banda até 0.68 da subida: além da sujeira da base, aproxima a oclusão entre
// capas vizinhas (paredes a 2–4 mm uma da outra quase não recebem luz do softbox)
// que nem shadow map nem SSAO resolvem nesta escala. Sem isso as paredes lavam
// claras em ângulo rasante e as capas parecem flutuar (shots/probe/prod-rest.png).
msxGrime = 1.0 - smoothstep(0.0, 0.68, vCapRise);
diffuseColor.rgb *= mix(1.0, 0.52, msxGrime);
// Polimento de dedo: uma mancha macia na zona de impacto, não uma troca de
// material na capa inteira. A gordura fecha o poro, então o albedo sobe um fio.
if (vCapVar.z > 0.0 && vLegendUv.x >= 0.0) {
  msxPolish = vCapVar.z * (1.0 - smoothstep(0.16, 0.72, distance(vLegendUv, vec2(0.5, 0.56))));
  diffuseColor.rgb *= 1.0 + 0.035 * msxPolish;
}
if (vLegendCell.z > 0.0 &&
    vLegendUv.x >= 0.0 && vLegendUv.x <= 1.0 &&
    vLegendUv.y >= 0.0 && vLegendUv.y <= 1.0) {
  msxInk = texture2D(uLegendMap, vLegendCell.xy + vLegendUv * vLegendCell.zw);
  // vCapVar.y = desgaste da legenda desta tecla específica.
  msxInk.a *= clamp(1.0 - vCapVar.y, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, msxInk.rgb, msxInk.a);
}
`

const LEGEND_FRAG_ROUGH = /* glsl */ `
roughnessFactor = clamp(roughnessFactor + vCapVar.x + msxGrime * 0.34 - msxPolish * 0.16, 0.04, 1.0);
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.82, msxInk.a);
`

/**
 * Clona o material de capa da biblioteca e injeta tampografia, sujeira de saia e
 * variação por instância. A célula do atlas e o par (rugosidade, desgaste)
 * chegam por atributo de instância, o que mantém as 89 teclas em poucos
 * `InstancedMesh` sem que duas capas fiquem idênticas — a repetição perfeita é o
 * sinal mais óbvio de instanciamento numa foto macro.
 */
function withLegend(base: THREE.MeshPhysicalMaterial, atlas: DecalMaps): THREE.MeshPhysicalMaterial {
  const material = base.clone()
  material.name = `${base.name}-legendado`
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uLegendMap'] = { value: atlas.map }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${LEGEND_VERT_HEAD}`)
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vLegendUv = legendUv;\n  vLegendCell = aLegendCell;\n  vCapRise = capRise;\n  vCapVar = aCapVar;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${LEGEND_FRAG_HEAD}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${LEGEND_FRAG_COLOR}`)
      .replace(
        '#include <roughnessmap_fragment>',
        // Serigrafia é levemente mais lisa que o substrato (SPEC §4).
        `#include <roughnessmap_fragment>\n${LEGEND_FRAG_ROUGH}`,
      )
  }
  material.customProgramCacheKey = () => 'msx-keycap-legend'
  return material
}

// ---------------------------------------------------------------------------
// Envelhecimento por tecla
// ---------------------------------------------------------------------------

/**
 * Teclas que a mão realmente encosta. Ficam polidas (rugosidade menor), um fio
 * mais claras e com a legenda comida — é o mapa de desgaste que a SPEC §4 pede.
 */
const POLISHED = new Set<string>([
  'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL',
  'KeyE', 'KeyN', 'KeyO', 'KeyR', 'KeyT',
  'Enter', 'Space', 'ShiftLeft', 'Backspace', 'ArrowLeft', 'ArrowRight',
])

/**
 * Multiplicador linear de albedo das capas pigmentadas, por família. Calibrado
 * medindo o render contra a foto: STOP ≈ (170,70,55), L/R GRA ≈ (133,147,122) e
 * cursor ≈ (66,116,123).
 */
const TONE_TINT: Readonly<Record<'stop' | 'gra' | 'cursor', readonly [number, number, number]>> = {
  stop: [0.50, 0.26, 0.20],
  gra: [0.28, 0.33, 0.27],
  cursor: [0.36, 0.48, 0.44],
}

interface CapAging {
  /** Multiplicador de albedo, em espaço linear. */
  readonly tint: THREE.Color
  /** Deslocamento de rugosidade aplicado no shader. */
  readonly rough: number
  /** 0..1 — quanto da legenda já saiu. */
  readonly wear: number
  /** 0..1 — intensidade da mancha de polimento no centro da face. */
  readonly polish: number
}

/**
 * Envelhecimento determinístico de uma capa. O ABS claro de 1985 amarela por
 * fotólise, e amarela *desigual*: o canal verde sobe em relação ao vermelho e o
 * azul despenca, o que na foto de referência dá (185,190,170) em vez do
 * `#B8B5AC` de fábrica. Capas pigmentadas (STOP, GRA, cursor) não amarelam —
 * elas desbotam e escurecem de sujeira.
 */
function capAging(code: string, tone: Exclude<Tone, never>): CapAging {
  const rng = createRng(hashString(`aging|${code}`))
  const value = 1 + (rng() - 0.5) * 0.12
  const yellow = rng()
  const polished = POLISHED.has(code)
  const tint = new THREE.Color()

  if (tone === 'main' || tone === 'mod' || tone === 'worn') {
    // ~60 % das capas puxam claramente para o oliva; o resto fica quase neutro.
    // Os coeficientes vêm de medição: a chave é 4500 K contra um branco de
    // 5600 K, ou seja *quente*, e sem sobrecompensar no albedo o canal verde
    // nunca sobe acima do vermelho. Alvo medido no render: (185,190,170).
    const y = yellow > 0.4 ? 0.45 + yellow * 0.35 : yellow * 0.4
    // 0,80 é sujeira e envelhecimento, não compensação de exposição: 41 anos de
    // sala derrubam o ABS de fábrica cerca de 20 % em linear. Se a exposição do
    // set mudar, mexa na exposição — não aqui.
    const v = value * (polished ? 0.85 : 0.80)
    tint.setRGB(v * (1 - 0.05 * y), v * (1 + 0.055 * y), v * (1 - 0.135 * y), THREE.LinearSRGBColorSpace)
  } else {
    // Pigmento saturado. A curva AgX dessatura o que passa do meio-tom, então um
    // vermelho de fábrica entregue cheio volta salmão: o albedo entra escuro o
    // bastante para a curva devolver o tijolo da foto.
    const base = TONE_TINT[tone === 'stop' ? 'stop' : tone === 'gra' ? 'gra' : 'cursor']
    tint.setRGB(value * base[0], value * base[1], value * base[2], THREE.LinearSRGBColorSpace)
  }

  return {
    tint,
    rough: (rng() - 0.5) * 0.12,
    wear: polished ? 0.16 + rng() * 0.22 : rng() * 0.12,
    polish: polished ? 0.7 + rng() * 0.3 : rng() * 0.25,
  }
}

// ---------------------------------------------------------------------------
// Módulo
// ---------------------------------------------------------------------------

interface KeyRuntime {
  readonly def: KeyDef
  readonly mesh: THREE.InstancedMesh
  readonly index: number
  readonly seat: THREE.Vector3
  readonly yaw: number
  travel: number
  velocity: number
  target: number
}

/** Cor de capa por família (SPEC §3.2). */
const TONE_COLOUR: Readonly<Record<Tone, number>> = {
  main: PALETTE.keycapMain,
  mod: PALETTE.keycapModifier,
  stop: PALETTE.keycapStop,
  gra: PALETTE.keycapGra,
  cursor: PALETTE.keycapCursor,
  worn: PALETTE.keycapMain,
}

export class KeyboardModule implements SceneModule {
  readonly name = 'Keyboard'

  private readonly keys = new Map<string, KeyRuntime>()
  private readonly activeKeys = new Set<KeyRuntime>()
  /** Para levantar `shadowMap.needsUpdate` nos quadros em que teclas se movem. */
  private renderer: THREE.WebGLRenderer | null = null
  private readonly dirty = new Set<THREE.InstancedMesh>()
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly textures: THREE.Texture[] = []
  private readonly toneCache = new Map<Tone, THREE.MeshPhysicalMaterial>()
  private capAtlas: DecalMaps | null = null
  private shellMaterial: THREE.MeshPhysicalMaterial | null = null
  private panelMaterial: THREE.MeshPhysicalMaterial | null = null
  private inUse: THREE.MeshStandardMaterial | null = null
  private readonly scratch = new THREE.Matrix4()
  private readonly quat = new THREE.Quaternion()
  private readonly one = new THREE.Vector3(1, 1, 1)
  private readonly pos = new THREE.Vector3()
  private readonly axisY = new THREE.Vector3(0, 1, 0)

  async build(ctx: ModuleContext): Promise<THREE.Group> {
    this.renderer = ctx.renderer
    // Pré-aquece (fatiado) as duas poeiras que `grimeMap` consome de forma
    // síncrona em `silver()`/`black()` — mesmos parâmetros, mesma chave de cache.
    await dustAccumulationAsync(512, { coverage: 0.55, range: [0.88, 1], seed: 0x51a7 })
    await dustAccumulationAsync(512, { coverage: 0.55, range: [0.62, 1], seed: 0x2f31 })

    const group = new THREE.Group()
    group.name = 'teclado'
    // Pés de borracha levantam a peça 2,5 mm da mesa (sombra de contato).
    group.position.set(0, 0.0025, 0.265)

    const deck = new THREE.Group()
    deck.name = 'teclado-superficie'
    deck.position.y = DECK_Y
    deck.rotation.x = DECK_TILT
    group.add(deck)

    this.buildShell(ctx, group)
    await yieldToMain()
    this.buildWells(ctx, deck)
    await yieldToMain()
    this.buildDetails(ctx, deck)
    await yieldToMain()
    await this.buildCaps(ctx, deck)
    await yieldToMain()
    this.buildFeetAndCable(ctx, group)

    group.userData['keyboard'] = this
    return group
  }

  // ── Superfícies do casco ─────────────────────────────────────────────────

  /**
   * Reempacota uma textura da biblioteca com outra densidade. As UVs das peças
   * extrudadas estão **em metros** (o gerador padrão do `ExtrudeGeometry` copia
   * x/y da shape), então `repeat` aqui é o inverso do lado do ladrilho: 22
   * significa um ladrilho de 45 mm. Com o `repeat` de 6 da biblioteca o grão de
   * pele-de-laranja virava um estuque de 17 cm — visível como reboco, não como
   * plástico.
   */
  private tile(texture: THREE.Texture | null, repeat: number): THREE.Texture | null {
    if (texture === null) return null
    const t = texture.clone()
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
    t.repeat.set(repeat, repeat)
    t.needsUpdate = true
    this.textures.push(t)
    return t
  }

  /**
   * Camada de poeira/pigmento no albedo. É *multiplicativa*, então a faixa é
   * escolhida para que a poeira seja o valor 1 e o resto escureça — sujeira
   * assentada num plástico escuro lê como clareamento, e é assim que se obtém
   * isso sem uma segunda passada.
   */
  private grimeMap(lo: number, repeat: number, seed: number): THREE.Texture {
    const base = dustAccumulation(512, { coverage: 0.55, range: [lo, 1], seed })
    const t = base.clone()
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
    t.repeat.set(repeat, repeat)
    t.needsUpdate = true
    this.textures.push(t)
    return t
  }

  /**
   * Prateado do teclado. Clona o plástico da biblioteca e o envelhece: 41 anos
   * de sala escurecem o `#A8A49B` de fábrica, o grão fica na escala certa e o
   * albedo ganha o salpico de pigmento que faz o ABS ler como ABS.
   */
  private silver(ctx: ModuleContext): THREE.MeshPhysicalMaterial {
    const hit = this.shellMaterial
    if (hit !== null) return hit
    const m = ctx.materials.caseSilver().clone()
    m.name = 'teclado-prata'
    m.color.setHex(0x8d8981)
    m.map = this.grimeMap(0.88, 6, 0x51a7)
    m.normalMap = this.tile(m.normalMap, 22)
    m.roughnessMap = this.tile(m.roughnessMap, 22)
    m.aoMap = this.tile(m.aoMap, 5)
    m.aoMapIntensity = 0.9
    // SPEC §4: a casca de laranja real quase não aparece — ela é uma quebra do
    // especular em ângulo rasante, não um relevo legível de frente.
    m.normalScale.set(0.16, 0.16)
    m.envMapIntensity = 0.85
    m.needsUpdate = true
    this.shellMaterial = m
    this.materials.push(m)
    return m
  }

  /**
   * Preto fosco do painel. O problema medido no render anterior era o IBL: sem
   * occlusão especular a luz de preenchimento fria levantava o `#232323` para
   * (59,62,67) e ainda o tingia de azul. Corta-se o env e o especular, e a
   * poeira entra pelo albedo.
   */
  private black(ctx: ModuleContext): THREE.MeshPhysicalMaterial {
    const hit = this.panelMaterial
    if (hit !== null) return hit
    const m = ctx.materials.panelBlack().clone()
    m.name = 'teclado-painel'
    // 0x272725 (~15 % de albedo) rendia um painel CINZA sob o softbox — o campo de
    // teclas inteiro lia lavado e as capas pareciam flutuar sobre um chão claro
    // (shots/probe/sem-capas-topo.png). Plástico ABS preto fosco real reflete
    // 4–6 %; na foto de referência o painel continua quase preto mesmo iluminado.
    // A foto manda (invariante #3).
    m.color.setHex(0x141414)
    m.map = this.grimeMap(0.62, 4, 0x2f31)
    m.normalMap = this.tile(m.normalMap, 26)
    m.roughnessMap = this.tile(m.roughnessMap, 26)
    m.aoMap = this.tile(m.aoMap, 6)
    m.aoMapIntensity = 1
    m.normalScale.set(0.12, 0.12)
    m.roughness = 0.9
    m.specularIntensity = 0.08
    m.envMapIntensity = 0.1
    m.needsUpdate = true
    this.panelMaterial = m
    this.materials.push(m)
    return m
  }

  // ── Casco ────────────────────────────────────────────────────────────────

  private buildShell(ctx: ModuleContext, group: THREE.Group): void {
    // `extrudeUp` já normaliza a peça para y ∈ [0, depth]; o contorno passado
    // aqui é a seção mais larga do sólido, então mede BOARD_W × BOARD_D. As
    // tampas ficam recuadas em SHELL_BEVEL — é o filete pedido na SPEC §3.
    const outer = roundedShape(
      [
        sp(PHOTO_X0, PHOTO_Z0),
        sp(PHOTO_X1, PHOTO_Z0),
        sp(PHOTO_X1, PHOTO_Z1),
        sp(PHOTO_X0, PHOTO_Z1),
      ],
      0.006,
    )
    // Nos furos o chanfro abre para fora: dá a parede de entrada do rebaixo.
    outer.holes.push(
      roundedShape(
        PANEL_OUTLINE.map(([x, z]) => sp(x, z)),
        0.0015,
      ),
      rectShape(PAD_WELL, 0.0015),
      rectShape(CURSOR_WELL, 0.0015),
      rectShape(INUSE_SLOT, 0.0008),
      rectShape(STRIP_SLOT, 0.0006),
      rectShape(MSX_SLOT, 0.0006),
    )

    // Base em y = 0, topo em y = BOARD_H — é o que o grupo `deck` pressupõe.
    //
    // `bevelSegments: 2` é uma decisão de leitura, não de custo. Com 3+ o filete
    // vira um rolo suave e a borda de cada rebaixo some numa silhueta de largura
    // zero — foi exatamente o que aconteceu com o entalhe diagonal, a assinatura
    // da peça (SPEC §3). Com 2 facetas o perfil é um chanfro plano de ~1,3 mm
    // seguido de uma parede íngreme: o chanfro corre a diagonal inteira e devolve
    // o risco de especular que faz o entalhe existir em 3D.
    const geometry = extrudeUp(outer, { depth: BOARD_H, bevel: SHELL_BEVEL, bevelSegments: 2 })
    applyWedge(geometry)
    this.geometries.push(geometry)
    const shell = new THREE.Mesh(geometry, this.silver(ctx))
    shell.name = 'teclado-casco'
    shell.castShadow = true
    shell.receiveShadow = true
    group.add(shell)

    // Fundo: fecha os furos por baixo e dá a face que apoia na mesa.
    const floorShape = roundedShape(
      [
        sp(PHOTO_X0 + 6, PHOTO_Z0 + 6),
        sp(PHOTO_X1 - 6, PHOTO_Z0 + 6),
        sp(PHOTO_X1 - 6, PHOTO_Z1 - 6),
        sp(PHOTO_X0 + 6, PHOTO_Z1 - 6),
      ],
      0.005,
    )
    const floor = extrudeUp(floorShape, { depth: 0.0022, bevel: 0.0005, bevelSegments: 1 })
    this.geometries.push(floor)
    const floorMesh = new THREE.Mesh(floor, this.black(ctx))
    floorMesh.name = 'teclado-fundo'
    floorMesh.position.y = 0.0004
    floorMesh.receiveShadow = true
    group.add(floorMesh)
  }

  // ── Lajes pretas encaixadas ──────────────────────────────────────────────

  private buildWells(ctx: ModuleContext, deck: THREE.Group): void {
    const black = this.black(ctx)

    const panel = roundedShape(
      PANEL_OUTLINE.map(([x, z]) => sp(x, z)),
      0.0015,
    )
    // Rasgo cego abaixo das teclas de função, presente na foto.
    panel.holes.push(rectShape(BLANK_SLOT, 0.0008))

    const slabs: readonly (readonly [name: string, shape: THREE.Shape, top: number])[] = [
      ['painel-principal', panel, -PANEL_INSET],
      ['poco-numerico', rectShape(PAD_WELL, 0.0015), -PANEL_INSET],
      ['moldura-cursor', rectShape(CURSOR_WELL, 0.0015), CURSOR_FLOOR],
      ['rasgo-cego', rectShape(BLANK_SLOT, 0.0008), -PANEL_INSET - 0.0027],
    ]
    for (const [name, shape, top] of slabs) {
      const geometry = extrudeUp(shape, { depth: PANEL_THICK, bevel: SLAB_BEVEL, bevelSegments: 1 })
      // `extrudeUp` devolve a laje em y ∈ [0, PANEL_THICK]: basta descer o topo.
      geometry.translate(0, top - PANEL_THICK, 0)
      this.geometries.push(geometry)
      const mesh = new THREE.Mesh(geometry, black)
      mesh.name = `teclado-${name}`
      mesh.receiveShadow = true
      mesh.castShadow = true
      deck.add(mesh)
    }

  }

  // ── Detalhes: sulco, IN USE, LED, serigrafia ─────────────────────────────

  private buildDetails(ctx: ModuleContext, deck: THREE.Group): void {
    // Linha de junção entre o bloco principal e o numérico. Um sulco de verdade
    // exigiria um rasgo no casco mais largo que o próprio filete de 1,8 mm — o
    // que engoliria a linha. Fica então uma tira quase rasante (0,05 mm) em
    // preto fosco: à distância de leitura é indistinguível de um sulco.
    const seam = new THREE.BoxGeometry(0.0009, 0.0012, dz(PHOTO_Z1 - PHOTO_Z0 - 26))
    seam.translate(mx(SEAM_X), 0.00005 - 0.0006, 0)
    this.geometries.push(seam)
    const seamMesh = new THREE.Mesh(seam, this.black(ctx))
    seamMesh.name = 'teclado-sulco'
    deck.add(seamMesh)

    // Barra escura acima do teclado numérico. Na foto é um rebaixo de altura
    // constante, com sombra na borda de cima — antes era uma laje quase
    // coplanar com o casco, que degenerava numa lasca em Z-fighting.
    const strip = extrudeUp(rectShape(STRIP_SLOT, 0.0006), { depth: 0.004, bevel: 0.0002, bevelSegments: 1 })
    strip.translate(0, -0.0008 - 0.004, 0)
    this.geometries.push(strip)
    const stripMesh = new THREE.Mesh(strip, this.black(ctx))
    stripMesh.name = 'teclado-faixa'
    stripMesh.receiveShadow = true
    deck.add(stripMesh)

    // Emblema MSX: painel impresso rebaixado 0,4 mm, não um adesivo flutuando.
    const msx = extrudeUp(rectShape(MSX_SLOT, 0.0006), { depth: 0.004, bevel: 0.0002, bevelSegments: 1 })
    msx.translate(0, -0.0004 - 0.004, 0)
    this.geometries.push(msx)
    const msxMaterial = this.silver(ctx).clone()
    msxMaterial.name = 'teclado-msx'
    // O `#CC2229` da SPEC entregue direto ao AgX volta rosa; entrando um pouco
    // mais escuro, a curva devolve o tijolo saturado da foto.
    msxMaterial.color.setHex(0x6f1215)
    msxMaterial.map = null
    msxMaterial.roughness = 0.46
    msxMaterial.specularIntensity = 0.4
    msxMaterial.envMapIntensity = 0.25
    msxMaterial.needsUpdate = true
    this.materials.push(msxMaterial)
    const msxMesh = new THREE.Mesh(msx, msxMaterial)
    msxMesh.name = 'teclado-msx'
    msxMesh.receiveShadow = true
    deck.add(msxMesh)

    // Fundo prateado do rebaixo "IN USE" (o furo do casco dá as paredes).
    const inuse = extrudeUp(rectShape(INUSE_SLOT, 0.0008), { depth: 0.004, bevel: 0.0003, bevelSegments: 1 })
    inuse.translate(0, -0.0021 - 0.004, 0)
    this.geometries.push(inuse)
    const inuseMesh = new THREE.Mesh(inuse, this.silver(ctx))
    inuseMesh.name = 'teclado-in-use'
    inuseMesh.receiveShadow = true
    deck.add(inuseMesh)

    // Janela do LED: lente vermelha escura. Com a máquina desligada ela não
    // emite nada — na foto é um vidrinho apagado, não um ponto brilhante.
    const lensGeometry = new THREE.BoxGeometry(dx(26), 0.0011, dz(14))
    lensGeometry.translate(mx(1014), -0.00175, mz(528))
    this.geometries.push(lensGeometry)
    const lens = new THREE.MeshStandardMaterial({
      name: 'teclado-led',
      color: new THREE.Color(0x2a0f0d),
      roughness: 0.22,
      metalness: 0,
      emissive: new THREE.Color(0xd8422a),
      emissiveIntensity: 0,
    })
    this.inUse = lens
    this.materials.push(lens)
    const lensMesh = new THREE.Mesh(lensGeometry, lens)
    lensMesh.name = 'teclado-led'
    deck.add(lensMesh)
  }

  private buildFeetAndCable(ctx: ModuleContext, group: THREE.Group): void {
    const foot = new THREE.CylinderGeometry(0.007, 0.0075, 0.0025, 16)
    this.geometries.push(foot)
    const feet = new THREE.InstancedMesh(foot, ctx.materials.rubber(), 4)
    feet.name = 'teclado-pes'
    feet.castShadow = true
    const spots: readonly (readonly [number, number])[] = [
      [-0.19, -0.068],
      [0.19, -0.068],
      [-0.19, 0.068],
      [0.19, 0.068],
    ]
    spots.forEach(([x, z], i) => {
      feet.setMatrixAt(i, this.scratch.makeTranslation(x, -0.00125, z))
    })
    feet.instanceMatrix.needsUpdate = true
    group.add(feet)

    // Cabo de 13 pinos: catenária física até o primeiro apoio; daí em diante,
    // pontos autorais preservam o rabicho em contato com a mesa.
    const cableExit = new THREE.Vector3(-0.128, 0.012, -0.0855)
    const deskTouch = new THREE.Vector3(-0.142, 0.0035, -0.208)
    const hanging = catenary(cableExit, deskTouch, 0.003, 32)
    const curve = new THREE.CatmullRomCurve3([
      ...hanging,
      new THREE.Vector3(-0.108, 0.0026, -0.256),
      new THREE.Vector3(-0.056, 0.003, -0.281),
    ], false, 'centripetal')
    const cable = new THREE.TubeGeometry(curve, 48, 0.0024, 8, false)
    this.geometries.push(cable)
    const cableMesh = new THREE.Mesh(cable, ctx.materials.rubber())
    cableMesh.name = 'teclado-cabo'
    cableMesh.castShadow = true
    group.add(cableMesh)
  }

  // ── Ciclo de vida ────────────────────────────────────────────────────────

  update(dt: number): boolean {
    if (this.activeKeys.size === 0) return false

    // Teclas em curso mudam a geometria projetora: o atlas de sombra congelado
    // (Engine, shadowMap.autoUpdate = false) precisa redesenhar neste quadro.
    // Setado ANTES do laço porque o quadro de assentamento ainda escreve instâncias.
    if (this.renderer !== null) this.renderer.shadowMap.needsUpdate = true

    // Mola criticamente amortecida: sem ressalto, com peso mecânico.
    const omega = 42

    /**
     * Euler semi-implícito com este ômega só é estável enquanto `h < 0.828/ω`,
     * ou seja ~19,7 ms — abaixo de ~51 fps ele diverge. O código antigo apenas
     * limitava o passo a 1/30 s (33 ms), que está do lado errado desse limite: a
     * 30 fps uma tecla pressionada saltava para metros de curso em três quadros e
     * virava NaN, e como as capas são um `InstancedMesh` único, um NaN levava o
     * teclado inteiro junto. Máquina lenta, teclado destruído ao digitar.
     *
     * Sub-dividir o quadro resolve e é o padrão que o resto do projeto já usa
     * (`stepSpring` no joystick, o laço de `Physics.ts`). O teto de 1/55 s mantém
     * um quadro de 60 fps em UM passo — idêntico ao comportamento calibrado de
     * hoje, que é medido (2,6 mm em 9 classes de tecla) e não pode mudar.
     */
    const MAX_STABLE_STEP = 1 / 55
    // Um quadro absurdo (aba restaurada, breakpoint) não deve virar dezenas de
    // sub-passos: o curso satura, não acelera.
    const frame = Math.min(dt, 1 / 10)
    const substeps = Math.max(1, Math.ceil(frame / MAX_STABLE_STEP))
    const step = frame / substeps

    for (const key of this.activeKeys) {
      let settled = false
      for (let i = 0; i < substeps; i++) {
        const delta = key.travel - key.target
        if (Math.abs(delta) < 1e-6 && Math.abs(key.velocity) < 1e-5) {
          if (key.travel !== key.target) {
            key.travel = key.target
            key.velocity = 0
          }
          settled = true
          break
        }
        key.velocity += (-2 * omega * key.velocity - omega * omega * delta) * step
        key.travel += key.velocity * step
      }
      this.writeInstance(key)
      if (settled) this.activeKeys.delete(key)
    }

    for (const mesh of this.dirty) mesh.instanceMatrix.needsUpdate = true
    this.dirty.clear()
    return true
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    for (const texture of this.textures) texture.dispose()
    this.geometries.length = 0
    this.materials.length = 0
    this.textures.length = 0
    this.activeKeys.clear()
    this.keys.clear()
  }

  // ── API pública ──────────────────────────────────────────────────────────

  /** Todos os `KeyboardEvent.code` presentes na peça. */
  get keyCodes(): readonly string[] {
    return [...this.keys.keys()]
  }

  /** Afunda a capa. Códigos desconhecidos são ignorados em silêncio. */
  pressKey(code: string): boolean {
    const key = this.keys.get(code)
    if (key === undefined) return false
    if (key.target !== KEY_TRAVEL) {
      key.target = KEY_TRAVEL
      this.activeKeys.add(key)
    }
    return true
  }

  releaseKey(code: string): boolean {
    const key = this.keys.get(code)
    if (key === undefined) return false
    if (key.target !== 0) {
      key.target = 0
      this.activeKeys.add(key)
    }
    return true
  }

  isPressed(code: string): boolean {
    return (this.keys.get(code)?.target ?? 0) > 0
  }

  /** Acende ou apaga o LED "IN USE". */
  setInUse(on: boolean): void {
    // Baixo de propósito: a SPEC §7 diz que só a tela deve realmente brilhar.
    if (this.inUse !== null) this.inUse.emissiveIntensity = on ? 0.55 : 0
  }

  private writeInstance(key: KeyRuntime): void {
    this.quat.setFromAxisAngle(this.axisY, key.yaw)
    this.pos.set(key.seat.x, key.seat.y - key.travel, key.seat.z)
    this.scratch.compose(this.pos, this.quat, this.one)
    key.mesh.setMatrixAt(key.index, this.scratch)
    this.dirty.add(key.mesh)
  }

  // ── Teclas ───────────────────────────────────────────────────────────────

  private async buildCaps(ctx: ModuleContext, deck: THREE.Group): Promise<void> {
    const defs = buildLayout()
    const flat = defs.filter((def) => def.profile !== 'cursor')

    // 1. Atlas: uma célula por legenda, com a mesma proporção da face impressa.
    const items: AtlasItem[] = []
    for (const def of flat) {
      if (def.legend === '' && def.code !== 'Enter') continue
      const w = Math.round((dx(def.w) - 2 * CAP_TAPER) * ATLAS_PPM)
      const h = Math.round((dz(def.d) - 2 * CAP_TAPER) * ATLAS_PPM)
      if (def.code === 'Enter') {
        items.push({ id: 'Enter', w, h, draw: drawEnterArrow })
        continue
      }
      const seed = hashString(`${def.code}|${def.legend}`)
      const primary = def.legend
      const secondary = def.legend2
      items.push({
        id: def.code,
        w,
        h,
        draw: (c, cw, ch) => drawKeyLegend(c, cw, ch, primary, secondary, seed),
      })
    }
    for (const badge of BADGES) {
      items.push({
        id: badge.id,
        w: Math.round(dx(badge.rect[2] - badge.rect[0]) * ATLAS_PPM),
        h: Math.round(dz(badge.rect[3] - badge.rect[1]) * ATLAS_PPM),
        draw: badge.draw,
      })
    }

    const rects = packAtlas(items)
    const atlas = await silkscreenDecalAsync(
      (c) => {
        for (const item of items) {
          const rect = rects.get(item.id)
          if (rect === undefined) continue
          c.save()
          c.translate(rect.x, rect.y)
          c.beginPath()
          c.rect(0, 0, rect.w, rect.h)
          c.clip()
          item.draw(c, rect.w, rect.h)
          c.restore()
        }
      },
      {
        width: ATLAS_W,
        height: ATLAS_H,
        ink: INK,
        // Tampografia de 1985 com 41 anos de dedo: falha, mas ainda legível.
        wear: 0.2,
        relief: 1.5,
        gloss: 0.5,
        cacheKey: 'xp800-teclado',
      },
    )
    this.textures.push(atlas.map, atlas.normalMap, atlas.roughnessMap)
    this.capAtlas = atlas

    const cellOf = (id: string): AtlasCell => {
      const rect = rects.get(id)
      return rect === undefined ? [0, 0, 0, 0] : rectToCell(rect)
    }

    // 3. Um InstancedMesh por (geometria × cor).
    const groups = new Map<string, KeyDef[]>()
    for (const def of flat) {
      const key = `${def.profile}|${def.w.toFixed(1)}x${def.d.toFixed(1)}|${def.tone}`
      const bucket = groups.get(key)
      if (bucket === undefined) groups.set(key, [def])
      else bucket.push(def)
    }

    const proxyGeometry = new THREE.BoxGeometry(1, 1, 1)
    this.geometries.push(proxyGeometry)
    const proxyMaterial = new THREE.MeshBasicMaterial({ name: 'teclado-proxy', visible: false })
    this.materials.push(proxyMaterial)

    for (const [key, bucket] of groups) {
      const first = bucket[0]
      if (first === undefined) continue
      const geometry = capShapeFor(first)
      geometry.setAttribute(
        'aLegendCell',
        new THREE.InstancedBufferAttribute(new Float32Array(bucket.length * 4), 4),
      )
      geometry.setAttribute(
        'aCapVar',
        new THREE.InstancedBufferAttribute(new Float32Array(bucket.length * 3), 3),
      )
      this.geometries.push(geometry)

      const mesh = new THREE.InstancedMesh(geometry, this.toneMaterial(ctx, first.tone), bucket.length)
      mesh.name = `teclas-${key}`
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      const cellAttr = geometry.getAttribute('aLegendCell')
      const varAttr = geometry.getAttribute('aCapVar')
      const height = first.profile === 'fn' || first.profile === 'cmd' ? CAP_H_LOW : CAP_H
      // STOP…DELETE nascem no prateado; o resto, na laje preta rebaixada.
      const seatY = (first.profile === 'cmd' ? 0 : -PANEL_INSET) - CAP_SINK

      bucket.forEach((def, i) => {
        const seat = new THREE.Vector3(mx(def.cx), seatY, mz(def.cz))
        const cell = cellOf(def.code)
        cellAttr.setXYZW(i, cell[0], cell[1], cell[2], cell[3])
        const aging = capAging(def.code, def.tone)
        varAttr.setXYZ(i, aging.rough, aging.wear, aging.polish)
        mesh.setColorAt(i, aging.tint)
        this.registerKey(def, mesh, i, seat, 0)
        this.addProxy(deck, proxyGeometry, proxyMaterial, def, seat, dx(def.w), dz(def.d), height)
      })
      cellAttr.needsUpdate = true
      varAttr.needsUpdate = true
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
      deck.add(mesh)
    }

    this.buildCursorCluster(ctx, deck, defs, proxyGeometry, proxyMaterial)
    this.buildBadges(deck, atlas, rects)
  }

  /**
   * Material de capa por família de cor, com legenda, sujeira e variação por
   * instância injetadas. Fica em cache: são cinco programas no total.
   */
  private toneMaterial(ctx: ModuleContext, tone: Tone): THREE.MeshPhysicalMaterial {
    const hit = this.toneCache.get(tone)
    if (hit !== undefined) return hit
    const atlas = this.capAtlas
    if (atlas === null) throw new Error('Keyboard: atlas de legendas ainda não construído.')
    const made = withLegend(ctx.materials.keycap(TONE_COLOUR[tone], tone === 'worn'), atlas)
    // Occlusão especular grosseira: uma capa cercada de vizinhas não vê o céu
    // inteiro. Sem isto o IBL levanta o preto e lava o vermelho do STOP.
    const pigmented = tone === 'stop' || tone === 'gra' || tone === 'cursor'
    made.envMapIntensity = pigmented ? 0.35 : 0.8
    // Uma capa pigmentada devolve o mesmo F0 de 4 % que as cinzas, mas aqui ela
    // está cercada de vizinhas e não vê o céu inteiro; sem essa oclusão o brilho
    // branco por cima do pigmento é o que lava o vermelho do STOP até virar salmão.
    if (pigmented) made.specularIntensity = 0.55
    this.toneCache.set(tone, made)
    this.materials.push(made)
    return made
  }

  /** Cluster de cursor: duas geometrias, cada uma instanciada e girada 180°. */
  private buildCursorCluster(
    ctx: ModuleContext,
    deck: THREE.Group,
    defs: readonly KeyDef[],
    proxyGeometry: THREE.BufferGeometry,
    proxyMaterial: THREE.Material,
  ): void {
    const [x0, z0, x1, z1] = CURSOR_WELL
    const centre = new THREE.Vector3(mx((x0 + x1) / 2), CURSOR_FLOOR - CAP_SINK, mz((z0 + z1) / 2))
    const wellW = dx(x1 - x0)
    const wellD = dz(z1 - z0)

    const material = this.toneMaterial(ctx, 'cursor')

    // `down` e `right` são as mesmas peças giradas meia-volta: é assim que o
    // molde real funciona e garante simetria perfeita no diamante.
    const pairs: readonly (readonly [shape: 'up' | 'left', a: string, b: string])[] = [
      ['up', 'ArrowUp', 'ArrowDown'],
      ['left', 'ArrowLeft', 'ArrowRight'],
    ]
    for (const [shape, codeA, codeB] of pairs) {
      const outline = roundedShapePoints(cursorCell(shape, wellW, wellD), 0.0011, 2)
      const geometry = capGeometry({
        outline,
        height: CAP_H_CURSOR,
        taper: 0.0009,
        dishX: 0,
        dishZ: 0.00022,
        rings: 3,
      })
      geometry.setAttribute('aLegendCell', new THREE.InstancedBufferAttribute(new Float32Array(8), 4))
      geometry.setAttribute('aCapVar', new THREE.InstancedBufferAttribute(new Float32Array(6), 3))
      this.geometries.push(geometry)

      const mesh = new THREE.InstancedMesh(geometry, material, 2)
      mesh.name = `teclas-cursor-${shape}`
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      const varAttr = geometry.getAttribute('aCapVar')

      const box = new THREE.Box2()
      for (const p of outline) box.expandByPoint(p)
      const size = box.getSize(new THREE.Vector2())
      const mid = box.getCenter(new THREE.Vector2())

      const codes = [codeA, codeB] as const
      codes.forEach((code, i) => {
        const def = defs.find((d) => d.code === code)
        if (def === undefined) return
        const yaw = i === 0 ? 0 : Math.PI
        const aging = capAging(code, 'cursor')
        varAttr.setXYZ(i, aging.rough, 0, 0)
        mesh.setColorAt(i, aging.tint)
        this.registerKey(def, mesh, i, centre, yaw)
        const sign = i === 0 ? 1 : -1
        const seat = new THREE.Vector3(centre.x + sign * mid.x, centre.y, centre.z + sign * mid.y)
        this.addProxy(deck, proxyGeometry, proxyMaterial, def, seat, size.x, size.y, CAP_H_CURSOR)
      })
      varAttr.needsUpdate = true
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
      deck.add(mesh)
    }
  }

  /** Emblemas serigrafados: um único mesh com os cinco decalques do atlas. */
  private buildBadges(deck: THREE.Group, atlas: DecalMaps, rects: Map<string, AtlasRect>): void {
    const position: number[] = []
    const uv: number[] = []
    const normal: number[] = []
    const index: number[] = []

    for (const badge of BADGES) {
      const rect = rects.get(badge.id)
      if (rect === undefined) continue
      const [u0, v0, du, dv] = rectToCell(rect)
      const [px0, pz0, px1, pz1] = badge.rect
      const base = position.length / 3
      const corners: readonly (readonly [number, number, number, number])[] = [
        [mx(px0), mz(pz1), u0, v0],
        [mx(px1), mz(pz1), u0 + du, v0],
        [mx(px1), mz(pz0), u0 + du, v0 + dv],
        [mx(px0), mz(pz0), u0, v0 + dv],
      ]
      for (const [x, z, u, v] of corners) {
        position.push(x, badge.y, z)
        normal.push(0, 1, 0)
        uv.push(u, v)
      }
      index.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geometry.setIndex(index)
    this.geometries.push(geometry)

    const material = new THREE.MeshPhysicalMaterial({
      name: 'teclado-serigrafia',
      map: atlas.map,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughnessMap: atlas.roughnessMap,
      roughness: 0.36,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      // O termo de *fator* é escalado pela inclinação do fragmento: num plano
      // quase horizontal visto de rasante ele dispara e o decalque atravessa as
      // capas que estão à sua frente. Os 0,12 mm de folga geométrica já separam
      // o decalque do substrato; aqui basta um viés constante mínimo.
      polygonOffsetFactor: 0,
      polygonOffsetUnits: -2,
      side: THREE.FrontSide,
    })
    this.materials.push(material)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'teclado-emblemas'
    mesh.renderOrder = 2
    deck.add(mesh)
  }

  private registerKey(
    def: KeyDef,
    mesh: THREE.InstancedMesh,
    index: number,
    seat: THREE.Vector3,
    yaw: number,
  ): void {
    const runtime: KeyRuntime = {
      def,
      mesh,
      index,
      seat: seat.clone(),
      yaw,
      travel: 0,
      velocity: 0,
      target: 0,
    }
    this.keys.set(def.code, runtime)
    this.writeInstance(runtime)
    mesh.instanceMatrix.needsUpdate = true
    this.dirty.delete(mesh)
  }

  /**
   * Malha invisível de raycast: o render é instanciado, mas cada tecla precisa
   * ser individualmente clicável e carregar seu próprio `InteractiveUserData`.
   * `visible = false` mantém o custo de draw call em zero — o `Raycaster` do
   * three não consulta visibilidade.
   */
  private addProxy(
    deck: THREE.Group,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    def: KeyDef,
    seat: THREE.Vector3,
    width: number,
    depth: number,
    height: number,
  ): void {
    const proxy = new THREE.Mesh(geometry, material)
    proxy.name = `tecla-${def.code}`
    proxy.visible = false
    proxy.castShadow = false
    proxy.receiveShadow = false
    proxy.scale.set(width, height + 0.0015, depth)
    proxy.position.set(seat.x, seat.y + (height + 0.0015) / 2, seat.z)
    proxy.updateMatrix()
    proxy.matrixAutoUpdate = false
    const data: InteractiveUserData = {
      partId: 'keyboard-key',
      keyCode: def.code,
      label: def.label,
      cursor: 'pointer',
    }
    Object.assign(proxy.userData, data)
    deck.add(proxy)
  }
}

// ---------------------------------------------------------------------------
// Auxiliares de construção
// ---------------------------------------------------------------------------

/** Geometria da capa conforme o perfil da tecla. */
function capShapeFor(def: KeyDef): THREE.BufferGeometry {
  const w = dx(def.w) - 2 * CAP_TAPER
  const d = dz(def.d) - 2 * CAP_TAPER
  switch (def.profile) {
    case 'enter':
      return capGeometry({
        outline: enterOutline(w, d),
        height: CAP_H,
        taper: CAP_TAPER,
        dishX: 0.00028,
        dishZ: 0.00028,
        rings: 4,
      })
    case 'space':
      return capGeometry({
        // Barra de espaço real é quase plana no eixo longo; a calha é só no curto.
        outline: roundedCapOutline(w, d, 0.0016, 3),
        height: CAP_H,
        taper: CAP_TAPER,
        dishX: 0,
        dishZ: 0.00045,
        rings: 3,
      })
    case 'fn':
    case 'cmd':
      return capGeometry({
        outline: roundedCapOutline(w, d, 0.0011, 3),
        height: CAP_H_LOW,
        taper: 0.0013,
        dishX: 0.00022,
        dishZ: 0.00008,
        rings: 3,
      })
    default:
      return capGeometry({
        outline: roundedCapOutline(w, d, 0.0012, 4),
        height: CAP_H,
        taper: CAP_TAPER,
        dishX: CAP_DISH,
        dishZ: CAP_DISH * 0.3,
        rings: 4,
      })
  }
}

interface BadgeSpec {
  readonly id: string
  /** Retângulo em px da foto: x0, z0, x1, z1. */
  readonly rect: readonly [number, number, number, number]
  /** Altura no espaço do deck (o texto do IN USE fica dentro do rebaixo). */
  readonly y: number
  readonly draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void
}

const BADGES: readonly BadgeSpec[] = [
  {
    id: 'marca',
    rect: [90, 376, 400, 408],
    y: 0.00012,
    draw: (c, w, h) => {
      const end = drawGradiente(c, w * 0.01, h * 0.52, h * 0.8)
      c.save()
      c.font = `700 ${(h * 0.4).toFixed(1)}px ${LEGEND_FONT}`
      if ('letterSpacing' in c) c.letterSpacing = `${(h * 0.07).toFixed(1)}px`
      c.fillText('PERSONAL KEYBOARD', end + h * 0.55, h * 0.52 + h * 0.16)
      c.restore()
    },
  },
  { id: 'expert', rect: [1245, 376, 1395, 408], y: 0.00012, draw: drawExpert },
  // 0,12 mm acima do piso do bolso vermelho (topo em −0,4 mm).
  { id: 'msx', rect: MSX_SLOT, y: -0.00028, draw: drawMsx },
  {
    id: 'in-use',
    // Cobre o rebaixo inteiro: a arte é a segunda linha gravada concêntrica mais
    // o letreiro escuro. Na foto o "IN USE" é gravado no prateado, não impresso
    // em branco — a inversão de valor era o erro mais visível deste detalhe.
    rect: [820, 511, 1384, 543],
    y: -0.00168,
    draw: (c, w, h) => {
      c.save()
      c.strokeStyle = '#3A3A38'
      c.fillStyle = '#3A3A38'
      c.lineWidth = Math.max(1, h * 0.055)
      c.strokeRect(h * 0.28, h * 0.28, w - h * 0.56, h - h * 0.56)
      c.filter = 'blur(0.5px)'
      c.font = `${(h * 0.5).toFixed(1)}px ${LEGEND_FONT}`
      if ('letterSpacing' in c) c.letterSpacing = `${(h * 0.1).toFixed(1)}px`
      const size = fitFont(c, 'IN USE', h * 0.5, w * 0.3)
      c.fillText('IN USE', w * 0.62, h * 0.5 + size * 0.36)
      c.restore()
    },
  },
]

/** Fábrica reconhecida pelo carregador de módulos de `main.ts`. */
export function createKeyboard(): KeyboardModule {
  return new KeyboardModule()
}

export default createKeyboard
