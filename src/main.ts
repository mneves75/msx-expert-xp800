import * as THREE from 'three'
import { Engine, isWebGL2Available, type AppContext, type RenderPipeline } from './core/Engine'
import type { CameraPose, CameraRig } from './core/CameraRig'
import type { SceneModule } from './core/types'
import { createMaterialLibrary, type ManagedMaterialLibrary } from './core/Materials'
import { lightingModule } from './core/Lighting'
import { createPostFX, type PostFX } from './core/PostFX'
import { createAdaptiveQuality, type AdaptiveQualityHandle } from './core/AdaptiveQuality'
import { deskModule } from './models/Desk'
import { MainUnit } from './models/MainUnit'
import { createKeyboard } from './models/Keyboard'
import { crtMonitorModule } from './models/CrtMonitor'
import { CartridgeModule } from './models/Cartridge'
import { joystick } from './models/Joystick'
import { createInteractions, type InteractionsModule } from './interaction/Interactions'
import { createHud, destroyHud, type HudHandle } from './ui/Hud'
import { afterFirstPaint, yieldToMain } from './core/cooperative'

/**
 * Bootstrap.
 *
 * Assembles the Engine, builds the shared material library, registers every scene
 * module in back-to-front order, installs the post-processing pipeline, starts the
 * interaction and HUD layers, and publishes the capture-harness contract
 * (`window.__msxReady` / `window.__msxCamera`) that `tools/shoot.mjs` drives.
 *
 * Wiring is **explicit and statically typed**. Every module is imported by name, so a
 * renamed export or a changed signature is a compile error here rather than a module
 * that silently never makes it into the scene.
 *
 * Required scene, interaction, HUD and PostFX components fail the boot closed. Optional
 * prewarming and adaptive quality may degrade without falsifying readiness.
 */

// ─── Capture harness contract ────────────────────────────────────────────────────
// Declared here rather than in a .d.ts so the contract lives next to its implementation.

declare global {
  interface Window {
    /** `true` once the scene is built AND the first frame has been presented. */
    __msxReady?: boolean
    /**
     * Jump the camera to a pose instantly (no damping), for screenshot capture.
     * Angles in degrees, distance in metres, `target` as `[x, y, z]` or `{x, y, z}`.
     */
    __msxCamera?: (pose: CameraPose) => void
    /** Debug handle for the interaction / UI layers and critic tooling. */
    __msx?: {
      readonly engine: Engine
      readonly cameraRig: CameraRig
      readonly scene: THREE.Scene
      readonly modules: readonly string[]
      readonly interactions: InteractionsModule | null
      readonly hud: HudHandle | null
      readonly postFX: PostFX | null
      /**
       * Controlador de qualidade adaptativa. Sob automação nasce travado no tier 0;
       * tools podem `lock(n)`/`unlock()` para A/B de degraus.
       */
      readonly adaptiveQuality: AdaptiveQualityHandle | null
      /** Re-exported so tooling can measure the scene without a second three.js copy. */
      readonly three: typeof THREE
    }
  }
}

// ─── Boot veil ───────────────────────────────────────────────────────────────────

function hideBootVeil(): void {
  const veil = document.getElementById('boot')
  if (!veil) return
  veil.hidden = true
  window.setTimeout(() => veil.remove(), 1200)
}

function showBootMessage(message: string): void {
  const veil = document.getElementById('boot')
  const paragraph = veil?.querySelector('p')
  if (paragraph) paragraph.textContent = message
}

// ─── Registration ────────────────────────────────────────────────────────────────

/**
 * Build one required module into the scene. A rejection aborts the bootstrap so
 * window.__msxReady can never describe a partial reconstruction.
 */
async function register(engine: Engine, module: SceneModule): Promise<THREE.Group> {
  // Fronteira de tarefa entre módulos: junto com os geradores cooperativos das
  // texturas, é o que mantém o boot em fatias curtas (TBT ≈ 0) em vez de uma
  // tarefa longa única por módulo.
  await yieldToMain()
  return engine.register(module)
}

/**
 * Sobe as texturas da cena para a GPU uma a uma, cada upload na sua própria
 * fatia. Sem isto o primeiro quadro paga todos os `texImage2D` de uma vez —
 * era a maior tarefa única do boot depois da geração procedural.
 */
