import * as THREE from 'three'

import type { ScreenSource } from '../core/types.ts'
import { proceduralKeyForCode } from './Keymap.ts'

/**
 * Renderer MSX procedural — o caminho de reserva do `ScreenSource` (SPEC §9).
 *
 * Entra em cena quando o WebMSX não pode ser usado: CDN fora do ar, rede
 * bloqueada, integridade SRI recusada, canvas contaminado. Não é um stub: roda
 * um TMS9918 de mentira mas honesto — 256×192, paleta de 15 cores exata, células
 * de 8×8, tela de boot da BIOS, prompt de BASIC que aceita digitação de verdade
 * e um modo de demonstração quando a máquina fica parada.
 *
 * Nada aqui depende de rede, e nenhuma ROM de terceiros é distribuída: a fonte
 * de caracteres foi desenhada para este projeto no estilo do character ROM do
 * MSX, e o "BASIC" é um interpretador mínimo escrito aqui mesmo.
 */

// ---------------------------------------------------------------------------
// Paleta
// ---------------------------------------------------------------------------

/**
 * As 15 cores do TMS9918 (índice 0 = transparente, renderizado como o backdrop).
 *
 * Fonte: valores RGB derivados da tabela de cores do *TMS9918A/TMS9928A/TMS9929A
 * Video Display Processors Data Manual* (Texas Instruments, 1982) — o mesmo
 * conjunto adotado como paleta padrão do TMS99x8 no openMSX e reproduzido no
 * MSX Red Book. É a referência clássica; chips reais e monitores de composto
 * variam alguns pontos, e o passe de tubo em `CrtShader.ts` cuida disso.
 */
export const TMS9918_PALETTE: readonly number[] = Object.freeze([
  0x000000, // 0 transparente (mostra o backdrop)
  0x000000, // 1 preto
  0x21c842, // 2 verde médio
  0x5edc78, // 3 verde claro
  0x5455ed, // 4 azul escuro
  0x7d76fc, // 5 azul claro
  0xd4524d, // 6 vermelho escuro
  0x42ebf5, // 7 ciano
  0xfc5554, // 8 vermelho médio
  0xff7978, // 9 vermelho claro
  0xd4c154, // 10 amarelo escuro
  0xe6ce80, // 11 amarelo claro
  0x21b03b, // 12 verde escuro
  0xc95bba, // 13 magenta
  0xcccccc, // 14 cinza
  0xffffff, // 15 branco
])

/** Índices nomeados, para o código ficar legível. */
const C = {
  transparent: 0,
  black: 1,
  green: 2,
  lightGreen: 3,
  darkBlue: 4,
  lightBlue: 5,
  darkRed: 6,
  cyan: 7,
  red: 8,
  lightRed: 9,
  darkYellow: 10,
  lightYellow: 11,
  darkGreen: 12,
  magenta: 13,
  grey: 14,
  white: 15,
} as const

// ---------------------------------------------------------------------------
// Fonte 8×8
// ---------------------------------------------------------------------------

/**
 * Character ROM 8×8 desenhado para este projeto, no estilo do MSX: o glifo ocupa
 * as 6 colunas da esquerda, um byte por linha de varredura, bit mais
 * significativo à esquerda.
 *
 * Ordem: ASCII 0x20–0x7F (0x7F é o bloco cheio, usado pelo cursor), seguidos dos
 * extras em {@link EXTRA_GLYPHS} — Ç, ç, setas e as vogais acentuadas que o
 * conjunto internacional do MSX também trazia (é o que permite escrever em
 * português correto na tela).
 */
const FONT_HEX =
  '0000000000000000202020202000200050505000000000005050f850f8505000' +
  '2078a07028f02000c4c810204c8c00006090a040a89068002020400000000000' +
  '102040404020100040201010102040000020a870a8200000002020f820200000' +
  '0000000000302040000000f80000000000000000003030000408102040800000' +
  '708898a8c88870002060202020207000708808102040f800f810201008887000' +
  '10305090f8101000f880f00808887000304080f088887000f808102040404000' +
  '7088887088887000708888780810600000303000303000000030300030204000' +
  '10204080402010000000f800f800000040201008102040007088081020002000' +
  '7088b8a8b880700020508888f8888800f08888f08888f0007088808080887000' +
  'e09088888890e000f88080e08080f800f88080e080808000708880b088887000' +
  '888888f888888800702020202020700008080808888870008890a0c0a0908800' +
  '808080808080f80088d8a8a8888888008888c8a8988888007088888888887000' +
  'f08888f08080800070888888a8906800f08888f0a09088007088807008887000' +
  'f82020202020200088888888888870008888888888502000888888a8a8d88800' +
  '88885020508888008888502020202000f80810204080f8007040404040407000' +
  '80402010080400007010101010107000205088000000000000000000000000fc' +
  '402010000000000000007008788878008080f0888888f0000000788080807800' +
  '080878888888780000007088f8807000304840e0404040000078888878087000' +
  '8080f0888888880020006020202070001000301010906000808090a0c0a09000' +
  '60202020202070000000d0a8a88888000000f088888888000000708888887000' +
  '00f08888f080800000788888780808000000b0c880808000000078807008f000' +
  '4040e040404830000000888888986800000088888850200000008888a8a85000' +
  '000088502050880000888888780870000000f8102040f8001820204020201800' +
  '202020002020200060101008101060006498000000000000fcfcfcfcfcfcfcfc' +
  '70888080887020600000788080782060002040f840200000002070a820200000' +
  '1020700878887800402070087888780020507008788878006498700878887800' +
  '10207088f880700020507088f880700010206020202070001020708888887000' +
  '2050708888887000649870888888700010208888889868001820508888f88888' +
  '18f88080e08080f8187020202020207018708888888888701888888888888870' +
  '7820508888f888887870888888888870' +
  // ponto médio '·', usado como separador nas telas de demonstração
  '0000000030300000'

