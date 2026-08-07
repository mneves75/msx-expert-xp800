import * as THREE from 'three'
import type { MaterialLibrary, ModuleContext, SceneModule } from './types'
import { CameraRig, type CameraRigOptions } from './CameraRig'

/**
 * Engine — renderer, scene graph, camera rig, clock, module registry and frame loop.
 *
 * Owns nothing visual. Every piece of the machine arrives as a {@link SceneModule}
 * from `src/models/*`, and lighting / post-processing plug in through
 * {@link Engine.setPipeline}. A module that throws is isolated, never fatal.
 */

/** Shadow map resolution every shadow-casting light in the scene should use. */
export const SHADOW_MAP_SIZE = 2048

/**
 * Rendered frames the loop always presents before it is allowed to sleep. Covers the
 * two-tick ready handshake and every render-coupled warm-up that counts *presented*
 * frames — the Desk reads its contact shadows on rendered frame 8.
 */
const WARM_FRAMES = 12
const TARGET_PRESENTATION_MS = 1000 / 60
const MAX_DRAWING_BUFFER_PIXELS = 2560 * 1440

/**
 * Anything that can take over presentation from `renderer.render()`.
 *
 * Deliberately structurally compatible with `postprocessing`'s `EffectComposer`
 * (`render(deltaTime?)` + `setSize(width, height)`), so `PostFX.ts` can return a raw
 * composer and it will just work.
 */
export interface RenderPipeline {
  render(deltaTime: number): void
  setSize?(width: number, height: number): void
  dispose?(): void
}

/**
 * What modules actually receive. Structurally a {@link ModuleContext}, plus the engine
 * and camera rig for the interaction / UI layers that need to drive the view.
 */
export interface AppContext extends ModuleContext {
  readonly engine: Engine
  readonly cameraRig: CameraRig
}

export interface EngineOptions {
  /** Element the canvas is appended to. Must be sized by CSS. */
  readonly container: HTMLElement
  /** Vertical FOV in degrees. Default 30 — a product-photography lens, not a game cam. */
  readonly fov?: number
  readonly near?: number
  readonly far?: number
  /** devicePixelRatio ceiling. Default 2. */
  readonly maxPixelRatio?: number
  readonly toneMapping?: THREE.ToneMapping
  readonly exposure?: number
  /**
   * Default `PCFShadowMap`. three r185 removed `PCFSoftShadowMap` (it silently degrades
   * to PCF and logs a deprecation), so softness now comes from per-light
   * `shadow.radius` / `blurSamples`, or from `VSMShadowMap` if the lighting rig opts in.
   */
  readonly shadowMapType?: THREE.ShadowMapType
  readonly cameraRig?: CameraRigOptions
}

function isLightWithShadow(o: THREE.Object3D): o is THREE.Object3D & { shadow: THREE.LightShadow } {
  const candidate = o as unknown as { isLight?: unknown; shadow?: unknown }
  return candidate.isLight === true && typeof candidate.shadow === 'object' && candidate.shadow !== null
}

function disposeMaterial(material: THREE.Material): void {
  const record = material as unknown as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const value = record[key]
    if (value instanceof THREE.Texture) value.dispose()
  }
  material.dispose()
}

/**
 * Deep-release a standalone object tree whose geometry, materials and textures have
 * exactly one owner. Scene modules must use their own `dispose()` instead because their
 * groups can contain shared library materials and borrowed interaction geometry.
 */
export function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as unknown as {
      geometry?: THREE.BufferGeometry
      material?: THREE.Material | THREE.Material[]
    }
    mesh.geometry?.dispose()
    const material = mesh.material
    if (Array.isArray(material)) for (const m of material) disposeMaterial(m)
    else if (material) disposeMaterial(material)
  })
}

