import * as THREE from 'three'

import type { ScreenSource } from '../core/types.ts'
import { webMsxKeyForCode } from './Keymap.ts'
import { buildSuperCosmicoRom } from './SuperCosmicoRom.ts'

/**
 * Ponte para o WebMSX — o caminho principal do `ScreenSource` (SPEC §9).
 *
 * ## Restrição jurídica, leia antes de mexer
 *
 * **O WebMSX não declara licença.** `gh api repos/ppeccin/WebMSX --jq '.license'`
 * devolve `null` e o `license.txt` citado nos cabeçalhos não é distribuído em
 * lugar nenhum: vale o direito autoral padrão, todos os direitos reservados.
 * Por isso o emulador é **carregado em tempo de execução** de uma URL do
 * jsDelivr fixada por commit e verificada por SRI, e **nada é redistribuído**.
 *
 * Nunca copie `wmsx.js` para `public/`, nunca faça bundle, nunca proxie. Se
 * precisar de operação offline, use `ProceduralScreen.ts`.
 *
 * Só a build **C-BIOS**. Nenhuma ROM de BIOS de MSX com direitos autorais é
 * distribuída por este projeto.
 *
 * ## Como isto funciona
 *
 * O script é injetado sob demanda (só na energização, nunca no load da página —
 * são 1,5 MB), monta o WebMSX num contêiner fora de tela, e o `<canvas>` da tela
 * do emulador vira uma `THREE.CanvasTexture`. A partir daí o
 * `ScreenPipeline` trata do vidro.
 *
 * O WebMSX 6.0 desenha em contexto **2D** (`CanvasDisplay` usa `getContext('2d')`,
 * sem WebGL), então não há questão de `preserveDrawingBuffer` — mas *há* risco de
 * canvas contaminado se alguma build futura desenhar imagem de outra origem. O
 * teste é explícito em {@link WebMsxBridge.probeCanvasTaint}, e a falha é
 * tratada, não presumida.
 */

/** URL fixada por commit + SRI, conforme SPEC §9. Não altere sem reverificar. */
export const WEBMSX_SCRIPT_URL =
  'https://cdn.jsdelivr.net/gh/ppeccin/WebMSX@4f4009e86d3e0bb9be7dcd7f0a582b0cd411d660/release/stable/6.0/cbios/embedded/wmsx.js'

/** Integridade do arquivo acima, verificada byte a byte contra o upstream. */
export const WEBMSX_SCRIPT_INTEGRITY =
  'sha384-ZrKfFA57c2hR6DHPG3q0c55xd7wx70ZQLpoWj87znFJaebQcxkKRDJQxZFh+B49S'

/** Largura do sinal do V9918 em pixels lógicos (`wmsx.VDP.SIGNAL_WIDTH_V9918`). */
const MSX1_SIGNAL_WIDTH = 272

/** Toque mínimo de uma tecla, em ms — pelo menos duas varreduras da matriz. */
const MIN_KEY_HOLD_MS = 50

const SCREEN_ELEMENT_ID = 'gradiente-wmsx-screen'
const SCREEN_CANVAS_ID = 'wmsx-screen-canvas'

/** Motivos pelos quais o caminho principal pode cair para o procedural. */
export type WebMsxFailure =
  | 'sem-dom'
  | 'offline'
  | 'script-bloqueado'
  | 'tempo-esgotado'
  | 'api-ausente'
  | 'canvas-ausente'
  | 'canvas-contaminado'
  | 'erro-interno'

export class WebMsxUnavailableError extends Error {
  public constructor(
    public readonly reason: WebMsxFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'WebMsxUnavailableError'
  }
}

function abortError(): DOMException {
  return new DOMException('Inicialização do emulador cancelada.', 'AbortError')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError()
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function forwardAbort(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (source === undefined) return () => undefined
  const abort = (): void => target.abort()
  if (source.aborted) abort()
  else source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      cleanup()
      reject(abortError())
    }
    const cleanup = (): void => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

export interface WebMsxBridgeOptions {
  /** Milissegundos até desistir do carregamento do script. Padrão 15000. */
  readonly loadTimeoutMs?: number
  /** Milissegundos até desistir de achar o canvas depois do start. Padrão 8000. */
  readonly bootTimeoutMs?: number
  /** Volume mestre 0..1. Padrão 0.7. */
  readonly volume?: number
  /**
   * Paleta do VDP: 0 WebMSX, 1 V9918, 2 V9928, 3 V9938, 4 Toshiba, 5 Fujitsu.
   * Padrão 1 — o Expert traz um TMS9918 de verdade.
   */
  readonly vdpPalette?: number
  /**
   * Resolve um id de cartucho para o conteúdo binário da ROM. Sem provedor, só
   * a ROM de demonstração escrita neste repositório está disponível — nenhuma
   * ROM de terceiros acompanha o projeto.
   */
  readonly romProvider?: (romId: string) => Promise<Uint8Array | null>
  /** Recebe avisos para a UI, em pt-BR. */
  readonly onNotice?: (message: string) => void
}

// ---------------------------------------------------------------------------
// Guardas de tipo sobre a API do WebMSX (sem tipagem oficial, tudo é `unknown`)
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null
}