/** Extras, na ordem em que aparecem em {@link FONT_HEX} depois do 0x7F. */
const EXTRA_GLYPHS = 'Çç←↑áàâãéêíóôõúÁÉÍÓÚÃÕ·'

const FONT: Uint8Array = (() => {
  const bytes = new Uint8Array(FONT_HEX.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(FONT_HEX.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
})()

const GLYPH_COUNT = FONT.length / 8
/** Índice do bloco cheio (0x7F), usado como cursor. */
const GLYPH_BLOCK = 0x7f - 0x20
const GLYPH_SPACE = 0

const EXTRA_INDEX: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>()
  const base = 0x80 - 0x20
  for (let i = 0; i < EXTRA_GLYPHS.length; i++) {
    const ch = EXTRA_GLYPHS[i]
    if (ch !== undefined) map.set(ch, base + i)
  }
  return map
})()

function glyphOf(ch: string): number {
  const code = ch.charCodeAt(0)
  if (code >= 0x20 && code <= 0x7f) return code - 0x20
  return EXTRA_INDEX.get(ch) ?? GLYPH_SPACE
}

// ---------------------------------------------------------------------------
// Geometria da tela
// ---------------------------------------------------------------------------

/**
 * Textura de apresentação 272×240, com o framebuffer procedural nativo de
 * 256×192 centrado dentro dela.
 *
 * `ScreenSource.width/height` reportam os 256×192 nativos. A textura é maior
 * apenas para conservar a borda/overscan na apresentação sem mentir sobre a
 * resolução da fonte.
 */
const SCREEN_W = 272
const SCREEN_H = 240
const ACTIVE_W = 256
const ACTIVE_H = 192
const ORIGIN_X = (SCREEN_W - ACTIVE_W) / 2
const ORIGIN_Y = (SCREEN_H - ACTIVE_H) / 2
const COLS = 32
const ROWS = 24

type Mode = 'off' | 'splash' | 'basic' | 'attract'
/**
 * Instantes em que a abertura muda de aparência. O splash não é animação
 * contínua: `drawSplash()` acende elementos em degraus, como carga de VRAM, e
 * estes são exatamente os limiares dele. Só nesses cruzamentos há quadro novo
 * para desenhar — manter as duas listas em sincronia.
 */
const SPLASH_PHASES = [0.15, 0.45, 0.65, 0.85, 1.05, 1.3] as const

const PROCEDURAL_CHARACTERS_BY_CODE: Readonly<
  Record<string, readonly [normal: string, shifted: string]>