async function preuploadTextures(engine: Engine): Promise<void> {
  const seen = new Set<THREE.Texture>()
  const collect = (value: unknown): void => {
    if (value instanceof THREE.Texture) seen.add(value)
  }
  engine.scene.traverse((object) => {
    const mesh = object as Partial<THREE.Mesh>
    const material = mesh.material
    const list = Array.isArray(material) ? material : material !== undefined ? [material] : []
    for (const mat of list) {
      for (const slot of Object.values(mat)) collect(slot)
    }
  })
  collect(engine.scene.environment)
  collect(engine.scene.background)
  for (const texture of seen) {
    try {
      engine.renderer.initTexture(texture)
    } catch {
      // Upload adiantado é otimização: se falhar, o three sobe no primeiro uso.
    }
    await yieldToMain()
  }
}

function createParallelCompiler(
  engine: Engine,
  isCancelled: () => boolean,
): {
  submit(root: THREE.Object3D): void
  whenDone(): Promise<void>
} {
  const supported =
    engine.renderer.getContext().getExtension('KHR_parallel_shader_compile') !== null
  const compiles: Promise<unknown>[] = []
  let started = false

  return {
    submit(root): void {
      if (!supported || isCancelled()) return
      if (!started) {
        performance.mark('msx:compile-kickoff')
        started = true
      }
      try {
        compiles.push(
          engine.renderer
            .compileAsync(root, engine.camera, engine.scene)
            .catch((error: unknown) => {
              console.warn(
                '[main] compilação paralela de shaders falhou — aquecimento fatiado continuará:',
                error,
              )
            }),
        )
      } catch (error) {
        console.warn(
          '[main] compilação paralela de shaders falhou — aquecimento fatiado continuará:',
          error,
        )
      }
    },
    whenDone: () => Promise.all(compiles).then(() => undefined),
  }
}

/**
 * WebGL rodando em rasterizador de software (SwiftShader/llvmpipe — VMs,
 * desktops remotos, auditores headless sem GPU). Nesses clientes um quadro
 * 1080p custa 200–300 ms de CPU: o app "roda" a 3 fps e cada quadro é uma
 * long task. Reduzir resolução e tier de qualidade devolve interatividade
 * real — é adaptação, não maquiagem.
 */
function isSoftwareRenderer(renderer: THREE.WebGLRenderer): boolean {
  try {
    const gl = renderer.getContext()
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    // Firefox não expõe a extensão; o RENDERER mascarado ainda denuncia
    // llvmpipe/software nas plataformas em que isso importa.
    const name = String(
      gl.getParameter(info !== null ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
    )
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)
  } catch {
    return false
  }
}

/**
 * Sobe buffers de geometria, mapas de sombra e programas para a GPU em lotes:
 * revela os meshes aos poucos, um render curto por lote, tudo atrás do véu
 * opaco. Sem isto o primeiro quadro real pagava o upload dos ~900k triângulos
 * e o primeiro passe de sombra/transmissão de uma vez — a última tarefa longa
 * do boot (~500 ms medidos). Renders anteriores ficam quentes, então o custo
 * de re-renderizar o já revelado é só submissão.
 */
async function warmSceneBuffers(engine: Engine, isCancelled: () => boolean): Promise<void> {
  const drawables: THREE.Object3D[] = []
  engine.scene.traverse((object) => {
    const mesh = object as Partial<THREE.Mesh> & THREE.Object3D
    if (mesh.isMesh === true) drawables.push(object)
  })
  // Meshes deliberadamente invisíveis (proxies de picking etc.) ficam de fora.
  const targets = drawables.filter((mesh) => mesh.visible)
  try {
    // Tudo que muda estado fica DENTRO do try: um throw em qualquer ponto passa
    // pelo finally, que devolve visibilidade e tamanho — nunca uma cena apagada.
    for (const mesh of targets) mesh.visible = false
    // Upload e compile independem da resolução; a rasterização não. Num ambiente
    // sem GPU (Lighthouse/CI rodam em SwiftShader) cada quadro de aquecimento em
    // resolução cheia custaria centenas de ms de CPU — em 32×18 custa quase nada.
    engine.renderer.setPixelRatio(1)
    engine.renderer.setSize(32, 18, false)
    const CHUNK = 8
    for (let i = 0; i < targets.length; i += CHUNK) {
      // Um descarte (HMR) pode chegar durante qualquer fatia: parar de renderizar
      // imediatamente — o `finally` ainda restaura visibilidade e tamanho.
      if (isCancelled()) return
      for (const mesh of targets.slice(i, i + CHUNK)) mesh.visible = true
      engine.renderer.render(engine.scene, engine.camera)
      await yieldToMain()
    }
  } finally {
    for (const mesh of targets) mesh.visible = true
    try {
      // Re-deriva do container em vez de restaurar o valor capturado: a janela
      // pode ter sido redimensionada durante as fatias. No-op se descartado.
      engine.syncViewport()
    } catch (error) {
      console.warn('[main] restauração de tamanho pós-aquecimento falhou:', error)
    }
  }
}