function pick(source: unknown, key: string): unknown {
  return isDict(source) ? source[key] : undefined
}

function pickPath(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source
  for (const key of path) {
    current = pick(current, key)
    if (current === undefined) return undefined
  }
  return current
}

function callMethod(owner: unknown, key: string, args: readonly unknown[]): boolean {
  const fn = pick(owner, key)
  if (typeof fn !== 'function') return false
  try {
    ;(fn as (...rest: unknown[]) => unknown).apply(owner, args as unknown[])
    return true
  } catch (error) {
    console.warn(`[WebMSX] falha ao chamar ${key}()`, error)
    return false
  }
}

// ---------------------------------------------------------------------------
// ROM de demonstração — código nosso, 100% autoral
// ---------------------------------------------------------------------------

/**
 * Cartucho de 16 KB escrito aqui, byte a byte: cabeçalho `AB`, rotina INIT que
 * põe o VDP em modo texto, imprime uma abertura da máquina via CHPUT e depois
 * fica ecoando o que for digitado (CHGET → CHPUT).
 *
 * Existe por dois motivos. Primeiro, não distribuímos ROM de ninguém, e mesmo
 * assim os slots A e B precisam fazer algo verdadeiro. Segundo, e mais
 * importante: **o C-BIOS não tem BASIC**. Sem cartucho ele exibe "No cartridge
 * found. This version of C-BIOS can only start cartridges." — que seria a tela
 * padrão da máquina. Com este cartucho, o caminho principal acorda mostrando um
 * Z80 de verdade rodando código nosso.
 *
 * O programa nunca retorna: no MSX quem assume no INIT do cartucho é dono da
 * máquina, e com C-BIOS não há BASIC para onde voltar.
 */
export interface DemoRomOptions {
  readonly lines?: readonly string[]
  /** Cor do texto na paleta TMS9918 (0..15). */
  readonly foreground?: number
  /** Cor do fundo na paleta TMS9918 (0..15). */
  readonly background?: number
  /** Cor da borda na paleta TMS9918 (0..15). */
  readonly border?: number
}

const DEFAULT_DEMO_LINES: readonly string[] = [
    'GRADIENTE EXPERT XP-800',
    'MSX PERSONAL COMPUTER',
    '',
    '64K RAM    16K VRAM',
    'INDUSTRIA BRASILEIRA  1985',
    '',
    'Ok',
  ]

export function buildDemoRom(lines?: readonly string[]): Uint8Array
export function buildDemoRom(options?: DemoRomOptions): Uint8Array
export function buildDemoRom(
  optionsOrLines: DemoRomOptions | readonly string[] = {},
): Uint8Array {
  const options: DemoRomOptions = Array.isArray(optionsOrLines)
    ? { lines: optionsOrLines as readonly string[] }
    : optionsOrLines as DemoRomOptions
  const lines = options.lines ?? DEFAULT_DEMO_LINES
  const foreground = clampPaletteIndex(options.foreground ?? 15)
  const background = clampPaletteIndex(options.background ?? 4)
  const border = clampPaletteIndex(options.border ?? background)
  const ORIGIN = 0x4000
  const INIT = 0x4010
  const code: number[] = []
  const here = (): number => INIT + code.length

  code.push(0x3e, foreground, 0x32, 0xe9, 0xf3) // ld a,fg : ld (FORCLR),a
  code.push(0x3e, background, 0x32, 0xea, 0xf3) // ld a,bg : ld (BAKCLR),a
  code.push(0x3e, border, 0x32, 0xeb, 0xf3) // ld a,border : ld (BDRCLR),a
  code.push(0xcd, 0x6c, 0x00) //             call INITXT (0x006C) — modo texto

  const ldHlAt = code.length
  code.push(0x21, 0x00, 0x00) //             ld hl,MSG (preenchido no fim)

  const printLoop = here()
  code.push(0x7e) //                         ld a,(hl)
  code.push(0xb7) //                         or a
  const jrZAt = code.length
  code.push(0x28, 0x00) //                   jr z,INPUT
  code.push(0xe5) //                         push hl
  code.push(0xcd, 0xa2, 0x00) //             call CHPUT (0x00A2)
  code.push(0xe1) //                         pop hl
  code.push(0x23) //                         inc hl
  code.push(0x18, (printLoop - (here() + 2)) & 0xff) // jr printLoop

  const input = here()
  code[jrZAt + 1] = (input - (INIT + jrZAt + 2)) & 0xff
  code.push(0xcd, 0x9f, 0x00) //             call CHGET (0x009F) — espera tecla
  code.push(0xcd, 0xa2, 0x00) //             call CHPUT — ecoa
  code.push(0x18, (input - (here() + 2)) & 0xff) // jr input

  const msgAddr = here()
  code[ldHlAt + 1] = msgAddr & 0xff
  code[ldHlAt + 2] = (msgAddr >> 8) & 0xff
  for (const line of lines) {
    for (const ch of line) code.push(ch.charCodeAt(0) & 0x7f)
    code.push(0x0d, 0x0a)
  }
  code.push(0x00)

  const rom = new Uint8Array(0x4000)
  // Cabeçalho de cartucho MSX: 'AB', INIT, STATEMENT, DEVICE, TEXT, reservado.
  rom[0] = 0x41
  rom[1] = 0x42
  rom[2] = INIT & 0xff
  rom[3] = (INIT >> 8) & 0xff
  for (let i = 0; i < code.length; i++) rom[INIT - ORIGIN + i] = code[i] ?? 0
  return rom
}