> = Object.freeze({
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Backslash: ['\\', '|'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  Backquote: ['~', '^'],
  Comma: [',', '<'],
  Period: ['.', '>'],
  Slash: ['/', '?'],
  IntlBackslash: ['\\', '|'],
  IntlRo: ['/', '?'],
  Cedilla: ['Ç', 'ç'],
  NumpadDecimal: ['.', '.'],
  NumpadAdd: ['+', '+'],
  NumpadSubtract: ['-', '-'],
  NumpadMultiply: ['*', '*'],
  NumpadDivide: ['/', '/'],
  NumpadEqual: ['=', '='],
})

/** Pares imprimíveis usados pelo fallback; exportado para a sonda de regressão. */
export function proceduralCharactersForCode(
  code: string,
): readonly [normal: string, shifted: string] | null {
  return PROCEDURAL_CHARACTERS_BY_CODE[code] ?? null
}

interface BasicValue {
  readonly text: string | null
  readonly num: number
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class ProceduralScreen implements ScreenSource {
  public readonly kind = 'procedural' as const
  public readonly width = ACTIVE_W
  public readonly height = ACTIVE_H
  /** Tamanho da textura de apresentação, incluindo a borda procedural. */
  public readonly presentationWidth = SCREEN_W
  public readonly presentationHeight = SCREEN_H
  /** Quadro cru do VDP, com identidade estável durante toda a vida da fonte. */
  public get texture(): THREE.Texture {
    return this.canvasTexture
  }

  private readonly canvasTexture: THREE.CanvasTexture

  private readonly ctx: CanvasRenderingContext2D
  private readonly image: ImageData
  private readonly rgba: Uint8ClampedArray
  /** Framebuffer em índices de paleta — como o VDP de verdade. */
  private readonly indices = new Uint8Array(SCREEN_W * SCREEN_H)
  private readonly paletteRGB: Uint8Array

  // Modelo de texto (SCREEN 1: 32×24 células de 8×8).
  private readonly cells = new Uint8Array(COLS * ROWS)
  private readonly cellFg = new Uint8Array(COLS * ROWS)
  private readonly cellBg = new Uint8Array(COLS * ROWS)

  private mode: Mode = 'off'
  private running = false
  private modeTime = 0
  private elapsed = 0
  private accumulator = 0
  private idleTime = 0
  private cursorCol = 0
  private cursorRow = 0
  private cursorVisible = true
  private fg: number = C.white
  private bg: number = C.darkBlue
  private inputLine = ''
  private readonly program = new Map<number, string>()
  private readonly variables = new Map<string, BasicValue>()
  private shift = false
  private control = false
  private caps = true
  private cartTitle: string | null = null
  private readonly cartridges = new Map<'A' | 'B', string>()
  private savedScreen: { cells: Uint8Array; fg: Uint8Array; bg: Uint8Array } | null = null
  private dirty = false
  private disposed = false

  public constructor() {
    const canvas = document.createElement('canvas')
    canvas.width = SCREEN_W
    canvas.height = SCREEN_H
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false })
    if (ctx === null) {
      throw new Error('ProceduralScreen: contexto 2D indisponível neste navegador.')
    }
    this.ctx = ctx
    this.image = ctx.createImageData(SCREEN_W, SCREEN_H)
    this.rgba = this.image.data

    this.paletteRGB = new Uint8Array(TMS9918_PALETTE.length * 3)
    for (let i = 0; i < TMS9918_PALETTE.length; i++) {
      const hex = TMS9918_PALETTE[i] ?? 0
      this.paletteRGB[i * 3] = (hex >> 16) & 0xff
      this.paletteRGB[i * 3 + 1] = (hex >> 8) & 0xff
      this.paletteRGB[i * 3 + 2] = hex & 0xff
    }

    const texture = new THREE.CanvasTexture(canvas)
    texture.name = 'msx-tela-procedural'
    texture.colorSpace = THREE.SRGBColorSpace
    texture.generateMipmaps = false
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.wrapS = THREE.ClampToEdgeWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    this.canvasTexture = texture

    this.clearIndices(C.black)
    this.blit()
  }

  // -------------------------------------------------------------------------
  // ScreenSource
  // -------------------------------------------------------------------------

  public start(signal?: AbortSignal): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('A tela procedural já foi descartada.'))
    }
    if (signal?.aborted === true) {
      return Promise.reject(new DOMException('Inicialização da tela cancelada.', 'AbortError'))
    }
    this.running = true
    this.enterSplash()
    return Promise.resolve()
  }

  public stop(): void {
    this.running = false
    this.mode = 'off'
    this.dirty = true
    this.flushFrame()
  }

  public reset(): void {
    if (!this.running) return
    this.program.clear()
    this.variables.clear()
    this.inputLine = ''
    this.cartTitle = this.cartridges.get('A') ?? this.cartridges.get('B') ?? null
    this.enterSplash()
  }

  public insertCartridge(slot: 'A' | 'B', romId: string): Promise<void> {
    if (!this.running) {
      return Promise.reject(new Error('Ligue o computador antes de carregar o cartucho.'))
    }
    if (
      romId !== 'arcade-vermelho' &&
      romId !== 'preto-generico' &&
      romId !== 'demo' &&
      romId !== 'gradiente-demo'
    ) {
      return Promise.reject(new Error(`Cartucho “${romId}” não disponível no emulador interno.`))
    }
    this.cartridges.set(slot, romId)
    this.reset()
    return Promise.resolve()
  }

  public ejectCartridge(slot: 'A' | 'B'): void {
    if (!this.running) return
    if (!this.cartridges.delete(slot)) return
    this.reset()
  }

  public update(dt: number): void {
    if (this.running) {
      this.accumulator += Math.min(dt, 0.25)
      const frame = 1 / 60
      let ticks = 0
      while (this.accumulator >= frame && ticks < 8) {
        this.accumulator -= frame
        this.tick(frame)
        ticks++
      }
      if (this.dirty) this.flushFrame()
    }
  }

  /**
   * `code` é um `KeyboardEvent.code` (posição física, layout US-ANSI), que é o
   * que tanto o teclado do host quanto as teclas 3D emitem. `Cedilla` é aceito
   * para o Ç do teclado brasileiro, que o Expert tem e o ANSI não.
   */
  public sendKey(code: string, down: boolean): void {
    if (!this.running || proceduralKeyForCode(code) === null) return
    if (code === 'ShiftLeft' || code === 'ShiftRight') {
      this.shift = down
      return
    }
    if (code === 'ControlLeft' || code === 'ControlRight') {
      this.control = down
      return
    }
    if (!down) return
    this.idleTime = 0

    if (code === 'CapsLock') {
      this.caps = !this.caps
      return
    }

    if (this.mode === 'attract') {
      this.leaveAttract()
      return
    }
    if (this.mode !== 'basic') return

    switch (code) {
      case 'Enter':
      case 'NumpadEnter':
        this.submitLine()
        return
      case 'Backspace':
        if (this.inputLine.length > 0) {
          this.inputLine = this.inputLine.slice(0, -1)
          this.moveCursorBack()
        }
        return
      case 'Escape':
        this.clearInputLine()
        return
      case 'Tab':
        this.typeText('    ')
        return
      case 'Home':
        this.cls()
        return
      case 'F1':
        this.typeText('color ')
        return
      case 'F2':
        this.typeText('auto ')
        return
      case 'F3':
        this.typeText('goto ')
        return
      case 'F4':
        this.typeText('list ')
        return
      case 'F5':
        this.typeText('run')
        this.submitLine()
        return
      default:
        break
    }

    if (this.control) return
    const ch = this.charFor(code)
    if (ch !== null) this.typeText(ch)
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.canvasTexture.dispose()
  }

  // -------------------------------------------------------------------------
  // Relógio
  // -------------------------------------------------------------------------

  private tick(dt: number): void {
    const previousModeTime = this.modeTime
    this.elapsed += dt
    this.modeTime += dt

    switch (this.mode) {
      case 'splash':
        // A BIOS segura o logo por ~2,2 s antes de entregar o BASIC.
        if (this.modeTime > 2.2) this.enterBasic()
        else if (
          SPLASH_PHASES.some(
            (threshold) => previousModeTime <= threshold && this.modeTime > threshold,
          )
        ) {
          this.dirty = true
        }
        break
      case 'basic':
        this.idleTime += dt
        if (this.idleTime > 45) this.enterAttract()
        break
      case 'attract':
        this.dirty = true
        break
      case 'off':
        break
    }

    // Cursor do MSX: ~1,7 Hz, meio a meio.
    const cursorVisible = Math.floor(this.elapsed / 0.3) % 2 === 0
    if (cursorVisible !== this.cursorVisible) {
      this.cursorVisible = cursorVisible
      this.dirty = true
    }
  }

  // -------------------------------------------------------------------------
  // Modos
  // -------------------------------------------------------------------------

  private enterSplash(): void {
    this.mode = 'splash'
    this.modeTime = 0
    this.idleTime = 0
    this.fg = C.white
    this.bg = C.darkBlue
    this.dirty = true
  }

  private enterBasic(): void {
    this.mode = 'basic'
    this.modeTime = 0
    this.idleTime = 0
    this.fg = C.white
    this.bg = C.darkBlue
    this.clearCells()
    this.cursorCol = 0
    this.cursorRow = 0
    this.inputLine = ''

    // Tela de boot do MSX BASIC 1.0 num MSX1 de 64 KB.
    this.printLine('MSX BASIC version 1.0')
    this.printLine('Copyright 1983 by Microsoft')
    this.printLine('')
    if (this.cartTitle !== null) {
      this.printLine(`Cartucho: ${this.cartTitle.toUpperCase()}`)
      this.printLine('')
    }
    this.printLine('28815 Bytes free')
    this.printLine('')
    this.printLine('Ok')
    this.dirty = true
  }

  private enterAttract(): void {
    this.savedScreen = {
      cells: this.cells.slice(),
      fg: this.cellFg.slice(),
      bg: this.cellBg.slice(),
    }
    this.mode = 'attract'
    this.modeTime = 0
    this.dirty = true
  }

  private leaveAttract(): void {
    const saved = this.savedScreen
    if (saved !== null) {
      this.cells.set(saved.cells)
      this.cellFg.set(saved.fg)
      this.cellBg.set(saved.bg)
      this.savedScreen = null
    }
    this.mode = 'basic'
    this.modeTime = 0
    this.idleTime = 0
    this.dirty = true
  }

  // -------------------------------------------------------------------------
  // Desenho
  // -------------------------------------------------------------------------

  private draw(): void {
    switch (this.mode) {
      case 'off':
        this.clearIndices(C.black)
        break
      case 'splash':
        this.drawSplash()
        break
      case 'basic':
        this.drawTextScreen()
        break
      case 'attract':
        this.drawAttract()
        break
    }
  }

  /** Abertura da máquina: marca Gradiente antes de o BASIC assumir. */
  private drawSplash(): void {
    const t = this.modeTime
    this.clearIndices(C.black)

    // O VDP não faz fade: os elementos entram em degraus, como carga de VRAM.
    if (t > 0.15) {
      this.text2x(32, 44, 'GRADIENTE', C.white)
    }
    if (t > 0.45) {
      this.rect(32, 66, 152, 2, C.cyan)
      this.rect(32, 69, 96, 1, C.darkBlue)
    }
    if (t > 0.65) {
      this.text(32, 78, 'EXPERT XP-800', C.cyan)
    }
    if (t > 0.85) {
      this.text(32, 96, 'PERSONAL COMPUTER', C.grey)
      this.text(32, 108, 'INDÚSTRIA BRASILEIRA', C.grey)
    }
    if (t > 1.05) {
      // Selo MSX: caixa vermelha, tipo branco, canto superior direito.
      this.rect(196, 40, 32, 14, C.red)
      this.text(200, 43, 'MSX', C.white)
    }
    if (t > 1.3) {
      // Barra de cores: as 15 do TMS9918 em sequência, como um teste de VDP.
      for (let i = 1; i < 16; i++) {
        this.rect(32 + (i - 1) * 10, 140, 9, 8, i)
      }
      this.text(32, 156, '64K RAM  16K VRAM', C.grey)
    }
  }

  /** Tela de texto do BASIC, com cursor piscando. */
  private drawTextScreen(): void {
    this.clearIndices(this.bg)
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const i = row * COLS + col
        const glyph = this.cells[i] ?? GLYPH_SPACE
        const fg = this.cellFg[i] ?? this.fg
        const bg = this.cellBg[i] ?? this.bg
        this.glyph(col * 8, row * 8, glyph, fg, bg)
      }
    }
    if (this.cursorVisible) {
      this.glyph(this.cursorCol * 8, this.cursorRow * 8, GLYPH_BLOCK, this.fg, this.bg)
    }
  }

  /**
   * Modo de demonstração. Três cenas em rodízio, todas dentro do que um MSX1
   * conseguiria: barras de raster, campo de estrelas e a carta de cores do VDP.
   */
  private drawAttract(): void {
    const t = this.modeTime
    const scene = Math.floor(t / 9) % 3
    this.clearIndices(C.black)

    if (scene === 0) this.attractLogo(t)
    else if (scene === 1) this.attractStars(t)
    else this.attractPalette(t)

    this.attractScroller(t)
  }

  private attractLogo(t: number): void {
    // Barras de raster atrás do logo, ciclando as cores quentes da paleta.
    const bars = [C.darkBlue, C.lightBlue, C.cyan, C.lightGreen, C.green, C.darkGreen]
    for (let y = 40; y < 104; y++) {
      const phase = y * 0.12 + t * 2.4
      const idx = Math.floor(Math.abs(Math.sin(phase)) * bars.length) % bars.length
      const colour = bars[idx] ?? C.darkBlue
      const w = 200 - Math.round(Math.abs(Math.sin(y * 0.05 + t)) * 24)
      this.rect(128 - w / 2, y, w, 1, colour)
    }
    const bob = Math.round(Math.sin(t * 2.1) * 3)
    this.text2x(48, 56 + bob, 'GRADIENTE', C.white)
    this.text(76, 82 + bob, 'EXPERT XP-800', C.black)
    this.text(16, 124, 'MSX  ·  Z80A 3.58 MHz  ·  64K', C.grey)
    this.text(16, 136, 'TMS9918  ·  AY-3-8910', C.grey)
  }

  private attractStars(t: number): void {
    // Campo de estrelas em três planos, do jeito que se fazia com sprites.
    for (let layer = 0; layer < 3; layer++) {
      const speed = 18 + layer * 26
      const colour = layer === 0 ? C.grey : layer === 1 ? C.lightBlue : C.white
      for (let i = 0; i < 28; i++) {
        const seed = layer * 97 + i * 31
        const y = (seed * 7) % ACTIVE_H
        const x = Math.floor(ACTIVE_W - (((seed * 13) % ACTIVE_W) + t * speed) % ACTIVE_W)
        this.plot(x, y, colour)
      }
    }
    const cx = 128 + Math.round(Math.sin(t * 1.3) * 54)
    const cy = 96 + Math.round(Math.cos(t * 0.9) * 34)
    this.rect(cx - 30, cy - 10, 60, 20, C.red)
    this.rect(cx - 28, cy - 8, 56, 16, C.black)
    this.text(cx - 25, cy - 4, 'XP-800', C.white)
  }

  private attractPalette(t: number): void {
    this.text(48, 16, 'TMS9918  ·  15 CORES', C.white)
    for (let i = 1; i < 16; i++) {
      const col = (i - 1) % 5
      const row = Math.floor((i - 1) / 5)
      const x = 24 + col * 44
      const y = 40 + row * 40
      const pulse = Math.floor(t * 6) % 15 === i - 1 ? 2 : 0
      this.rect(x - pulse, y - pulse, 36 + pulse * 2, 24 + pulse * 2, i)
      this.text(x + 4, y + 28, i.toString().padStart(2, '0'), C.grey)
    }
  }

  /** Scroller senoidal, o cartão de visita de qualquer demo de 8 bits. */
  private attractScroller(t: number): void {
    const message =
      this.cartTitle !== null
        ? `CARTUCHO ${this.cartTitle.toUpperCase()} INSERIDO  ·  APERTE QUALQUER TECLA  ·  `
        : 'GRADIENTE EXPERT XP-800  ·  MSX  ·  INDÚSTRIA BRASILEIRA  ·  1985  ·  APERTE QUALQUER TECLA  ·  '
    const speed = 42
    const total = message.length * 8
    const offset = Math.floor((t * speed) % total)
    for (let i = 0; i < message.length; i++) {
      const x = i * 8 - offset
      if (x < -8 || x > ACTIVE_W) continue
      const y = 168 + Math.round(Math.sin((x + t * speed) * 0.045) * 8)
      const ch = message[i]
      if (ch === undefined) continue
      const colour = Math.floor((i + t * 8) % 3) === 0 ? C.lightYellow : C.white
      this.glyph(x, y, glyphOf(ch), colour, C.transparent)
    }
  }

  // -------------------------------------------------------------------------
  // Primitivas de framebuffer
  // -------------------------------------------------------------------------

  private clearIndices(colour: number): void {
    this.indices.fill(colour)
  }

  // As primitivas trabalham em coordenadas da área ativa (0..255, 0..191) e
  // deslocam para dentro do quadro do sinal. Nada desenha na borda a não ser
  // `clearIndices`, que é justamente o backdrop do VDP.
  private plot(x: number, y: number, colour: number): void {
    if (x < 0 || y < 0 || x >= ACTIVE_W || y >= ACTIVE_H) return
    this.indices[(y + ORIGIN_Y) * SCREEN_W + (x + ORIGIN_X)] = colour
  }

  private rect(x: number, y: number, w: number, h: number, colour: number): void {
    const x0 = Math.max(0, Math.round(x))
    const y0 = Math.max(0, Math.round(y))
    const x1 = Math.min(ACTIVE_W, Math.round(x + w))
    const y1 = Math.min(ACTIVE_H, Math.round(y + h))
    for (let py = y0; py < y1; py++) {
      const base = (py + ORIGIN_Y) * SCREEN_W + ORIGIN_X
      for (let px = x0; px < x1; px++) this.indices[base + px] = colour
    }
  }

  /** Desenha um glifo. `bg = 0` (transparente) preserva o fundo. */
  private glyph(x: number, y: number, index: number, fg: number, bg: number): void {
    if (index < 0 || index >= GLYPH_COUNT) return
    const base = index * 8
    for (let row = 0; row < 8; row++) {
      const bits = FONT[base + row] ?? 0
      const py = y + row
      if (py < 0 || py >= ACTIVE_H) continue
      const lineBase = (py + ORIGIN_Y) * SCREEN_W + ORIGIN_X
      for (let col = 0; col < 8; col++) {
        const on = (bits & (0x80 >> col)) !== 0
        if (!on && bg === C.transparent) continue
        const px = x + col
        if (px < 0 || px >= ACTIVE_W) continue
        this.indices[lineBase + px] = on ? fg : bg
      }
    }
  }

  private text(x: number, y: number, str: string, fg: number, bg = C.transparent): void {
    for (let i = 0; i < str.length; i++) {
      const ch = str[i]
      if (ch === undefined) continue
      this.glyph(x + i * 8, y, glyphOf(ch), fg, bg)
    }
  }

  /** Texto em dobro — o truque de sempre para um título num VDP de 8 bits. */
  private text2x(x: number, y: number, str: string, fg: number): void {
    for (let i = 0; i < str.length; i++) {
      const ch = str[i]
      if (ch === undefined) continue
      const index = glyphOf(ch)
      if (index < 0 || index >= GLYPH_COUNT) continue
      const base = index * 8
      for (let row = 0; row < 8; row++) {
        const bits = FONT[base + row] ?? 0
        for (let col = 0; col < 8; col++) {
          if ((bits & (0x80 >> col)) === 0) continue
          const px = x + i * 16 + col * 2
          const py = y + row * 2
          this.plot(px, py, fg)
          this.plot(px + 1, py, fg)
          this.plot(px, py + 1, fg)
          this.plot(px + 1, py + 1, fg)
        }
      }
    }
  }

  /** Expande o framebuffer de índices para RGBA e sobe para a textura. */
  private blit(): void {
    const rgba = this.rgba
    const palette = this.paletteRGB
    const indices = this.indices
    for (let i = 0; i < indices.length; i++) {
      const c = (indices[i] ?? 0) * 3
      const o = i * 4
      rgba[o] = palette[c] ?? 0
      rgba[o + 1] = palette[c + 1] ?? 0
      rgba[o + 2] = palette[c + 2] ?? 0
      rgba[o + 3] = 255
    }
    this.ctx.putImageData(this.image, 0, 0)
    this.canvasTexture.needsUpdate = true
    this.dirty = false
  }

  private flushFrame(): void {
    if (!this.dirty) return
    this.draw()
    this.blit()
  }

  // -------------------------------------------------------------------------
  // Terminal de texto
  // -------------------------------------------------------------------------

  private clearCells(): void {
    this.cells.fill(GLYPH_SPACE)
    this.cellFg.fill(this.fg)
    this.cellBg.fill(this.bg)
    this.dirty = true
  }

  private cls(): void {
    this.clearCells()
    this.cursorCol = 0
    this.cursorRow = 0
    this.inputLine = ''
    this.dirty = true
  }

  private putChar(ch: string): void {
    if (ch === '\n') {
      this.newline()
      return
    }
    const i = this.cursorRow * COLS + this.cursorCol
    this.cells[i] = glyphOf(ch)
    this.cellFg[i] = this.fg
    this.cellBg[i] = this.bg
    this.cursorCol++
    if (this.cursorCol >= COLS) {
      this.cursorCol = 0
      this.advanceRow()
    }
    this.dirty = true
  }

  private newline(): void {
    this.cursorCol = 0
    this.advanceRow()
    this.dirty = true
  }

  private advanceRow(): void {
    this.cursorRow++
    this.dirty = true
    if (this.cursorRow < ROWS) return
    this.cursorRow = ROWS - 1
    this.scroll()
  }

  private scroll(): void {
    this.cells.copyWithin(0, COLS)
    this.cellFg.copyWithin(0, COLS)
    this.cellBg.copyWithin(0, COLS)
    const last = (ROWS - 1) * COLS
    this.cells.fill(GLYPH_SPACE, last)
    this.cellFg.fill(this.fg, last)
    this.cellBg.fill(this.bg, last)
    this.dirty = true
  }

  private print(str: string): void {
    for (const ch of str) this.putChar(ch)
  }

  private printLine(str: string): void {
    this.print(str)
    this.newline()
  }

  private typeText(str: string): void {
    for (const ch of str) {
      if (this.inputLine.length >= COLS * 2 - 1) break
      this.inputLine += ch
      this.putChar(ch)
    }
  }

  private moveCursorBack(): void {
    if (this.cursorCol > 0) {
      this.cursorCol--
    } else if (this.cursorRow > 0) {
      this.cursorRow--
      this.cursorCol = COLS - 1
    }
    const i = this.cursorRow * COLS + this.cursorCol
    this.cells[i] = GLYPH_SPACE
    this.dirty = true
  }

  private clearInputLine(): void {
    while (this.inputLine.length > 0) {
      this.inputLine = this.inputLine.slice(0, -1)
      this.moveCursorBack()
    }
  }

  // -------------------------------------------------------------------------
  // Teclado
  // -------------------------------------------------------------------------

  private charFor(code: string): string | null {
    if (code === 'Space') return ' '

    const letter = /^Key([A-Z])$/.exec(code)
    if (letter !== null) {
      const base = letter[1]
      if (base === undefined) return null
      // O MSX liga com CAPS aceso — é por isso que toda listagem da época é
      // em maiúsculas. SHIFT inverte, como no aparelho.
      const upper = this.caps !== this.shift
      return upper ? base : base.toLowerCase()
    }

    const digit = /^Digit([0-9])$/.exec(code)
    if (digit !== null) {
      const d = digit[1]
      if (d === undefined) return null
      if (!this.shift) return d
      const shifted = ')!@#$%^&*('
      return shifted[Number.parseInt(d, 10)] ?? d
    }

    const numpad = /^Numpad([0-9])$/.exec(code)
    if (numpad !== null) return numpad[1] ?? null

    const pair = proceduralCharactersForCode(code)
    if (pair === null) return null
    if (code === 'Cedilla') return this.caps !== this.shift ? pair[0] : pair[1]
    return this.shift ? pair[1] : pair[0]
  }

  // -------------------------------------------------------------------------
  // BASIC mínimo
  // -------------------------------------------------------------------------

  private submitLine(): void {
    const line = this.inputLine
    this.inputLine = ''
    this.newline()
    if (line.trim().length === 0) {
      this.printLine('Ok')
      return
    }
    this.execute(line.trim())
    this.printLine('Ok')
  }

  private execute(line: string): void {
    // Linha numerada entra no programa em vez de rodar (BASIC clássico).
    const numbered = /^(\d+)\s*(.*)$/.exec(line)
    if (numbered !== null) {
      const num = Number.parseInt(numbered[1] ?? '0', 10)
      const body = (numbered[2] ?? '').trim()
      if (body.length === 0) this.program.delete(num)
      else this.program.set(num, body)
      return
    }
    this.runStatement(line)
  }

  private runStatement(statement: string): void {
    const trimmed = statement.trim()
    if (trimmed.length === 0) return
    const head = /^([A-Za-zÇ][A-Za-z0-9$Ç]*)\s*(.*)$/.exec(trimmed)
    const keyword = (head?.[1] ?? '').toUpperCase()
    const rest = head?.[2] ?? ''

    switch (keyword) {
      case 'CLS':
        this.cls()
        return
      case 'NEW':
        this.program.clear()
        this.variables.clear()
        return
      case 'LIST': {
        const numbers = [...this.program.keys()].sort((a, b) => a - b)
        for (const n of numbers) this.printLine(`${n} ${this.program.get(n) ?? ''}`)
        return
      }
      case 'RUN':
        this.runProgram()
        return
      case 'REM':
        return
      case 'END':
      case 'STOP':
        return
      case 'BEEP':
        return
      case 'PRINT':
        this.doPrint(rest)
        return
      case 'COLOR':
        this.doColor(rest)
        return
      default:
        break
    }

    // Atribuição simples: `A=5`, `A$="OI"`, com ou sem LET.
    const assign = /^(?:LET\s+)?([A-Za-z][A-Za-z0-9]*\$?)\s*=\s*(.+)$/.exec(trimmed)
    if (assign !== null) {
      const name = (assign[1] ?? '').toUpperCase()
      const value = this.evaluate(assign[2] ?? '')
      if (value === null) {
        this.printLine('Syntax error')
        return
      }
      this.variables.set(name, value)
      return
    }

    this.printLine('Syntax error')
  }

  private runProgram(): void {
    const numbers = [...this.program.keys()].sort((a, b) => a - b)
    for (const n of numbers) {
      const body = this.program.get(n)
      if (body !== undefined) this.runStatement(body)
    }
  }

  private doPrint(rest: string): void {
    if (rest.trim().length === 0) {
      this.newline()
      return
    }
    // Separadores do BASIC: `;` cola, `,` tabula em colunas de 14.
    const parts = this.splitArguments(rest)
    let trailing = false
    for (const part of parts) {
      if (part.separator === null && part.text.trim().length === 0) continue
      if (part.text.trim().length > 0) {
        const value = this.evaluate(part.text)
        if (value === null) {
          this.printLine('Syntax error')
          return
        }
        this.print(formatValue(value))
      }
      if (part.separator === ',') {
        const pad = 14 - (this.cursorCol % 14)
        this.print(' '.repeat(pad))
        trailing = true
      } else if (part.separator === ';') {
        trailing = true
      } else {
        trailing = false
      }
    }
    if (!trailing) this.newline()
  }

  private doColor(rest: string): void {
    const args = rest.split(',').map((s) => s.trim())
    const fg = args[0] !== undefined && args[0].length > 0 ? Number.parseInt(args[0], 10) : this.fg
    const bg = args[1] !== undefined && args[1].length > 0 ? Number.parseInt(args[1], 10) : this.bg
    if (!Number.isFinite(fg) || !Number.isFinite(bg) || fg < 0 || fg > 15 || bg < 0 || bg > 15) {
      this.printLine('Illegal function call')
      return
    }
    this.fg = fg === 0 ? C.black : fg
    this.bg = bg === 0 ? C.black : bg
    for (let i = 0; i < this.cells.length; i++) {
      if ((this.cells[i] ?? GLYPH_SPACE) === GLYPH_SPACE) this.cellFg[i] = this.fg
      this.cellBg[i] = this.bg
    }
    this.dirty = true
  }

  /** Quebra a lista de argumentos do PRINT respeitando literais entre aspas. */
  private splitArguments(rest: string): ReadonlyArray<{ text: string; separator: ',' | ';' | null }> {
    const out: Array<{ text: string; separator: ',' | ';' | null }> = []
    let current = ''
    let inString = false
    for (const ch of rest) {
      if (ch === '"') inString = !inString
      if (!inString && (ch === ',' || ch === ';')) {
        out.push({ text: current, separator: ch })
        current = ''
        continue
      }
      current += ch
    }
    if (current.trim().length > 0) out.push({ text: current, separator: null })
    return out
  }

  /** Avaliador mínimo: literais, variáveis, `+ - * /` e parênteses. */
  private evaluate(expression: string): BasicValue | null {
    const tokens = tokenize(expression)
    if (tokens === null) return null
    const parser = new ExpressionParser(tokens, this.variables)
    const value = parser.parseExpression()
    if (value === null || !parser.atEnd()) return null
    return value
  }
}

