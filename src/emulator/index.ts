import type * as THREE from 'three'

import type { ScreenSource } from '../core/types.ts'
import {
  CrtProcessor,
  CrtWarmup,
  type CrtProcessorOptions,
  type CrtTuning,
} from './CrtShader.ts'
import { ProceduralScreen } from './ProceduralScreen.ts'
import {
  WebMsxBridge,
  WebMsxUnavailableError,
  type WebMsxBridgeOptions,
  type WebMsxFailure,
} from './WebMsxBridge.ts'

export { CrtProcessor, CrtWarmup, DEFAULT_CRT_TUNING } from './CrtShader.ts'
export type { CrtProcessorOptions, CrtTuning } from './CrtShader.ts'
export { ProceduralScreen, TMS9918_PALETTE } from './ProceduralScreen.ts'
export {
  WebMsxBridge,
  WebMsxUnavailableError,
  WEBMSX_SCRIPT_INTEGRITY,
  WEBMSX_SCRIPT_URL,
  buildDemoRom,
} from './WebMsxBridge.ts'
export type { WebMsxBridgeOptions, WebMsxFailure } from './WebMsxBridge.ts'

function abortError(): DOMException {
  return new DOMException('Inicialização da tela cancelada.', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
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

/**
 * Fábrica da fonte de vídeo (SPEC §9).
 *
 * Tenta o WebMSX; se ele não puder ser usado — CDN fora, rede bloqueada, SRI
 * recusada, canvas contaminado — cai no renderer procedural sem baixar o padrão
 * visual. Quem venceu fica exposto em {@link ScreenPipeline.kind}.
 *
 * O download de 1,5 MB só acontece em `start()`, isto é, ao ligar a máquina —
 * nunca no carregamento da página.
 */

interface ScreenRouteOptions extends WebMsxBridgeOptions {
  /**
   * Força um caminho. `'procedural'` nem tenta a rede (útil para captura de
   * telas determinística e para desenvolvimento offline).
   */
  readonly prefer?: 'webmsx' | 'procedural'
  /**
   * Só busca o WebMSX quando há cartucho inserido.
   *
   * O C-BIOS não traz BASIC — o BASIC do MSX é ROM proprietária da Microsoft e o
   * invariante #1 proíbe embarcá-la. Então, com os slots vazios, o WebMSX só
   * consegue mostrar "No cartridge found" e o teclado não faz nada: um beco sem
   * saída logo na primeira interação. A máquina real faz o contrário — sem
   * cartucho ela cai no BASIC, com cartucho ela dá boot no jogo.
   *
   * Com esta opção a rota reproduz o comportamento real: slots vazios ficam no
   * renderizador procedural, que tem prompt BASIC de verdade, e o WebMSX entra
   * quando há um cartucho para ele rodar (que é o que o C-BIOS sabe fazer).
   */
  readonly webMsxNeedsCartridge?: boolean
  /**
   * Quanto esperar pelo WebMSX antes de acender a tela procedural, em ms.
   * Padrão 500: se a CDN responde rápido, o usuário nunca vê a troca.
   */
  readonly gracePeriodMs?: number
  /** Chamado quando a fonte ativa muda (a textura muda de identidade junto). */
  readonly onSourceChanged?: (source: ScreenSource) => void
}

export interface ScreenPipelineOptions extends ScreenRouteOptions {
  readonly renderer: THREE.WebGLRenderer
  readonly crt?: CrtProcessorOptions
}

/**
 * Fonte roteada: mantém o renderer procedural sempre à mão e promove o WebMSX a
 * fonte ativa se ele subir. Toda a interface `ScreenSource` é repassada para
 * quem estiver no comando.
 */
class RoutedScreenSource implements ScreenSource {
  public readonly procedural: ProceduralScreen
  public webmsx: WebMsxBridge | null = null
  public fallbackReason: WebMsxFailure | null = null

  private readonly innerOptions: WebMsxBridgeOptions

  private active: ScreenSource
  private firstUsable = false
  private starting = false
  private powered = false
  private disposed = false
  private webMsxUnavailable = false
  private runtimeDemoted = false
  private graceTimer: number | null = null
  private routeController: AbortController | null = null
  /** Ponte ainda não promovida; preservada entre ciclos de energia cancelados. */
  private candidateBridge: WebMsxBridge | null = null
  private readonly desiredCartridges = new Map<'A' | 'B', string>()
  private resolveReady: ((kind: 'webmsx' | 'procedural') => void) | null = null

  public readonly ready: Promise<'webmsx' | 'procedural'>

  /**
   * ROM carregada pelo usuário (nunca sai do navegador). Quando presente, o
   * cartucho preto genérico (`preto-generico`) resolve para ela — o provider
   * composto abaixo tem precedência sobre os cartuchos autorais embutidos, e o
   * `romProvider` externo das opções continua valendo para os demais ids.
   */
  private localRom: Uint8Array | null = null

  public constructor(private readonly options: ScreenRouteOptions) {
    this.innerOptions = {
      ...options,
      romProvider: async (romId: string): Promise<Uint8Array | null> => {
        if (romId === 'preto-generico' && this.localRom !== null) return this.localRom
        return (await options.romProvider?.(romId)) ?? null
      },
    }
    this.procedural = new ProceduralScreen()
    this.active = this.procedural
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve
    })
  }

  /**
   * Instala (ou remove, com `null`) a ROM local do cartucho preto. Só afeta a
   * rota WebMSX — o renderizador procedural não executa Z80 e segue mostrando a
   * própria splash do cartucho genérico.
   */
  public setLocalRom(bytes: Uint8Array | null): void {
    this.localRom = bytes
  }

  public get kind(): 'webmsx' | 'procedural' {
    return this.active.kind
  }

  public get width(): number {
    return this.active.width
  }

  public get height(): number {
    return this.active.height
  }

  public get texture(): THREE.Texture {
    return this.active.texture
  }

  public async start(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error('A fonte de tela já foi descartada.')
    if (signal?.aborted === true) throw abortError()
    this.powered = true

    // Religar depois de desligar não repete a decisão de rota nem a rede.
    if (this.firstUsable) {
      await this.active.start(signal)
      if (
        this.active === this.procedural &&
        this.options.prefer !== 'procedural' &&
        !this.webMsxUnavailable &&
        !this.starting &&
        this.webMsxHasWorkToDo()
      ) {
        this.launchWebMsxAttempt(signal, false)
      }
      return
    }
    if (this.starting) {
      await raceWithAbort(this.ready, signal)
      return
    }
    if (
      this.options.prefer === 'procedural' ||
      this.webMsxUnavailable ||
      !this.webMsxHasWorkToDo()
    ) {
      this.starting = true
      await this.procedural.start(signal)
      this.settleFirstUsable('procedural')
      this.starting = false
      return
    }

    this.launchWebMsxAttempt(signal, true)
    await raceWithAbort(this.ready, signal)
  }

  private launchWebMsxAttempt(
    signal: AbortSignal | undefined,
    useGracePeriod: boolean,
  ): void {
    if (
      this.disposed ||
      !this.powered ||
      this.starting ||
      this.webMsxUnavailable ||
      this.options.prefer === 'procedural' ||
      !this.webMsxHasWorkToDo()
    ) {
      return
    }
    this.starting = true
    const controller = new AbortController()
    const detachAbort = forwardAbort(signal, controller)
    this.routeController = controller

    if (useGracePeriod) {
      // Ao fim da carência, `ready` resolve e o chamador já tem uma fonte visível.
      // O WebMSX continua subindo em paralelo e pode promover a rota mais tarde.
      const grace = this.options.gracePeriodMs ?? 500
      this.graceTimer = globalThis.setTimeout(() => {
        this.graceTimer = null
        void this.activateProcedural(controller.signal)
      }, grace)
    }

    const bridge = this.candidateBridge ?? new WebMsxBridge(this.innerOptions)
    this.candidateBridge = bridge
    void bridge
      .start(controller.signal)
      .then(() => this.promoteToWebMsx(bridge, controller.signal))
      .catch((error: unknown) => this.handleStartupFailure(bridge, error, controller.signal))
      .finally(() => {
        detachAbort()
        if (this.routeController === controller) this.routeController = null
        this.starting = false
        // Um liga-desliga muito rápido — ou um ejeta-reinsere — pode ocorrer antes
        // desta finalização, enquanto `starting` ainda estava de pé e portanto o
        // pedido de promoção foi ignorado. Retome aqui.
        //
        // `candidateBridge === null` conta como retomável: quer dizer que a
        // tentativa anterior foi cancelada e ninguém é dono do lugar, então uma
        // ponte nova pode subir. Sem isso, ejetar e reinserir em seguida perdia a
        // promoção para sempre e a tela ficava no BASIC com cartucho no slot.
        if (
          this.powered &&
          this.firstUsable &&
          this.active === this.procedural &&
          !this.webMsxUnavailable &&
          (this.candidateBridge === bridge || this.candidateBridge === null) &&
          this.webMsxHasWorkToDo()
        ) {
          this.launchWebMsxAttempt(undefined, false)
        }
      })
  }

  public stop(): void {
    this.powered = false
    this.clearGrace()
    this.routeController?.abort()
    this.candidateBridge?.stop()
    this.active.stop()
  }

  public reset(): void {
    if (!this.powered) return
    this.active.reset()
  }

  public sendKey(code: string, down: boolean): void {
    if (!this.powered) return
    this.active.sendKey(code, down)
  }

  public async insertCartridge(slot: 'A' | 'B', romId: string): Promise<void> {
    if (!this.powered) {
      throw new Error('Ligue o computador antes de carregar o cartucho.')
    }
    const previous = this.desiredCartridges.get(slot)
    this.desiredCartridges.set(slot, romId)
    try {
      await this.active.insertCartridge(slot, romId)
    } catch (error) {
      if (previous === undefined) this.desiredCartridges.delete(slot)
      else this.desiredCartridges.set(slot, previous)
      throw error
    }
    // Agora existe cartucho: o WebMSX passa a ter o que rodar. A procedural segue
    // visível enquanto ele sobe, e `promoteToWebMsx` reaplica os slots desejados
    // antes de trocar — o mesmo caminho da carência inicial.
    if (
      this.options.webMsxNeedsCartridge === true &&
      this.active === this.procedural &&
      !this.webMsxUnavailable &&
      this.options.prefer !== 'procedural' &&
      !this.starting
    ) {
      this.launchWebMsxAttempt(undefined, false)
    }
  }

  public ejectCartridge(slot: 'A' | 'B'): void {
    if (!this.powered) return
    this.desiredCartridges.delete(slot)
    this.active.ejectCartridge(slot)
    // Tirou o último cartucho: sem ele o C-BIOS volta a "No cartridge found", que é
    // justamente o beco sem saída que esta rota existe para evitar.
    if (this.options.webMsxNeedsCartridge !== true || this.desiredCartridges.size > 0) return

    // Uma tentativa em voo precisa morrer aqui. Ejetar durante a carga do WebMSX
    // deixava `active` ainda procedural — a promoção seguia adiante, reaplicava um
    // mapa de cartuchos já vazio e acendia o C-BIOS sem cartucho assim mesmo.
    this.clearGrace()
    this.routeController?.abort()
    if (this.candidateBridge !== null) {
      const pending = this.candidateBridge
      this.candidateBridge = null
      pending.dispose()
    }

    if (this.active.kind === 'webmsx') {
      void this.returnToProcedural().catch((error: unknown) => {
        console.warn('[MSX] falha ao voltar para o emulador interno após ejetar.', error)
      })
    }
  }

  /** Existe cartucho a rodar — ou a rota não exige um? */
  private webMsxHasWorkToDo(): boolean {
    if (this.options.webMsxNeedsCartridge !== true) return true
    return this.desiredCartridges.size > 0
  }

  /**
   * Devolve a tela ao renderizador procedural sem marcar o WebMSX como indisponível:
   * não houve falha nenhuma, o usuário só ficou sem cartucho. A ponte é descartada
   * para não deixar CPU e áudio girando atrás de uma tela que ninguém vê; uma nova
   * inserção sobe outra do zero.
   */
  private async returnToProcedural(): Promise<void> {
    if (this.disposed || !this.powered) return
    this.clearGrace()
    this.routeController?.abort()
    const retiring = this.webmsx
    this.webmsx = null
    this.active = this.procedural
    retiring?.dispose()
    await this.syncProceduralCartridges()
    if (this.disposed || !this.powered) return
    this.active = this.procedural
    this.options.onSourceChanged?.(this.procedural)
  }

  public update(dt: number): void {
    try {
      this.active.update(dt)
    } catch (error) {
      if (!this.handleRuntimeFailure(error)) throw error
    }
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.powered = false
    this.clearGrace()
    this.routeController?.abort()
    this.active.stop()
    this.candidateBridge?.dispose()
    this.candidateBridge = null
    this.webmsx?.dispose()
    this.procedural.dispose()
  }

  /**
   * Uma falha depois da promoção derruba o WebMSX uma única vez e mantém o tubo
   * alimentado pelo fallback. Retorna `true` quando houve demotion.
   */
  public handleRuntimeFailure(error: unknown): boolean {
    if (
      this.disposed ||
      this.runtimeDemoted ||
      this.active.kind !== 'webmsx'
    ) {
      return false
    }
    this.runtimeDemoted = true
    this.webMsxUnavailable = true
    this.fallbackReason =
      error instanceof DOMException && error.name === 'SecurityError'
        ? 'canvas-contaminado'
        : 'erro-interno'

    const failed = this.webmsx
    this.webmsx = null
    this.active = this.procedural
    failed?.dispose()

    if (this.powered) {
      void this.syncProceduralCartridges().catch((fallbackError: unknown) => {
        console.warn('[MSX] falha ao restaurar cartuchos no emulador interno.', fallbackError)
      })
      this.options.onSourceChanged?.(this.procedural)
    }
    this.options.onNotice?.('O emulador externo falhou — alternando para o emulador interno.')
    console.warn('[MSX] WebMSX falhou durante a execução; usando o renderer procedural.', error)
    if (!this.firstUsable) this.settleFirstUsable('procedural')
    return true
  }

  private clearGrace(): void {
    if (this.graceTimer === null) return
    globalThis.clearTimeout(this.graceTimer)
    this.graceTimer = null
  }

  private settleFirstUsable(kind: 'webmsx' | 'procedural'): void {
    if (this.firstUsable) return
    this.firstUsable = true
    this.resolveReady?.(kind)
    this.resolveReady = null
  }

  private async activateProcedural(signal?: AbortSignal): Promise<void> {
    if (this.disposed || !this.powered || isSignalAborted(signal)) return
    if (!this.firstUsable || this.active !== this.procedural) {
      await this.procedural.start(signal)
    }
    if (this.disposed || !this.powered || isSignalAborted(signal)) return
    this.active = this.procedural
    this.settleFirstUsable('procedural')
  }

  private async promoteToWebMsx(
    bridge: WebMsxBridge,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.disposed || this.runtimeDemoted) {
      bridge.dispose()
      if (this.candidateBridge === bridge) this.candidateBridge = null
      return
    }
    if (!this.powered || signal.aborted) {
      bridge.stop()
      return
    }
    for (const slot of ['A', 'B'] as const) {
      const romId = this.desiredCartridges.get(slot)
      if (romId !== undefined) await bridge.insertCartridge(slot, romId)
      if (this.disposed || this.runtimeDemoted) {
        bridge.dispose()
        if (this.candidateBridge === bridge) this.candidateBridge = null
        return
      }
      if (!this.powered || signal.aborted) {
        bridge.stop()
        return
      }
    }
    // Última verificação antes de trocar: o cartucho pode ter saído enquanto o
    // WebMSX subia. Promover agora acenderia o C-BIOS com os slots vazios — o beco
    // sem saída que `webMsxNeedsCartridge` existe para impedir. Aqui não houve
    // falha, então a ponte é descartada sem marcar o WebMSX como indisponível.
    if (!this.webMsxHasWorkToDo()) {
      bridge.dispose()
      if (this.candidateBridge === bridge) this.candidateBridge = null
      if (!this.firstUsable) await this.activateProcedural(signal)
      return
    }

    this.clearGrace()
    this.webmsx = bridge
    this.candidateBridge = null
    if (this.active === this.procedural) this.procedural.stop()
    this.active = bridge
    this.options.onSourceChanged?.(bridge)
    this.settleFirstUsable('webmsx')
  }

  private async handleStartupFailure(
    bridge: WebMsxBridge,
    error: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    this.clearGrace()
    if (isAbortError(error) || signal.aborted || this.disposed || !this.powered) return

    bridge.dispose()
    if (this.candidateBridge === bridge) this.candidateBridge = null
    this.webMsxUnavailable = true

    this.fallbackReason =
      error instanceof WebMsxUnavailableError ? error.reason : 'erro-interno'
    console.warn(
      `[MSX] WebMSX indisponível (${this.fallbackReason}); usando o renderer procedural.`,
      error,
    )
    this.options.onNotice?.(describeFailure(this.fallbackReason))
    await this.activateProcedural()
  }

  /**
   * Reconcilia os slots da procedural com `desiredCartridges` ao reativá-la.
   *
   * Enquanto o WebMSX manda, a procedural fica dormente e não vê inserções nem
   * ejeções — e o `ejectCartridge` dela é um no-op parada (`!running`). Religar
   * sem reconciliar ressuscitava um cartucho-fantasma: ejetar o último cartucho
   * voltava para a *splash* do cartucho em vez do prompt BASIC vazio.
   *
   * Cada slot é ejetado antes da inserção desejada e uma inserção recusada (ROM
   * sem suporte interno) não aborta o outro slot: melhor o BASIC limpo do que um
   * fantasma sobrevivendo a um `insertCartridge` que rejeitou.
   */
  private async syncProceduralCartridges(): Promise<void> {
    await this.procedural.start()
    for (const slot of ['A', 'B'] as const) {
      if (this.disposed || !this.powered) return
      this.procedural.ejectCartridge(slot)
      const romId = this.desiredCartridges.get(slot)
      if (romId === undefined) continue
      try {
        await this.procedural.insertCartridge(slot, romId)
      } catch (error) {
        console.warn(
          `[MSX] cartucho “${romId}” não pôde ser restaurado no emulador interno.`,
          error,
        )
      }
    }
  }
}