async function warmDeferredAOPass(
  engine: Engine,
  postFX: PostFX,
  adaptiveQuality: AdaptiveQualityHandle,
  isCancelled: () => boolean,
): Promise<void> {
  if (isCancelled() || adaptiveQuality.tier >= 2) return

  const warmPasses = postFX.composer.passes
  const enabledBefore = warmPasses.map((pass) => pass.enabled)
  let restoreRatio: (() => void) | null = null
  let warmed = false
  try {
    restoreRatio = engine.withPixelRatioCeiling(0.12)
    for (const pass of warmPasses) pass.enabled = false
    postFX.passes.ao.enabled = true
    postFX.composer.render(0)
    warmed = true
  } catch (error) {
    console.warn('[main] aquecimento adiado do AO falhou — AO permanecerá desligado:', error)
  } finally {
    warmPasses.forEach((pass, index) => {
      pass.enabled = enabledBefore[index] ?? true
    })
    try {
      restoreRatio?.()
    } catch (error) {
      warmed = false
      console.warn('[main] resize pós-aquecimento do AO falhou — AO permanecerá desligado:', error)
    }
  }

  if (!warmed || isCancelled() || adaptiveQuality.tier >= 2) return
  await yieldToMain()
  if (isCancelled() || adaptiveQuality.tier >= 2) return

  try {
    postFX.setAOEnabled(true)
    engine.requestRender(2)
  } catch (error) {
    postFX.setAOEnabled(false)
    console.warn('[main] ativação adiada do AO falhou — AO permanecerá desligado:', error)
  }
}

/**
 * Adapt {@link PostFX} to the engine's {@link RenderPipeline}.
 *
 * `PostFX` calls its resize entry point `resize()`, the engine calls it `setSize()`.
 * Without this adapter the composer keeps its construction-time buffers forever and the
 * image stretches the moment the window changes size.
 */
function asPipeline(postFX: PostFX): RenderPipeline {
  return {
    render: (deltaTime) => postFX.render(deltaTime),
    setSize: (width, height) => postFX.resize(width, height),
    dispose: () => postFX.dispose(),
  }
}

// ─── Application ownership ──────────────────────────────────────────────────────

class ApplicationOwner {
  private hud: HudHandle | null = null
  private adaptive: AdaptiveQualityHandle | null = null
  private disposed = false

  readonly cameraHandle = (pose: CameraPose): void => {
    if (!this.disposed) this.engine.cameraRig.jumpTo(pose)
  }

  constructor(
    readonly engine: Engine,
    readonly materials: ManagedMaterialLibrary,
  ) {}

  get isDisposed(): boolean {
    return this.disposed
  }

  publishCaptureGlobals(): void {
    window.__msxReady = false
    window.__msxCamera = this.cameraHandle
  }

  ownHud(hud: HudHandle): boolean {
    if (this.disposed) {
      destroyHud()
      return false
    }
    this.hud = hud
    return true
  }

  ownAdaptiveQuality(adaptive: AdaptiveQualityHandle): boolean {
    if (this.disposed) {
      adaptive.dispose()
      return false
    }
    this.adaptive = adaptive
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    try {
      if (this.hud !== null) destroyHud()
    } catch (error) {
      console.error('[main] falha ao descartar o HUD:', error)
    }
    this.hud = null

    try {
      this.adaptive?.dispose()
    } catch (error) {
      console.error('[main] falha ao descartar a qualidade adaptativa:', error)
    }
    this.adaptive = null

    try {
      // Engine owns the pipeline and disposes modules in reverse registration order.
      this.engine.dispose()
    } catch (error) {
      console.error('[main] falha ao descartar o motor:', error)
    }

    try {
      // Modules have released every borrowed material by this point. The application is
      // the sole owner of the shared library and disposes it exactly once.
      this.materials.dispose()
    } catch (error) {
      console.error('[main] falha ao descartar a biblioteca de materiais:', error)
    }

    if (window.__msx?.engine === this.engine) delete window.__msx
    if (window.__msxCamera === this.cameraHandle) {
      delete window.__msxCamera
      delete window.__msxReady
    }
  }
}

let activeApplication: ApplicationOwner | null = null

function disposeActiveApplication(): void {
  const application = activeApplication
  activeApplication = null
  application?.dispose()
}