function clampPaletteIndex(value: number): number {
  return Math.max(0, Math.min(15, Math.round(value)))
}

// ---------------------------------------------------------------------------
// Ponte
// ---------------------------------------------------------------------------

export class WebMsxBridge implements ScreenSource {
  public readonly kind = 'webmsx' as const

  private canvas: HTMLCanvasElement | null = null
  private container: HTMLDivElement | null = null
  private canvasTexture: THREE.CanvasTexture | null = null
  private readonly placeholder: THREE.DataTexture
  private readonly options: WebMsxBridgeOptions
  private readonly pressed = new Set<string>()
  private readonly pressedAt = new Map<string, number>()
  private readonly releaseTimers = new Map<string, number>()
  private mounted = false
  private machineCreated = false
  private powered = false
  private disposed = false
  private startController: AbortController | null = null
  private startPromise: Promise<void> | null = null
  private lateAutoStartTimer: number | null = null
  /** Tamanho do buffer do canvas, usado só para detectar troca de modo. */
  private canvasSize = { width: 544, height: 416 }
  /** Tamanho lógico do sinal — é o que o tubo precisa saber. */
  private logicalSize = { width: 272, height: 208 }

  public constructor(options: WebMsxBridgeOptions = {}) {
    this.options = options
    // Textura de espera: um preto levemente esverdeado, para o material da tela
    // nunca ficar sem mapa entre a construção e o boot.
    const data = new Uint8Array([0, 2, 1, 255])
    this.placeholder = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat)
    this.placeholder.colorSpace = THREE.SRGBColorSpace
    this.placeholder.needsUpdate = true
    this.placeholder.name = 'msx-tela-aguardando'
  }

  /**
   * Largura **lógica** do sinal (272 num MSX1), não a do buffer do canvas.
   *
   * O WebMSX desenha num buffer superamostrado — 544×416 para um V9918, exatos
   * 2× o sinal de 272×208. Quem consome isto precisa da contagem de linhas de
   * varredura de verdade: o passe do tubo espaça scanline e tríade por essa
   * medida, e usar o dobro faria a máscara ficar fina demais para existir.
   */
  public get width(): number {
    return this.logicalSize.width
  }

  public get height(): number {
    return this.logicalSize.height
  }

  /** Canvas cru do emulador, ou a textura de espera antes do boot. */
  public get texture(): THREE.Texture {
    return this.canvasTexture ?? this.placeholder
  }

  // -------------------------------------------------------------------------
  // Ciclo de vida
  // -------------------------------------------------------------------------

  /**
   * Liga a máquina. Na primeira chamada baixa o emulador e monta a sala; nas
   * seguintes só religa — desligar e ligar de novo pela chave física não pode
   * custar 1,5 MB nem um novo boot do WebMSX.
   */
  public start(signal?: AbortSignal): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('A ponte do WebMSX já foi descartada.'))
    if (signal?.aborted === true) return Promise.reject(abortError())
    if (this.powered && this.mounted) return Promise.resolve()
    this.powered = true
    if (this.mounted) {
      this.powerOnRoom()
      return Promise.resolve()
    }
    if (this.startPromise !== null) return raceWithAbort(this.startPromise, signal)

    const controller = new AbortController()
    const detachAbort = forwardAbort(signal, controller)
    this.startController = controller
    const operation = this.startInitial(controller.signal).finally(() => {
      detachAbort()
      if (this.startController === controller) this.startController = null
      if (this.startPromise === operation) this.startPromise = null
    })
    this.startPromise = operation
    return operation
  }

  private async startInitial(signal: AbortSignal): Promise<void> {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      throw new WebMsxUnavailableError('sem-dom', 'WebMSX exige um DOM de navegador.')
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new WebMsxUnavailableError(
        'offline',
        'Sem conexão: o emulador é carregado da CDN em tempo de execução.',
      )
    }

    try {
      throwIfAborted(signal)
      if (!this.machineCreated) {
        this.container = this.createContainer()
        await this.injectScript(signal)
        throwIfAborted(signal)
        // A configuração vai DEPOIS do script: `wmsx.js` começa com
        // `WMSX = { ...padrões }`, uma atribuição que apaga qualquer objeto
        // definido antes. Como injetamos tarde, o auto-start nunca dispara e
        // sobra a janela certa para ajustar os parâmetros e chamar `start()`.
        this.configureGlobals()
        this.machineCreated = true
        this.bootMachine()
      } else {
        // `WMSX.start()` é one-shot e se apaga ao criar a Room. Se a energia
        // caiu enquanto ainda esperávamos o canvas, retomamos essa mesma Room:
        // reinjetar o script ou tentar um segundo start corromperia o global.
        this.powerOnRoom()
      }
      const canvas = await this.waitForCanvas(signal)
      throwIfAborted(signal)
      this.probeCanvasTaint(canvas)
      this.canvas = canvas
      this.measure(canvas)

      const texture = new THREE.CanvasTexture(canvas)
      texture.name = 'msx-tela-webmsx'
      texture.colorSpace = THREE.SRGBColorSpace
      texture.generateMipmaps = false
      texture.minFilter = THREE.LinearFilter
      texture.magFilter = THREE.LinearFilter
      texture.wrapS = THREE.ClampToEdgeWrapping
      texture.wrapT = THREE.ClampToEdgeWrapping
      this.canvasTexture = texture

      this.mounted = true
    } catch (error) {
      this.powered = false
      this.mounted = false
      if (isAbortError(error)) {
        if (this.machineCreated) this.powerOffRoom()
        else this.teardown()
        throw error
      }
      this.shutdownMachine()
      this.teardown()
      throw error instanceof WebMsxUnavailableError
        ? error
        : new WebMsxUnavailableError('erro-interno', 'Falha ao iniciar o WebMSX.', { cause: error })
    }
  }

  /**
   * Desliga a máquina, mas mantém a sala montada. Desmontar aqui obrigaria a
   * reinjetar o script na próxima energização — e o WebMSX não gosta de ser
   * carregado duas vezes na mesma página.
   */
  public stop(): void {
    this.powered = false
    this.startController?.abort()
    this.clearPressedKeys()
    if (!this.mounted && !this.machineCreated) return
    this.powerOffRoom()
  }

  /** Reset suave — o que acontece ao empurrar a tampa de um slot (SPEC §2.1). */
  public reset(): void {
    if (!this.powered) return
    const machine = pickPath(this.getGlobal(), ['room', 'machine'])
    if (machine === undefined) return
    if (!callMethod(machine, 'reset', [])) {
      // Algumas builds só expõem o ciclo de energia; ainda é um reset honesto.
      callMethod(machine, 'powerOff', [])
      callMethod(machine, 'userPowerOn', [false])
    }
  }

  /**
   * Encaminha uma tecla para a matriz do MSX.
   *
   * O toque mínimo de {@link MIN_KEY_HOLD_MS} não é firula: o Z80 lê a matriz
   * uma vez por frame (60 Hz), então um press+release no mesmo tick — que é o
   * que um clique numa tecla 3D ou um teste automatizado produzem — some sem
   * deixar rastro. Seguramos a tecla o suficiente para pelo menos duas
   * varreduras antes de soltar.
   */
  public sendKey(code: string, down: boolean): void {
    if (!this.powered) return
    const key = webMsxKeyForCode(code)
    if (key === null) return

    if (down) {
      const pendingRelease = this.releaseTimers.get(key)
      if (pendingRelease !== undefined) {
        globalThis.clearTimeout(pendingRelease)
        this.releaseTimers.delete(key)
      }
      // Repetir o mesmo estado embaralha o auto-repeat da BIOS: só transições.
      if (this.pressed.has(key)) return
      this.pressed.add(key)
      this.pressedAt.set(key, performance.now())
      this.dispatchKey(key, true)
      return
    }

    if (!this.pressed.has(key)) return
    if (this.releaseTimers.has(key)) return
    const held = performance.now() - (this.pressedAt.get(key) ?? 0)
    if (held >= MIN_KEY_HOLD_MS) {
      this.releaseKey(key)
      return
    }
    const timer = globalThis.setTimeout(() => {
      this.releaseTimers.delete(key)
      this.releaseKey(key)
    }, MIN_KEY_HOLD_MS - held)
    this.releaseTimers.set(key, timer)
  }

  private releaseKey(key: string): void {
    if (!this.pressed.delete(key)) return
    this.pressedAt.delete(key)
    this.dispatchKey(key, false)
  }

  private dispatchKey(key: string, down: boolean): void {
    const keyboard = pickPath(this.getGlobal(), ['room', 'keyboard'])
    if (keyboard === undefined) return
    callMethod(keyboard, 'processMSXKey', [key, down])
  }

  public async insertCartridge(slot: 'A' | 'B', romId: string): Promise<void> {
    if (!this.powered) {
      throw new Error('Ligue o computador antes de carregar o cartucho no emulador.')
    }
    const content = await this.resolveRom(romId)
    if (!this.powered) {
      throw new Error('O computador foi desligado antes de carregar o cartucho.')
    }
    if (content === null) {
      const message = `Cartucho “${romId}” não disponível — nenhuma ROM acompanha este projeto.`
      this.notice(message)
      throw new Error(message)
    }
    const loader = pickPath(this.getGlobal(), ['room', 'fileLoader'])
    if (loader === undefined) {
      const message = 'Emulador ainda não está pronto para receber cartuchos.'
      this.notice(message)
      throw new Error(message)
    }
    const port = slot === 'A' ? 0 : 1
    // loadFromContent(nome, conteúdo, tipo, porta, cicloDeEnergia). O último
    // parâmetro foi conferido na máquina: `true` aqui religa com o cartucho
    // dentro, que é o que acontece de verdade quando se encaixa um cartucho.
    if (!callMethod(loader, 'loadFromContent', [`${romId}.rom`, content, 'ROM', port, true])) {
      const message = `Não foi possível carregar o cartucho “${romId}”.`
      this.notice(message)
      throw new Error(message)
    }
  }

  public ejectCartridge(slot: 'A' | 'B'): void {
    if (!this.powered) return
    const cartridgeSlot = pickPath(this.getGlobal(), ['room', 'cartridgeSlot'])
    if (cartridgeSlot === undefined) return
    // Atenção à assimetria, também conferida na máquina: em `removeCartridge` o
    // segundo parâmetro é o modo *alternativo*, então `false` é que faz o ciclo
    // de energia normal. Passar `true` deixaria a tela congelada no cartucho que
    // já não existe mais.
    callMethod(cartridgeSlot, 'removeCartridge', [slot === 'A' ? 0 : 1, false])
  }

  /**
   * O WebMSX roda no próprio relógio; aqui só marcamos a textura como suja e
   * acompanhamos mudança de resolução do sinal (o VDP troca de 256 para 512 de
   * largura conforme o modo).
   */
  public update(): void {
    const canvas = this.canvas
    const texture = this.canvasTexture
    if (canvas !== null && texture !== null) {
      if (canvas.width !== this.canvasSize.width || canvas.height !== this.canvasSize.height) {
        // Troca de modo do VDP: o buffer muda de tamanho. Não trocamos a
        // textura — o three relê as dimensões do canvas a cada envio, e trocar
        // quebraria a referência que o tubo já tem.
        this.measure(canvas)
      }
      texture.needsUpdate = true
    }
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    if (this.lateAutoStartTimer !== null) {
      globalThis.clearTimeout(this.lateAutoStartTimer)
      this.lateAutoStartTimer = null
    }
    this.mounted = false
    this.shutdownMachine()
    this.teardown()
    this.canvasTexture?.dispose()
    this.canvasTexture = null
    this.placeholder.dispose()
  }

  private clearPressedKeys(): void {
    for (const timer of this.releaseTimers.values()) globalThis.clearTimeout(timer)
    this.releaseTimers.clear()
    this.pressed.clear()
    this.pressedAt.clear()
  }

  // -------------------------------------------------------------------------
  // Interno
  // -------------------------------------------------------------------------

  /**
   * Deduz o tamanho lógico do sinal a partir do buffer do canvas. O fator de
   * superamostragem do WebMSX é sempre um inteiro sobre a largura do sinal
   * (`wmsx.VDP.SIGNAL_WIDTH_V9918 = 272`), então dividir por ele recupera o
   * quadro real — 272×208 no MSX1.
   */
  private measure(canvas: HTMLCanvasElement): void {
    const width = canvas.width > 0 ? canvas.width : 544
    const height = canvas.height > 0 ? canvas.height : 416
    this.canvasSize = { width, height }
    const scale = Math.max(1, Math.round(width / MSX1_SIGNAL_WIDTH))
    this.logicalSize = { width: Math.round(width / scale), height: Math.round(height / scale) }
  }

  private getGlobal(): unknown {
    return (globalThis as unknown as Dict)['WMSX']
  }

  private notice(message: string): void {
    this.options.onNotice?.(message)
  }

  /**
   * Contêiner fora de tela. Não usamos `display:none`: o navegador pararia de
   * compor o canvas e a textura congelaria. Deslocar para fora da viewport
   * mantém o desenho acontecendo com custo desprezível.
   */
  private createContainer(): HTMLDivElement {
    const existing = document.getElementById(SCREEN_ELEMENT_ID)
    if (existing instanceof HTMLDivElement) return existing
    const div = document.createElement('div')
    div.id = SCREEN_ELEMENT_ID
    div.setAttribute('aria-hidden', 'true')
    div.style.cssText = [
      'position:fixed',
      'left:-10000px',
      'top:0',
      'width:544px',
      'height:480px',
      'opacity:0',
      'pointer-events:none',
      'z-index:-1',
      'overflow:hidden',
      'contain:strict',
    ].join(';')
    document.body.appendChild(div)
    return div
  }

  /**
   * Ajusta os parâmetros no objeto `WMSX` já criado pelo script, antes de
   * `WMSX.start()` — é `start()` que roda o `Configurator` e lê tudo isto.
   */
  private configureGlobals(): void {
    const wmsx = this.getGlobal()
    if (!isDict(wmsx)) {
      throw new WebMsxUnavailableError('api-ausente', 'O script carregou mas não expôs `WMSX`.')
    }
    Object.assign(wmsx, {
      // The pinned Configurator otherwise lets page query parameters replace these settings.
      ALLOW_URL_PARAMETERS: false,
      // MSX1 América (NTSC, 60 Hz) — é o que o Expert é.
      MACHINE: 'MSX1A',
      VDP_PALETTE: this.options.vdpPalette ?? 1,
      SCREEN_ELEMENT_ID,
      // Nós é que ligamos a máquina, na hora que a chave física for acionada.
      AUTO_START: false,
      AUTO_POWER_ON_DELAY: 0,
      // A interface do WebMSX não aparece: quem desenha a tela é o nosso tubo.
      SCREEN_CONTROL_BAR: 0,
      SCREEN_RESIZE_DISABLED: true,
      SCREEN_FULLSCREEN_MODE: -2,
      SCREEN_DEFAULT_SCALE: 1,
      SCREEN_DEFAULT_ASPECT: 1,
      // Sem suavização, sem scanline, sem fósforo: tudo isso é nosso trabalho.
      SCREEN_FILTER_MODE: 0,
      SCREEN_CRT_SCANLINES: 0,
      SCREEN_CRT_PHOSPHOR: 0,
      SCREEN_VSYNC_MODE: -1,
      MOUSE_MODE: -1,
      TOUCH_MODE: -1,
      MOBILE_MODE: -1,
      VOL: this.options.volume ?? 0.7,
    })
  }

  private injectScript(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const timeoutMs = this.options.loadTimeoutMs ?? 15_000
    return new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        `script[src="${WEBMSX_SCRIPT_URL}"]`,
      )
      if (existing !== null && pick(this.getGlobal(), 'start') !== undefined) {
        resolve()
        return
      }

      const script = document.createElement('script')
      script.src = WEBMSX_SCRIPT_URL
      script.integrity = WEBMSX_SCRIPT_INTEGRITY
      script.crossOrigin = 'anonymous'
      script.async = true

      let timer = 0
      const cleanup = (): void => {
        window.clearTimeout(timer)
        script.removeEventListener('load', onLoad)
        script.removeEventListener('error', onError)
        signal.removeEventListener('abort', onAbort)
      }
      const onLoad = (): void => {
        cleanup()
        resolve()
      }
      // Dispara também quando a SRI recusa o arquivo — é o comportamento que
      // queremos: conteúdo adulterado nunca executa, e caímos no procedural.
      const onError = (): void => {
        cleanup()
        script.remove()
        reject(
          new WebMsxUnavailableError(
            'script-bloqueado',
            'O script do emulador foi bloqueado, recusado pela SRI ou não pôde ser baixado.',
          ),
        )
      }
      const onAbort = (): void => {
        cleanup()
        script.remove()
        reject(abortError())
      }

      timer = window.setTimeout(() => {
        cleanup()
        // Remover o elemento não cancela um download já em curso: se o script
        // chegar depois da desistência, ele ainda executa e tenta se auto-iniciar
        // no `load` da janela. Desarmamos isso antes que aconteça — senão sobra
        // um emulador inteiro rodando escondido enquanto a tela já é procedural.
        this.disarmLateAutoStart()
        script.remove()
        reject(
          new WebMsxUnavailableError(
            'tempo-esgotado',
            `A CDN não respondeu em ${timeoutMs} ms.`,
          ),
        )
      }, timeoutMs)

      script.addEventListener('load', onLoad)
      script.addEventListener('error', onError)
      signal.addEventListener('abort', onAbort, { once: true })
      document.head.appendChild(script)
    })
  }

  /**
   * Mantém `WMSX.AUTO_START` desligado se o script chegar atrasado, depois de já
   * termos caído para o procedural.
   */
  private disarmLateAutoStart(): void {
    const deadline = performance.now() + 45_000
    const tick = (): void => {
      this.lateAutoStartTimer = null
      if (this.disposed) return
      const wmsx = this.getGlobal()
      if (isDict(wmsx)) {
        wmsx['AUTO_START'] = false
        return
      }
      if (performance.now() >= deadline) return
      this.lateAutoStartTimer = globalThis.setTimeout(tick, 200)
    }
    tick()
  }

  /**
   * Religa a sala inteira, não só a CPU. `Room.powerOff()` fecha o AudioContext
   * e para relógio/controles/tela; o caminho inverso precisa reabrir tudo antes
   * de ligar a máquina. `setLoading(false)` é necessário porque `Room.powerOn`
   * volta ao estado de carregamento e `machine.userPowerOn()` o respeita.
   */
  private powerOnRoom(): void {
    const room = pick(this.getGlobal(), 'room')
    if (room === undefined) return
    callMethod(room, 'powerOn', [])
    callMethod(room, 'setLoading', [false])
    this.powerOnMachine()
  }

  /** Para CPU, relógio, controles e áudio sem destruir a Room one-shot. */
  private powerOffRoom(): void {
    const room = pick(this.getGlobal(), 'room')
    if (!callMethod(room, 'powerOff', [])) {
      callMethod(pick(room, 'machine'), 'powerOff', [])
    }
  }

  /** Religa a máquina dentro de uma sala já energizada. */
  private powerOnMachine(): void {
    const machine = pickPath(this.getGlobal(), ['room', 'machine'])
    if (machine === undefined) return
    if (pick(machine, 'powerIsOn') === true) return
    callMethod(machine, 'userPowerOn', [false])
  }

  private bootMachine(): void {
    const wmsx = this.getGlobal()
    if (!isDict(wmsx)) {
      throw new WebMsxUnavailableError('api-ausente', 'O script carregou mas não expôs `WMSX`.')
    }
    // `WMSX.start()` se apaga depois da primeira chamada; se já rodou (retorno
    // de energia), religamos a máquina pelo objeto Room.
    if (typeof wmsx['start'] === 'function') {
      wmsx['screenElement'] = this.container
      if (!callMethod(wmsx, 'start', [true])) {
        throw new WebMsxUnavailableError('erro-interno', 'WMSX.start() falhou.')
      }
      return
    }
    const machine = pickPath(wmsx, ['room', 'machine'])
    if (machine === undefined) {
      throw new WebMsxUnavailableError('api-ausente', 'WMSX.room.machine indisponível.')
    }
    callMethod(machine, 'userPowerOn', [false])
  }

  private waitForCanvas(signal: AbortSignal): Promise<HTMLCanvasElement> {
    const container = this.container
    const timeoutMs = this.options.bootTimeoutMs ?? 8_000
    if (container === null) {
      return Promise.reject(
        new WebMsxUnavailableError('canvas-ausente', 'Contêiner do emulador não existe.'),
      )
    }
    return new Promise<HTMLCanvasElement>((resolve, reject) => {
      let probeTimer = 0
      let deadlineTimer = 0
      const cleanup = (): void => {
        window.clearInterval(probeTimer)
        window.clearTimeout(deadlineTimer)
        signal.removeEventListener('abort', onAbort)
      }
      const succeed = (canvas: HTMLCanvasElement): void => {
        cleanup()
        resolve(canvas)
      }
      const fail = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const probe = (): void => {
        const canvas = findScreenCanvas(container)
        if (canvas !== null && canvas.width > 0 && canvas.height > 0) {
          succeed(canvas)
        }
      }
      const onAbort = (): void => fail(abortError())

      signal.addEventListener('abort', onAbort, { once: true })
      probeTimer = window.setInterval(probe, 50)
      deadlineTimer = window.setTimeout(() => {
        fail(
          new WebMsxUnavailableError(
            'canvas-ausente',
            'O emulador carregou mas não criou o canvas da tela.',
          ),
        )
      }, timeoutMs)
      probe()
    })
  }

  /**
   * Verifica se o canvas do emulador está contaminado por conteúdo de outra
   * origem. Um canvas contaminado explode com `SecurityError` no upload da
   * textura, e o resultado seria uma tela preta sem explicação.
   *
   * O teste desenha um pixel do canvas do emulador num canvas de rascunho: se a
   * origem estiver contaminada, a contaminação se propaga e o `getImageData`
   * levanta exceção. Funciona tanto para origem 2D quanto WebGL, o que importa
   * caso alguma build futura do WebMSX troque de renderizador.
   */
  private probeCanvasTaint(canvas: HTMLCanvasElement): void {
    const scratch = document.createElement('canvas')
    scratch.width = 1
    scratch.height = 1
    const ctx = scratch.getContext('2d', { willReadFrequently: true })
    if (ctx === null) {
      throw new WebMsxUnavailableError(
        'erro-interno',
        'Sem contexto 2D para testar contaminação do canvas.',
      )
    }
    try {
      ctx.drawImage(canvas, 0, 0, 1, 1)
      ctx.getImageData(0, 0, 1, 1)
    } catch (error) {
      throw new WebMsxUnavailableError(
        'canvas-contaminado',
        'O canvas do emulador está contaminado por conteúdo de outra origem; ' +
          'a textura não pode ser enviada para a GPU.',
        { cause: error },
      )
    }
  }

  private async resolveRom(romId: string): Promise<Uint8Array | null> {
    const provider = this.options.romProvider
    if (provider !== undefined) {
      try {
        const content = await provider(romId)
        if (content !== null) return content
      } catch (error) {
        console.warn('[WebMSX] provedor de ROM falhou', error)
      }
    }
    // O cartucho vermelho "Super Cósmico" roda um jogo autoral completo em Z80
    // (snake espacial — ver SuperCosmicoRom.ts). Jogos comerciais da época nunca
    // entram aqui: seguem com copyright ativo (invariante #1).
    if (romId === 'arcade-vermelho') return buildSuperCosmicoRom()
    if (romId === 'preto-generico') {
      return buildDemoRom({
        lines: [
          'CARTUCHO PRETO',
          'GRADIENTE EXPERT XP-800',
          '',
          'PROGRAMA AUTORAL CARREGADO',
          'SLOT ATIVO',
          '',
          'DIGITE PARA TESTAR O TECLADO',
        ],
        foreground: 3,
        background: 1,
        border: 1,
      })
    }
    if (romId === 'demo' || romId === 'gradiente-demo') return buildDemoRom()
    return null
  }

  private shutdownMachine(): void {
    if (!this.machineCreated) return
    this.clearPressedKeys()
    const wmsx = this.getGlobal()
    const room = pick(wmsx, 'room')
    if (!callMethod(wmsx, 'shutdown', []) && !callMethod(room, 'powerOff', [])) {
      callMethod(pick(room, 'machine'), 'powerOff', [])
    }
    if (isDict(wmsx)) wmsx['room'] = undefined
    this.machineCreated = false
  }

  private teardown(): void {
    const container = this.container
    this.container = null
    this.canvas = null
    if (container !== null && container.parentNode !== null) {
      container.parentNode.removeChild(container)
    }
  }
}

/**
 * Acha o canvas da tela. O WebMSX cria vários (tela, ícone de carga, scanlines);
 * o da tela tem id conhecido, mas caímos para o maior por área se a build mudar.
 */
function findScreenCanvas(container: HTMLElement): HTMLCanvasElement | null {
  const byId = container.querySelector<HTMLCanvasElement>(`canvas#${SCREEN_CANVAS_ID}`)
  if (byId !== null) return byId
  let best: HTMLCanvasElement | null = null
  let bestArea = 0
  for (const canvas of container.querySelectorAll('canvas')) {
    const area = canvas.width * canvas.height
    if (area > bestArea) {
      bestArea = area
      best = canvas
    }
  }
  return best
}