function describeFailure(reason: WebMsxFailure): string {
  switch (reason) {
    case 'offline':
      return 'Sem conexão — rodando o emulador interno.'
    case 'script-bloqueado':
      return 'Emulador externo bloqueado — rodando o emulador interno.'
    case 'tempo-esgotado':
      return 'A CDN demorou demais — rodando o emulador interno.'
    case 'canvas-contaminado':
      return 'Vídeo do emulador externo inacessível — rodando o emulador interno.'
    case 'canvas-ausente':
    case 'api-ausente':
    case 'sem-dom':
    case 'erro-interno':
      return 'Emulador externo indisponível — rodando o emulador interno.'
  }
}

/**
 * Conveniência: fonte + tubo num objeto só.
 *
 * `texture` já é a saída processada pelo {@link CrtProcessor} e tem identidade
 * estável — dá para plugar uma única vez em `CrtMonitorModule.setScreenTexture()`
 * no boot e nunca mais pensar nisso, inclusive quando o WebMSX substituir o
 * renderer procedural no meio do caminho.
 *
 * O passe do tubo anda dentro de `update()` e a rampa de aquecimento se conduz
 * a partir de `start()`/`stop()`:
 * ```ts
 * const tela = new ScreenPipeline({ renderer })
 * monitor.setScreenTexture(tela.texture)   // uma vez, no boot
 * // a cada frame, antes do render da cena:
 * tela.update(dt)
 * ```
 */