if (import.meta.hot) {
  import.meta.hot.dispose(disposeActiveApplication)
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  const container = document.getElementById('app')
  if (!container) throw new Error('main: elemento #app não encontrado.')

  // O véu de boot pinta antes de qualquer trabalho pesado (contexto WebGL,
  // texturas, cena): primeiro quadro estável e imediato, boot logo em seguida.
  await afterFirstPaint()

  if (!isWebGL2Available()) {
    showBootMessage('Seu navegador não suporta WebGL2 — não é possível montar a cena.')
    return
  }

  const engine = new Engine({ container })
  let materials: ManagedMaterialLibrary
  try {
    materials = createMaterialLibrary(engine.renderer)
  } catch (error) {
    engine.dispose()
    throw error
  }
  const application = new ApplicationOwner(engine, materials)
  activeApplication = application
  // Published before the scene is built so the capture harness never races the loader.
  application.publishCaptureGlobals()

  try {
    engine.setMaterials(materials)
    const ctx: AppContext = engine.context
    const parallelCompiler = createParallelCompiler(engine, () => application.isDisposed)
    const deferAOWarm =
      window.matchMedia('(pointer: coarse)').matches && navigator.webdriver !== true

    // Pré-aquecimento cooperativo das texturas caras: o trabalho é o mesmo,
    // mas em tarefas curtas — os builds abaixo acham tudo em cache. Falhar
    // aqui não é fatal: o caminho síncrono continua existindo.
    performance.mark('msx:prewarm')
    try {
      await materials.prewarm()
    } catch (error) {
      console.warn('[main] pré-aquecimento de texturas falhou — geração síncrona:', error)
    }
    if (application.isDisposed) return

    // Lighting first: every model samples `scene.environment` while building.
    const lightingRoot = await register(engine, lightingModule)
    if (application.isDisposed) return
    parallelCompiler.submit(lightingRoot)

    // Back to front, so the scene graph reads the way the set is laid out.
    const deskRoot = await register(engine, deskModule)
    if (application.isDisposed) return
    parallelCompiler.submit(deskRoot)
    const mainUnitRoot = await register(engine, MainUnit)
    if (application.isDisposed) return
    parallelCompiler.submit(mainUnitRoot)
    const keyboardRoot = await register(engine, createKeyboard())
    if (application.isDisposed) return
    parallelCompiler.submit(keyboardRoot)
    const crtRoot = await register(engine, crtMonitorModule)
    if (application.isDisposed) return
    parallelCompiler.submit(crtRoot)
    const cartridgeRoot = await register(engine, CartridgeModule)
    if (application.isDisposed) return
    parallelCompiler.submit(cartridgeRoot)
    const joystickRoot = await register(engine, joystick)
    if (application.isDisposed) return
    parallelCompiler.submit(joystickRoot)

    performance.mark('msx:modules-done')
    let postFX: PostFX
    let postFXCandidate: PostFX | null = null
    try {
      postFXCandidate = await createPostFX(engine.renderer, engine.scene, engine.camera)
      // A montagem agora cede o main thread: um descarte (HMR) pode acontecer no
      // meio. Instalar o pipeline num engine já descartado vazaria o composer.
      if (application.isDisposed) {
        postFXCandidate.dispose()
        return
      }
      engine.setPipeline(asPipeline(postFXCandidate))
      postFX = postFXCandidate
    } catch (error) {
      try {
        postFXCandidate?.dispose()
      } catch (cleanupError) {
        console.error('[main] falha ao limpar o pós-processamento incompleto:', cleanupError)
      }
      throw new Error('Falha ao instalar o pós-processamento obrigatório.', { cause: error })
    }

    // Interaction layer: it is itself a SceneModule (it owns the hover highlight and the
    // cables), and its `build()` binds to the models already in the scene.
    const interactions: InteractionsModule = createInteractions(ctx)
    await register(engine, interactions)

    if (application.isDisposed) return

    performance.mark('msx:postfx-done')
    try {
      await preuploadTextures(engine)
    } catch (error) {
      console.warn('[main] pré-upload de texturas falhou — upload no primeiro uso:', error)
    }

    if (application.isDisposed) return

    // Compila os programas da cena com KHR_parallel_shader_compile (o driver
    // trabalha fora do main thread) e aquece cada passe do composer na sua
    // própria fatia — atrás do véu opaco, então nenhum quadro de aquecimento é
    // visível. Sem isto o primeiro quadro pagava TODOS os compiles de uma vez:
    // a última tarefa longa do boot (~560 ms medidos em produção).
    performance.mark('msx:preupload-done')
    const softwareRenderer = isSoftwareRenderer(engine.renderer)
    if (softwareRenderer) {
      postFX.setQuality('low')
      // Teto no Engine, não `setPixelRatio` direto: o próximo resize desfaria.
      engine.capPixelRatio(0.5)
      console.info('[main] rasterizador de software detectado — resolução e qualidade reduzidas.')
    }

    if (postFX !== null) {
      const warmPasses = postFX.composer.passes
      const enabledBefore = warmPasses.map((pass) => pass.enabled)
      // Compilar passes não depende da resolução: o aquecimento roda com um teto
      // temporário de pixel ratio, pelo MESMO caminho de um resize de janela.
      // Chamar `postFX.resize` pequeno e restaurar por fora deixava o passe
      // final do composer preso no retângulo pequeno (medido: cena num canto
      // 256×144 e gate visual vermelho).
      const restoreRatio = engine.withPixelRatioCeiling(0.12)
      try {
        for (const pass of warmPasses) pass.enabled = false
        for (const pass of warmPasses) {
          if (application.isDisposed) break
          if (deferAOWarm && pass === postFX.passes.ao) continue
          pass.enabled = true
          postFX.composer.render(0)
          pass.enabled = false
          await yieldToMain()
        }
      } catch (error) {
        console.warn('[main] aquecimento do pós-processamento falhou — compila no primeiro uso:', error)
      } finally {
        warmPasses.forEach((pass, index) => {
          pass.enabled = enabledBefore[index] ?? true
        })
        // Nunca deixar o `finally` lançar: um descarte concorrente durante o
        // aquecimento tornaria o resize inválido e abortaria o bootstrap inteiro.
        try {
          restoreRatio()
        } catch (error) {
          console.warn('[main] resize pós-aquecimento falhou:', error)
        }
      }
    }

    if (application.isDisposed) return
    performance.mark('msx:fxwarm-done')

    // Cada raiz foi submetida logo após seu registro, em tarefas já fatiadas.
    // Enquanto texturas e passes PostFX ocupavam o main thread, o driver ligava
    // os programas da cena em paralelo; só esperamos a ligação aqui. Os renders
    // seguintes permanecem porque ainda sobem buffers e mapas de sombra.
    await parallelCompiler.whenDone()
    if (application.isDisposed) return
    performance.mark('msx:link-done')

    try {
      await warmSceneBuffers(engine, () => application.isDisposed)
    } catch (error) {
      console.warn('[main] aquecimento da geometria falhou — upload no primeiro uso:', error)
    }
    if (application.isDisposed) return
    performance.mark('msx:scenewarm-done')

    const hudCandidate = createHud(interactions)
    const hud: HudHandle | null = application.ownHud(hudCandidate) ? hudCandidate : null

    if (application.isDisposed || activeApplication !== application) return

    // Qualidade adaptativa por medição (Windows/iGPU em D3D11 é o alvo típico).
    // No rasterizador de software o boot já travou low + meia resolução — o
    // controlador nasce travado no degrau equivalente para não medir por cima.
    let adaptiveQuality: AdaptiveQualityHandle | null = null
    try {
      const candidate = createAdaptiveQuality(engine, postFX)
      if (application.ownAdaptiveQuality(candidate)) {
        adaptiveQuality = candidate
        if (softwareRenderer) candidate.lock(1)
      }
    } catch (error) {
      console.error('[main] a qualidade adaptativa não subiu:', error)
    }

    if (application.isDisposed || activeApplication !== application) return
    if (deferAOWarm) postFX.setAOEnabled(false)

    window.__msx = {
      engine,
      cameraRig: engine.cameraRig,
      scene: engine.scene,
      modules: engine.moduleNames,
      interactions,
      hud,
      postFX,
      adaptiveQuality,
      three: THREE,
    }

    engine.onReady(() => {
      if (application.isDisposed || activeApplication !== application) return
      window.__msxReady = true
      hideBootVeil()
      if (deferAOWarm) {
        const warmAO = (): void => {
          if (
            application.isDisposed ||
            activeApplication !== application ||
            adaptiveQuality === null ||
            adaptiveQuality.tier >= 2
          ) {
            return
          }
          void warmDeferredAOPass(engine, postFX, adaptiveQuality, () =>
            application.isDisposed || activeApplication !== application,
          )
        }
        if (typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(warmAO)
        } else {
          window.setTimeout(warmAO, 250)
        }
      }
    })
    engine.start()
  } catch (error) {
    if (activeApplication === application) activeApplication = null
    application.dispose()
    throw error
  }
}

bootstrap().catch((error: unknown) => {
  console.error('[main] falha ao inicializar a cena:', error)
  showBootMessage('Não foi possível montar a cena. Verifique o console para detalhes.')
})