// ---------------------------------------------------------------------------
// Avaliador de expressões
// ---------------------------------------------------------------------------

type Token =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'op'; readonly value: string }

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === undefined) break
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }
    if (ch === '"') {
      let value = ''
      i++
      while (i < input.length && input[i] !== '"') {
        value += input[i] ?? ''
        i++
      }
      if (i >= input.length) return null
      i++
      tokens.push({ kind: 'string', value })
      continue
    }
    if (ch >= '0' && ch <= '9') {
      let value = ''
      while (i < input.length) {
        const c = input[i] ?? ''
        if ((c >= '0' && c <= '9') || c === '.') {
          value += c
          i++
        } else break
      }
      const num = Number.parseFloat(value)
      if (!Number.isFinite(num)) return null
      tokens.push({ kind: 'number', value: num })
      continue
    }
    if (/[A-Za-z]/.test(ch)) {
      let value = ''
      while (i < input.length && /[A-Za-z0-9$]/.test(input[i] ?? '')) {
        value += input[i] ?? ''
        i++
      }
      tokens.push({ kind: 'name', value: value.toUpperCase() })
      continue
    }
    if ('+-*/()'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch })
      i++
      continue
    }
    return null
  }
  return tokens
}

class ExpressionParser {
  private index = 0

  public constructor(
    private readonly tokens: readonly Token[],
    private readonly variables: ReadonlyMap<string, BasicValue>,
  ) {}