export class ScreenPipeline implements ScreenSource {
  private static readonly CRT_FRAME_INTERVAL = 1 / 60
  private static readonly CRT_FRAME_TOLERANCE = 1 / 1000

  public readonly crt: CrtProcessor
  private readonly routed: RoutedScreenSource
  private readonly renderer: THREE.WebGLRenderer
  private readonly autoSizeCrt: boolean
  private readonly warmup = new CrtWarmup()
  private readonly onNotice: ((message: string) => void) | undefined
  private crtFrameDebt = 0
  private crtElapsed = 0
  private crtDirty = true
  private processingFailed = false
  private disposed = false

  public constructor(options: ScreenPipelineOptions) {
    const { renderer, crt, ...routeOptions } = options
    this.routed = new RoutedScreenSource({
      ...routeOptions,
      onSourceChanged: (source) => {
        this.crt.setSource(source.texture, source.width, source.height)
        this.markCrtDirty()
        options.onSourceChanged?.(source)
      },
    })
    this.renderer = renderer
    this.autoSizeCrt = crt?.width === undefined && crt?.height === undefined
    this.onNotice = options.onNotice
    this.crt = new CrtProcessor(this.routed.texture, {
      sourceWidth: this.routed.width,
      sourceHeight: this.routed.height,
      ...crt,
    })
  }