/** Report whether the browser can give us a WebGL2 context at all. */
export function isWebGL2Available(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return canvas.getContext('webgl2') !== null
  } catch {
    return false
  }
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly clock: THREE.Clock
  readonly cameraRig: CameraRig
  readonly container: HTMLElement

  private maxPixelRatio: number
  private readonly modules: SceneModule[] = []
  private readonly groups = new Map<SceneModule, THREE.Group>()
  private readonly pendingRegistrations = new Map<SceneModule, Promise<THREE.Group>>()
  /** Modules whose `update()` threw — muted so one bad frame does not kill the loop. */
  private readonly mutedUpdates = new Set<SceneModule>()

  private readonly directToneMapping: THREE.ToneMapping
  private materialLibrary: MaterialLibrary | null = null
  private cachedContext: AppContext | null = null
  private pipeline: RenderPipeline | null = null

  private rafId = 0
  private running = false
  private frames = 0
  private pendingReady = false
  private ready = false
  /** Frames explicitly requested by `requestRender` that must still be presented. */
  private framesRequested = 0
  private lastRafAt = 0
  private presentationBudgetMs = TARGET_PRESENTATION_MS
  private presentationRateLimited = true
  private presentedAt = 0
  /** Reversible resolution cap owned by the adaptive-quality controller. */
  private adaptivePixelRatioCap: number | null = null
  /** Last presented camera state; a change means the frame must be presented. */
  private readonly cameraSnapshot = new Float64Array(32)
  private cameraSnapshotValid = false
  private readonly readyCallbacks: Array<() => void> = []
  private readonly resizeCallbacks: Array<(w: number, h: number, dpr: number) => void> = []
  private readonly frameCallbacks: Array<(dt: number, elapsed: number, willRender: boolean) => void> = []

  private resizeObserver: ResizeObserver | null = null
  private dprQuery: MediaQueryList | null = null
  private lifecycleGeneration = 0
  private disposed = false

  constructor(options: EngineOptions) {
    THREE.ColorManagement.enabled = true

    this.container = options.container
    this.maxPixelRatio = options.maxPixelRatio ?? 2

    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-label', 'Cena 3D do Gradiente Expert XP-800')
    this.container.appendChild(canvas)

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // Antialiasing is handled downstream by the post-processing chain (SMAA/TAA).
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    })

    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = options.toneMapping ?? THREE.AgXToneMapping
    this.directToneMapping = this.renderer.toneMapping
    // 0,72 medido, não chutado: varredura de exposição com leitura de ROI sobre as
    // capas QWERTY (tools/tune-exposure.mjs) — 0,72 põe a capa em rgb(184,181,175)
    // contra o alvo da SPEC §3.2 rgb(184,181,172) (#B8B5AC). 1,0 estourava meio
    // stop e dessaturava o conjunto (achado do crítico de iluminação, r1).
    this.renderer.toneMappingExposure = options.exposure ?? 0.72
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = options.shadowMapType ?? THREE.PCFShadowMap
    // A cena é estática quase sempre, mas com `autoUpdate` o three redesenha o atlas de
    // sombra inteiro TODO quadro — medidos 94 draw calls/quadro (18% do total) parados.
    // Congelado, quem move geometria projetora levanta `shadowMap.needsUpdate` no quadro
    // em que escreve a transformação (contrato em types.ts). Invariante: o flag é
    // consumido pelo PRIMEIRO `renderer.render()` depois de setado, então o RenderPass
    // da cena precisa continuar sendo o primeiro passe do composer — `start()` re-arma o
    // flag porque o aquecimento do boot renderiza com a cena parcialmente oculta.
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.needsUpdate = true
    this.renderer.setClearColor(0x08080a, 1)
    // Um contexto restaurado volta com todos os render targets vazios: sombra e quadro
    // precisam ser redesenhados ou a cena congelada fica preta.
    canvas.addEventListener('webglcontextrestored', this.onContextRestored)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x08080a)

    this.camera = new THREE.PerspectiveCamera(
      options.fov ?? 30,
      1,
      options.near ?? 0.01,
      options.far ?? 60,
    )
    this.camera.name = 'camera-principal'
    this.scene.add(this.camera)

    // `THREE.Clock` is soft-deprecated in favour of `THREE.Timer`, but `ModuleContext`
    // in types.ts pins the shared contract to `THREE.Clock`. Contract wins.
    this.clock = new THREE.Clock(false)
    this.cameraRig = new CameraRig(this.camera, canvas, options.cameraRig ?? {})

    this.attachResize()
    this.handleResize()
  }

  // ── Materials & context ─────────────────────────────────────────────────────

  /** Must be called before the first {@link register}. */
  setMaterials(library: MaterialLibrary): void {
    this.materialLibrary = library
    this.cachedContext = null
  }

  get context(): AppContext {
    if (!this.materialLibrary) {
      throw new Error(
        'Engine: biblioteca de materiais ausente — chame setMaterials() antes de registrar módulos.',
      )
    }
    if (!this.cachedContext) {
      this.cachedContext = {
        scene: this.scene,
        renderer: this.renderer,
        camera: this.camera,
        materials: this.materialLibrary,
        clock: this.clock,
        engine: this,
        cameraRig: this.cameraRig,
      }
    }
    return this.cachedContext
  }

  // ── Module registry ─────────────────────────────────────────────────────────

  /**
   * Build a module and add its group to the scene. Rejects if `build()` throws —
   * callers are expected to catch so a single broken module cannot blank the scene.
   */
  async register(module: SceneModule): Promise<THREE.Group> {
    if (this.disposed) {
      throw new Error(`Engine: não é possível registrar "${module.name}" após o descarte.`)
    }

    const existing = this.groups.get(module)
    if (existing !== undefined) return existing

    const pending = this.pendingRegistrations.get(module)
    if (pending !== undefined) return pending

    const generation = this.lifecycleGeneration
    const registration = this.buildAndCommit(module, generation)
    this.pendingRegistrations.set(module, registration)

    try {
      return await registration
    } finally {
      if (this.pendingRegistrations.get(module) === registration) {
        this.pendingRegistrations.delete(module)
      }
    }
  }

  unregister(module: SceneModule): void {
    const index = this.modules.indexOf(module)
    const group = this.groups.get(module)
    if (index === -1 && group === undefined) {
      this.mutedUpdates.delete(module)
      return
    }

    if (index !== -1) this.modules.splice(index, 1)
    if (group) {
      this.scene.remove(group)
      this.groups.delete(module)
    }
    this.mutedUpdates.delete(module)
    this.disposeModule(module)
  }

  getGroup(module: SceneModule): THREE.Group | undefined {
    return this.groups.get(module)
  }

  get moduleNames(): readonly string[] {
    return this.modules.map((m) => m.name)
  }

  // ── Presentation ────────────────────────────────────────────────────────────

  /** Hand presentation to a post-processing pipeline. Pass `null` to render direct. */
  setPipeline(pipeline: RenderPipeline | null): void {
    if (this.disposed) {
      throw new Error('Engine: não é possível instalar um pipeline após o descarte.')
    }
    if (pipeline) {
      const { width, height } = this.viewportSize()
      pipeline.setSize?.(width, height)
    } else {
      this.restoreDirectRendering()
    }
    this.pipeline = pipeline
    this.requestRender(2)
  }

  get renderPipeline(): RenderPipeline | null {
    return this.pipeline
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start(): void {
    if (this.running || this.disposed) return
    this.running = true
    this.lastRafAt = 0
    this.presentationBudgetMs = TARGET_PRESENTATION_MS
    // O aquecimento do boot renderiza com a cena parcialmente revelada e consome o
    // needsUpdate inicial — o primeiro quadro real precisa de um atlas completo.
    this.renderer.shadowMap.needsUpdate = true
    this.clock.start()
    this.rafId = requestAnimationFrame(this.tick)
  }

  /**
   * Garante que os próximos `frames` quadros sejam apresentados mesmo com a cena
   * assentada. É o canal de acordar para mutações que o loop não enxerga: mudanças
   * externas via `window.__msx` (exposição, efeitos, visibilidade de objetos),
   * resize, restauração de contexto.
   */
  requestRender(frames = 1): void {
    this.framesRequested = Math.max(this.framesRequested, Math.max(1, Math.floor(frames)))
  }

  /** Desliga o teto de 60 Hz durante medições de custo bruto em `tools/profile.mjs`. */
  setPresentationRateLimited(enabled: boolean): void {
    this.presentationRateLimited = enabled
    this.presentationBudgetMs = TARGET_PRESENTATION_MS
    this.requestRender(2)
  }

  /**
   * Teto de pixel ratio REVERSÍVEL, de posse do controlador de qualidade adaptativa.
   * Compõe com `maxPixelRatio` (o teto permanente do caso software-renderer) por
   * `min()`; `null` remove o teto. Passa pelo mesmo `handleResize` de sempre — o único
   * caminho de resize que o postprocessing atravessa sem reter viewport velho.
   */
  setAdaptivePixelRatioCap(limit: number | null): void {
    this.adaptivePixelRatioCap = limit === null ? null : Math.max(0.25, limit)
    this.handleResize()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    cancelAnimationFrame(this.rafId)
    this.clock.stop()
  }

  /** Fires once the first frame has been presented (not merely submitted). */
  onReady(callback: () => void): void {
    if (this.ready) {
      callback()
      return
    }
    this.readyCallbacks.push(callback)
  }

  get isReady(): boolean {
    return this.ready
  }

  get lastPresentedAt(): number {
    return this.presentedAt
  }

  onResize(callback: (width: number, height: number, pixelRatio: number) => void): void {
    this.resizeCallbacks.push(callback)
  }

  /**
   * Per-frame hook for systems that are not scene modules (interaction, HUD).
   * `willRender` diz se ESTE tick vai apresentar um quadro — com render-on-demand um
   * tick ocioso não renderiza, e medições de frame time só valem sobre quadros reais.
   */
  onFrame(callback: (dt: number, elapsed: number, willRender: boolean) => void): void {
    this.frameCallbacks.push(callback)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifecycleGeneration += 1
    this.stop()
    this.detachResize()
    for (const module of [...this.modules].reverse()) this.unregister(module)
    this.cameraRig.dispose()
    this.disposePipeline(this.pipeline)
    this.pipeline = null
    this.materialLibrary = null
    this.cachedContext = null
    this.readyCallbacks.length = 0
    this.resizeCallbacks.length = 0
    this.frameCallbacks.length = 0
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored)
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  private readonly tick = (): void => {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this.tick)
    const tickAt = performance.now()
    if (this.lastRafAt > 0) {
      this.presentationBudgetMs = Math.min(
        TARGET_PRESENTATION_MS * 2,
        this.presentationBudgetMs + tickAt - this.lastRafAt,
      )
    } else {
      this.presentationBudgetMs = TARGET_PRESENTATION_MS
    }
    this.lastRafAt = tickAt

    // The previous frame has now been handed to the compositor.
    if (this.pendingReady) {
      this.pendingReady = false
      this.ready = true
      const callbacks = this.readyCallbacks.splice(0, this.readyCallbacks.length)
      for (const callback of callbacks) {
        try {
          callback()
        } catch (error) {
          console.error('[Engine] callback de "pronto" falhou:', error)
        }
      }
    }

    // Clamp so a backgrounded tab does not resume with a multi-second step.
    const dt = Math.min(this.clock.getDelta(), 1 / 15)
    const elapsed = this.clock.elapsedTime

    // Rig e updates rodam SEMPRE — custam microssegundos e carregam os relógios de
    // idle/auto-rotate e o acordar das molas. O que o render-on-demand pula é só a
    // apresentação: os ~28 ms/quadro de passes e draw calls medidos no baseline.
    this.cameraRig.update(dt)

    let modulesActive = false
    for (const module of this.modules) {
      if (!module.update || this.mutedUpdates.has(module)) continue
      try {
        // `false` = assentado; `true`/`undefined` mantêm o quadro (conservador).
        if (module.update(dt, elapsed) !== false) modulesActive = true
      } catch (error) {
        this.mutedUpdates.add(module)
        console.error(
          `[Engine] update() do módulo "${module.name}" falhou — silenciado para o resto da sessão:`,
          error,
        )
      }
    }

    const cameraChanged = this.cameraStateChanged()
    const wantsPresentation =
      this.frames < WARM_FRAMES ||
      this.framesRequested > 0 ||
      modulesActive ||
      !this.cameraRig.isSettled ||
      cameraChanged
    if (!wantsPresentation) this.presentationBudgetMs = TARGET_PRESENTATION_MS
    const present =
      wantsPresentation &&
      (!this.presentationRateLimited ||
        this.presentationBudgetMs + 0.25 >= TARGET_PRESENTATION_MS)

    for (const callback of this.frameCallbacks) {
      try {
        callback(dt, elapsed, present)
      } catch (error) {
        console.error('[Engine] callback de frame falhou:', error)
      }
    }

    if (!present) return
    this.presentationBudgetMs = Math.max(0, this.presentationBudgetMs - TARGET_PRESENTATION_MS)
    if (this.framesRequested > 0) this.framesRequested -= 1
    const presentationDt =
      this.presentedAt > 0 ? Math.min((tickAt - this.presentedAt) / 1000, 1 / 15) : dt

    for (const module of this.modules) {
      if (!module.beforeRender || this.mutedUpdates.has(module)) continue
      try {
        module.beforeRender(presentationDt, elapsed)
      } catch (error) {
        this.mutedUpdates.add(module)
        console.error(
          `[Engine] beforeRender() do módulo "${module.name}" falhou — silenciado para o resto da sessão:`,
          error,
        )
      }
    }

    try {
      if (this.pipeline) this.pipeline.render(presentationDt)
      else this.renderer.render(this.scene, this.camera)
    } catch (error) {
      console.error('[Engine] erro de renderização:', error)
      if (this.pipeline) {
        // Fall back to direct rendering rather than presenting nothing at all.
        console.warn('[Engine] desativando o pipeline de pós-processamento.')
        const failedPipeline = this.pipeline
        this.disposePipeline(failedPipeline)
        if (this.pipeline === failedPipeline) this.pipeline = null
        this.restoreDirectRendering()
        try {
          this.renderer.render(this.scene, this.camera)
        } catch (directError) {
          console.error('[Engine] erro no fallback de renderização direta:', directError)
          this.stop()
          return
        }
      } else {
        this.stop()
        return
      }
    }

    this.frames += 1
    this.presentedAt = tickAt
    if (cameraChanged) this.commitCameraSnapshot()
    if (this.frames === 1) this.pendingReady = true
  }

  /**
   * A câmera mudou desde o último quadro apresentado? Compara `matrixWorld` e
   * `projectionMatrix` byte a byte — pega o damping do rig, o auto-rotate, o
   * `jumpTo` instantâneo do harness e um override de FOV via console, sem depender
   * de quem causou a mudança. O snap do CameraRig garante convergência em tempo
   * finito, então isto não vira um "sempre true" perseguindo deltas de 1e-16.
   */
  private cameraStateChanged(): boolean {
    const world = this.camera.matrixWorld.elements
    const projection = this.camera.projectionMatrix.elements
    const snapshot = this.cameraSnapshot
    let changed = !this.cameraSnapshotValid
    for (let i = 0; i < 16; i++) {
      const w = world[i] ?? 0
      const p = projection[i] ?? 0
      if (snapshot[i] !== w || snapshot[i + 16] !== p) changed = true
    }
    return changed
  }

  private commitCameraSnapshot(): void {
    const world = this.camera.matrixWorld.elements
    const projection = this.camera.projectionMatrix.elements
    const snapshot = this.cameraSnapshot
    for (let i = 0; i < 16; i++) {
      snapshot[i] = world[i] ?? 0
      snapshot[i + 16] = projection[i] ?? 0
    }
    this.cameraSnapshotValid = true
  }

  private readonly onContextRestored = (): void => {
    this.renderer.shadowMap.needsUpdate = true
    this.requestRender(2)
  }

  // ── Sizing ──────────────────────────────────────────────────────────────────

  /**
   * Re-deriva tamanho e pixel ratio do container real e propaga a renderer,
   * câmera e pipeline. Para quem mexe temporariamente no tamanho do renderer
   * (aquecimento de GPU no boot) e precisa restaurar o estado VERDADEIRO — a
   * janela pode ter sido redimensionada no meio, então "restaurar o valor
   * capturado antes" restauraria um tamanho velho.
   */
  syncViewport(): void {
    this.handleResize()
  }

  /**
   * Teto permanente de pixel ratio — sobrevive a todo resize futuro. É o
   * mecanismo da qualidade adaptativa (rasterizador de software): mexer só em
   * `renderer.setPixelRatio` seria desfeito pelo próximo `handleResize`.
   */
  capPixelRatio(limit: number): void {
    this.maxPixelRatio = Math.min(this.maxPixelRatio, Math.max(0.25, limit))
    this.handleResize()
  }

  /**
   * Teto TEMPORÁRIO, para o aquecimento do boot: devolve uma função que
   * restaura o teto anterior. Passa pelo MESMO caminho de um resize de janela
   * (handleResize → renderer + pipeline), o único que o postprocessing
   * comprovadamente atravessa sem reter viewport velho — redimensionar o
   * composer por fora deixava o passe final preso no retângulo pequeno.
   */
  withPixelRatioCeiling(limit: number): () => void {
    const previous = this.maxPixelRatio
    this.maxPixelRatio = Math.max(0.01, limit)
    this.handleResize()
    return () => {
      this.maxPixelRatio = previous
      this.handleResize()
    }
  }

  private viewportSize(): { width: number; height: number; pixelRatio: number } {
    const width = Math.max(1, this.container.clientWidth || window.innerWidth)
    const height = Math.max(1, this.container.clientHeight || window.innerHeight)
    const ratioCap = Math.sqrt(MAX_DRAWING_BUFFER_PIXELS / (width * height))
    const pixelRatio = Math.min(
      window.devicePixelRatio || 1,
      this.maxPixelRatio,
      this.adaptivePixelRatioCap ?? Number.POSITIVE_INFINITY,
      ratioCap,
    )
    return { width, height, pixelRatio }
  }

  private readonly handleResize = (): void => {
    if (this.disposed) return
    const { width, height, pixelRatio } = this.viewportSize()

    this.renderer.setPixelRatio(pixelRatio)
    // updateStyle = false: the canvas is sized by CSS (100% of #app).
    this.renderer.setSize(width, height, false)

    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()

    this.pipeline?.setSize?.(width, height)
    // O quadro congelado ficou com o tamanho velho — apresente um fresco.
    this.requestRender(2)

    for (const callback of this.resizeCallbacks) {
      try {
        callback(width, height, pixelRatio)
      } catch (error) {
        console.error('[Engine] callback de resize falhou:', error)
      }
    }
    this.watchPixelRatio(pixelRatio)
  }

  private attachResize(): void {
    window.addEventListener('resize', this.handleResize)
    window.addEventListener('orientationchange', this.handleResize)
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.handleResize)
      this.resizeObserver.observe(this.container)
    }
  }

  private detachResize(): void {
    window.removeEventListener('resize', this.handleResize)
    window.removeEventListener('orientationchange', this.handleResize)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.dprQuery?.removeEventListener('change', this.handleResize)
    this.dprQuery = null
  }

  /** Catch a window being dragged between a Retina and a non-Retina display. */
  private watchPixelRatio(current: number): void {
    if (typeof window.matchMedia !== 'function') return
    this.dprQuery?.removeEventListener('change', this.handleResize)
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || current}dppx)`)
    query.addEventListener('change', this.handleResize)
    this.dprQuery = query
  }

  private async buildAndCommit(module: SceneModule, generation: number): Promise<THREE.Group> {
    let group: THREE.Group | null = null
    let committed = false

    try {
      group = await module.build(this.context)

      if (this.disposed || generation !== this.lifecycleGeneration) {
        throw new Error(`Engine: registro de "${module.name}" cancelado durante o descarte.`)
      }

      group.name = group.name || module.name
      this.normalizeShadows(group)
      this.scene.add(group)
      this.modules.push(module)
      this.groups.set(module, group)
      committed = true
      return group
    } catch (error) {
      if (!committed) {
        if (group !== null) this.scene.remove(group)
        this.disposeModule(module)
      }
      throw error
    }
  }

  private disposeModule(module: SceneModule): void {
    try {
      module.dispose?.()
    } catch (error) {
      console.error(`[Engine] falha ao descartar o módulo "${module.name}":`, error)
    }
  }

  private disposePipeline(pipeline: RenderPipeline | null): void {
    try {
      pipeline?.dispose?.()
    } catch (error) {
      console.error('[Engine] falha ao descartar o pipeline de renderização:', error)
    }
  }

  private restoreDirectRendering(): void {
    this.renderer.toneMapping = this.directToneMapping
    this.renderer.setRenderTarget(null)
  }

  /**
   * Enforce the project shadow budget on lights a module forgot to configure. Only
   * upgrades lights still sitting on three's 512² default — a deliberate choice is kept.
   */
  private normalizeShadows(root: THREE.Object3D): void {
    root.traverse((child) => {
      if (!isLightWithShadow(child)) return
      const size = child.shadow.mapSize
      if (size.width <= 512 && size.height <= 512) size.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
    })
  }
}