  public atEnd(): boolean {
    return this.index >= this.tokens.length
  }

  public parseExpression(): BasicValue | null {
    let left = this.parseTerm()
    if (left === null) return null
    for (;;) {
      const token = this.peek()
      if (token === null || token.kind !== 'op') break
      if (token.value !== '+' && token.value !== '-') break
      this.index++
      const right = this.parseTerm()
      if (right === null) return null
      if (left.text !== null || right.text !== null) {
        if (token.value !== '+' || left.text === null || right.text === null) return null
        left = { text: left.text + right.text, num: 0 }
      } else {
        left = { text: null, num: token.value === '+' ? left.num + right.num : left.num - right.num }
      }
    }
    return left
  }

  private parseTerm(): BasicValue | null {
    let left = this.parseFactor()
    if (left === null) return null
    for (;;) {
      const token = this.peek()
      if (token === null || token.kind !== 'op') break
      if (token.value !== '*' && token.value !== '/') break
      this.index++
      const right = this.parseFactor()
      if (right === null || right.text !== null || left.text !== null) return null
      if (token.value === '/' && right.num === 0) return null
      left = { text: null, num: token.value === '*' ? left.num * right.num : left.num / right.num }
    }
    return left
  }

  private parseFactor(): BasicValue | null {
    const token = this.peek()
    if (token === null) return null
    if (token.kind === 'op' && token.value === '-') {
      this.index++
      const inner = this.parseFactor()
      if (inner === null || inner.text !== null) return null
      return { text: null, num: -inner.num }
    }
    if (token.kind === 'op' && token.value === '(') {
      this.index++
      const inner = this.parseExpression()
      if (inner === null) return null
      const close = this.peek()
      if (close === null || close.kind !== 'op' || close.value !== ')') return null
      this.index++
      return inner
    }
    if (token.kind === 'number') {
      this.index++
      return { text: null, num: token.value }
    }
    if (token.kind === 'string') {
      this.index++
      return { text: token.value, num: 0 }
    }
    if (token.kind === 'name') {
      this.index++
      // Variável nunca atribuída vale 0 (ou string vazia), como no MSX BASIC.
      return this.variables.get(token.value) ?? { text: token.value.endsWith('$') ? '' : null, num: 0 }
    }
    return null
  }

  private peek(): Token | null {
    return this.tokens[this.index] ?? null
  }
}

/** Formatação numérica do MSX BASIC: sinal à esquerda, espaço à direita. */
function formatValue(value: BasicValue): string {
  if (value.text !== null) return value.text
  const n = value.num
  const body = Number.isInteger(n) ? n.toFixed(0) : String(Number(n.toPrecision(9)))
  return `${n < 0 ? '' : ' '}${body} `
}