  public get kind(): 'webmsx' | 'procedural' {
    return this.routed.kind
  }

  public get fallbackReason(): WebMsxFailure | null {
    return this.routed.fallbackReason
  }

  public get ready(): Promise<'webmsx' | 'procedural'> {
    return this.routed.ready
  }

  public get width(): number {
    return this.routed.width
  }

  public get height(): number {
    return this.routed.height
  }

  /** Saída do tubo, pronta para o material da tela. Identidade estável. */
  public get texture(): THREE.Texture {
    return this.crt.texture
  }

  /** Textura crua do emulador, antes do vidro. Útil para depuração. */
  public get rawTexture(): THREE.Texture {
    return this.routed.texture
  }

  /** ROM local do cartucho preto — ver {@link RoutedScreenSource.setLocalRom}. */
  public setLocalRom(bytes: Uint8Array | null): void {
    this.routed.setLocalRom(bytes)
  }

  public start(signal?: AbortSignal): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('O pipeline de tela já foi descartado.'))
    this.warmup.powerOn()
    this.markCrtDirty()
    return this.routed.start(signal)
  }

  public stop(): void {
    this.warmup.powerOff()
    this.routed.stop()
    this.markCrtDirty()
  }

  public reset(): void {
    this.routed.reset()
    this.markCrtDirty()
  }

  public sendKey(code: string, down: boolean): void {
    this.routed.sendKey(code, down)
  }

  public insertCartridge(slot: 'A' | 'B', romId: string): Promise<void> {
    return this.routed.insertCartridge(slot, romId)
  }

  public ejectCartridge(slot: 'A' | 'B'): void {
    this.routed.ejectCartridge(slot)
  }

  public update(dt: number): void {
    if (this.disposed) return
    this.routed.update(dt)
    // O VDP pode trocar de modo e mudar o quadro do sinal. Reconciliar aqui é
    // barato e evita que o tubo fique espaçando scanline pelo tamanho errado.
    const size = this.crt.sourceSize
    if (size.x !== this.routed.width || size.y !== this.routed.height) {
      this.crt.setSource(this.routed.texture, this.routed.width, this.routed.height)
      this.markCrtDirty()
    }
    this.updateCrtSize(this.renderer)
    const tickDt = Math.max(dt, 0)
    this.crtFrameDebt += tickDt
    this.crtElapsed += tickDt
    if (
      !this.crtDirty &&
      this.crtFrameDebt + ScreenPipeline.CRT_FRAME_TOLERANCE <
        ScreenPipeline.CRT_FRAME_INTERVAL
    ) {
      return
    }
    const renderDt = this.crtElapsed
    this.crtElapsed = 0
    if (this.crtDirty) this.crtFrameDebt = Math.min(this.crtFrameDebt, ScreenPipeline.CRT_FRAME_INTERVAL)
    this.crtFrameDebt = Math.max(0, this.crtFrameDebt - ScreenPipeline.CRT_FRAME_INTERVAL)
    this.crtDirty = false
    this.crt.setWarmup(this.warmup.update(renderDt))
    this.renderCrt(this.renderer, renderDt)
  }

  public setTuning(patch: Partial<CrtTuning>): void {
    this.crt.setTuning(patch)
    this.markCrtDirty()
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.crt.dispose()
    this.routed.dispose()
  }

  private renderCrt(renderer: THREE.WebGLRenderer, dt: number): void {
    if (this.processingFailed) return
    try {
      this.crt.render(renderer, dt)
    } catch (error) {
      if (this.routed.handleRuntimeFailure(error)) {
        this.crt.setSource(this.routed.texture, this.routed.width, this.routed.height)
        this.markCrtDirty()
        return
      }
      this.processingFailed = true
      this.onNotice?.('O processamento do tubo falhou; a imagem foi preservada.')
      console.warn('[MSX] processamento do tubo interrompido após uma falha.', error)
    }
  }

  private markCrtDirty(): void {
    this.crtDirty = true
  }

  private updateCrtSize(renderer: THREE.WebGLRenderer): void {
    if (!this.autoSizeCrt) return
    const sourceWidth = Math.max(this.routed.width, 1)
    const sourceHeight = Math.max(this.routed.height, 1)
    const baseWidth = 1536
    const baseHeight = 1152
    const minScale = Math.max(
      (sourceWidth * 2) / baseWidth,
      (sourceHeight * 2) / baseHeight,
    )
    const scale = Math.min(
      1,
      Math.max(minScale, renderer.domElement.width / baseWidth),
    )
    if (this.crt.setSize(Math.round(baseWidth * scale), Math.round(baseHeight * scale))) {
      this.markCrtDirty()
    }
  }
}
