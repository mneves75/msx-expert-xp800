import * as THREE from 'three'
import type { ModuleContext, PowerState, SceneModule, ScreenSource } from '../core/types'
import type { ScreenPipeline } from '../emulator/index'
import { CARTRIDGE_DIMENSIONS, CARTRIDGE_MANIFEST } from '../models/Cartridge'
import { crtMonitorModule, type CrtMonitorModule } from '../models/CrtMonitor'
import { MainUnit, type MainUnitModule, type MainUnitHandles } from '../models/MainUnit'
import { RaycastPicker, type PickHit } from './Picker'
import {
  CartridgeInsertion,
  HingeFlap,
  KeycapTravel,
  Spring,
  TubeCable,
  bindTubeToCable,
  clamp01,
} from './Physics'

/**
 * Interactions — the behaviour layer. Everything the machine *does* lives here.
 *
 * ## Coupling
 *
 * This module owns no geometry. It finds the parts other agents built and drives them,
 * and it does that through two deliberately narrow couplings:
 *
 * - **The scene graph.** Interactive parts are tagged with `InteractiveUserData`; the
 *   keyboard and the joystick publish themselves on their root group's `userData`.
 * - **Named model singletons**, imported through the same specifiers `main.ts` uses.
 *   The CRT and main unit use their exported TypeScript contracts and are checked
 *   with `livesIn(..., scene)` before adoption.
 *
 * Every adopted model handle remains optional. A missing CRT costs the screen, not the
 * scene: the covers still push, the keys still travel, nothing throws.
 *
 * ## The emulator
 *
 * `../emulator` is imported **on first power-on** and never before (SPEC §10 — the
 * emulator is lazy). What comes back is a single `ScreenPipeline`: it routes WebMSX
 * first and falls back to the procedural TMS9918 renderer — CDN blocked, SRI mismatch,
 * tainted canvas — behind a texture of stable identity, and runs the CRT pass (barrel,
 * shadow mask, scanlines, halation) over whichever one won. The HUD is told, in pt-BR,
 * which one is running.
 *
 * ## The reset
 *
 * The XP-800 has no reset key. Pushing a cartridge slot cover in *is* the reset, and it
 * is wired that way here: the flap is driven in on press, trips the reset when it bottoms
 * out — not on release — and is then handed back to gravity and its return spring, which
 * slap it shut with a bounce.
 */

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type SlotId = 'A' | 'B'

/** A cartridge the user can actually reach — one of the shells lying on the desk. */
export interface CartridgeOption {
  readonly id: string
  readonly name: string
}

/**
 * Snapshot handed to the HUD. Field names match what `src/ui/Hud.ts` reads, so it
 * binds with no adapter.
 */
export interface InteractionsState {
  readonly power: PowerState
  readonly slotA: CartridgeOption | null
  readonly slotB: CartridgeOption | null
  readonly wireframe: boolean
  readonly xray: boolean
  readonly autoRotate: boolean
  readonly emulator: 'webmsx' | 'procedural' | null
  /** pt-BR label of the part under the cursor, or `null`. */
  readonly hovered: string | null
  /** Transient pt-BR message. */
  readonly note: string | null
  /** Present only when `note` is a failure — the HUD colours it as an alert. */
  readonly error?: string
}

export interface ShortcutHint {
  readonly keys: string
  readonly description: string
}

/** What the HUD (and the console) can call. */
export interface InteractionsHandle {
  readonly name: string
  getState(): InteractionsState
  subscribe(listener: (state: InteractionsState) => void): () => void
  readonly cartridges: readonly CartridgeOption[]
  readonly shortcuts: readonly ShortcutHint[]

  setPower(on: boolean): void
  togglePower(): void
  /** Soft reset — pushes a slot cover in, exactly as the hardware requires. */
  reset(): void
  insertCartridge(slot: SlotId, romId?: string): void
  ejectCartridge(slot: SlotId): void
  toggleCartridge(slot: SlotId): void
  /**
   * Instala uma ROM do computador do usuário no cartucho preto genérico
   * (`preto-generico`) e o insere/recarrega. O arquivo nunca sai do navegador.
   * Retorna `false` (com nota no HUD) se o arquivo não parecer uma ROM de MSX.
   */
  loadLocalRom(bytes: Uint8Array, fileName: string): boolean

  setWireframe(on: boolean): void
  toggleWireframe(): void
  setXRay(on: boolean): void
  toggleXRay(): void
  setAutoRotate(on: boolean): void
  toggleAutoRotate(): void
  resetView(): void

  /** Tap a key: presses the cap, actuates the switch, releases it. */
  tapKey(code: string): void
  pressKey(code: string): void
  releaseKey(code: string): void
}

/** The scene module `main.ts` registers. Also the handle — same object. */
export interface InteractionsModule extends SceneModule, InteractionsHandle {}

declare global {
  interface Window {
    /** Live handle for capture tools and browser diagnostics. */
    __msxInteractions?: InteractionsHandle
  }
}

// ---------------------------------------------------------------------------
// pt-BR copy
// ---------------------------------------------------------------------------

const TXT = {
  emulatorFallback:
    'Emulador WebMSX indisponível — a tela está no renderizador procedural.',
  emulatorMissing: 'Nenhuma fonte de vídeo encontrada — a tela fica apagada.',
  emulatorStarting: 'A tela ainda está iniciando — tente novamente em instantes.',
  cartridgeBusy: 'Este cartucho já está no outro compartimento.',
  cartridgeNone: 'Não há cartucho disponível na mesa para este compartimento.',
  slotOccupied: 'O compartimento já está ocupado — ejete o cartucho antes.',
  cartridgeRejected: 'O emulador recusou o cartucho — ele será devolvido à mesa.',
  romLoaded: 'ROM carregada no cartucho preto — o arquivo fica só no seu navegador.',
  romInvalid:
    'Arquivo não parece uma ROM de MSX (assinatura "AB" ausente) — nada foi carregado.',
  romTooBig: 'ROM acima de 2 MB — o Expert nunca viu um cartucho desse tamanho.',
  romNeedsEmulator:
    'ROM local pronta; ela roda quando o emulador WebMSX estiver ativo (requer internet).',
  resetDone: 'Reinício suave — tampa do compartimento empurrada.',
  resetBlocked: 'Ejete um cartucho para alcançar a tampa.',
  resetPowerOff: 'O Expert está desligado — ligue-o antes de reiniciar.',
  coverIsReset: 'empurre para reiniciar',
  ejectHint: 'clique para ejetar',
  powerOnHint: 'Ligar o Expert',
  powerOffHint: 'Desligar o Expert',
} as const

const SHORTCUTS: readonly ShortcutHint[] = [
  { keys: 'Alt + L', description: 'Ligar ou desligar' },
  { keys: 'Alt + R', description: 'Reiniciar (empurra a tampa do slot A)' },
  { keys: 'Alt + A', description: 'Inserir ou ejetar o cartucho do slot A' },
  { keys: 'Alt + B', description: 'Inserir ou ejetar o cartucho do slot B' },
  { keys: 'Alt + V', description: 'Redefinir a vista' },
  { keys: 'Alt + W', description: 'Modo aramado' },
  { keys: 'Alt + X', description: 'Modo raio-X' },
  { keys: 'Alt + G', description: 'Rotação automática' },
]

// ---------------------------------------------------------------------------
// Validated model handles
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasMethods(value: unknown, methods: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && methods.every((method) => typeof value[method] === 'function')
}

interface KeyboardLike {
  readonly keyCodes: readonly string[]
  pressKey(code: string): boolean
  releaseKey(code: string): boolean
  setInUse(on: boolean): void
}

function isKeyboardLike(value: unknown): value is KeyboardLike {
  return hasMethods(value, ['pressKey', 'releaseKey', 'setInUse']) && Array.isArray(value['keyCodes'])
}

interface JoystickLike {
  setDirection(x: number, y: number): void
  setButton(id: 'a' | 'b', pressed: boolean): void
}

function isJoystickLike(value: unknown): value is JoystickLike {
  return hasMethods(value, ['setDirection', 'setButton'])
}

/** The slice of `CameraRig` this module drives. Structural — never imported. */
interface OrbitLike {
  enabled: boolean
  readonly autoRotate?: boolean
  notifyInteraction(): void
  resetPose(immediate?: boolean): void
  setAutoRotate(enabled: boolean): void
}

/** Only trust a module instance that owns objects actually present in this scene. */
function livesIn(object: THREE.Object3D | null | undefined, scene: THREE.Scene): boolean {
  let node: THREE.Object3D | null = object ?? null
  while (node !== null) {
    if (node === scene) return true
    node = node.parent
  }
  return false
}

// ---------------------------------------------------------------------------
// Geometry constants — overridden by `Cartridge.ts` when it is reachable
// ---------------------------------------------------------------------------

interface CartridgeMetrics {
  /** Distance from the cartridge origin to the tip of its nose, metres. */
  readonly nose: number
  /** Travel from touching the mouth to fully home, metres. */
  readonly depth: number
}

const DEFAULT_METRICS: CartridgeMetrics = { nose: 0.035, depth: 0.03 }
const CRT_DRAIN_EPSILON = 0.002
const CRT_READY_WARMTH = 0.995

// ---------------------------------------------------------------------------
// Per-slot rig
// ---------------------------------------------------------------------------

type SlotPhase = 'vazio' | 'entrando' | 'inserido' | 'saindo'

interface SlotRig {
  readonly slot: SlotId
  readonly flap: HingeFlap
  readonly pivot: THREE.Object3D | null
  readonly mouth: THREE.Object3D | null
  readonly openAngle: number
  readonly pushAngle: number
  /** 0 = cartridge at its resting pose on the desk, 1 = aligned at the mouth. */
  readonly approach: Spring
  readonly insertion: CartridgeInsertion
  phase: SlotPhase
  cartridge: THREE.Object3D | null
  romId: string | null
  pushing: boolean
  resetArmed: boolean
  /** Cursor is on this cover: hold it at the hover give. */
  hovered: boolean
  /** The hover give is currently applied, so we know when to hand it back. */
  giving: boolean
}

interface RestingCartridge {
  readonly object: THREE.Object3D
  readonly romId: string
  readonly name: string
  readonly position: THREE.Vector3
  readonly quaternion: THREE.Quaternion
  slot: SlotId | null
}

// ---------------------------------------------------------------------------
// Display modes
// ---------------------------------------------------------------------------

interface MaterialSnapshot {
  readonly material: THREE.Material
  readonly transparent: boolean
  readonly opacity: number
  readonly depthWrite: boolean
  readonly side: THREE.Side
  readonly wireframe: boolean
}

// ---------------------------------------------------------------------------
// Keyboard bridge
// ---------------------------------------------------------------------------

interface KeyRig {
  readonly travel: KeycapTravel
  actuated: boolean
  /** True while a real finger (or physical key) is holding it down. */
  held: boolean
  /** This stroke has already asserted its contact — do not assert it twice. */
  spent: boolean
  /** Released before the cap reached the contact point: assert it anyway. */
  forced: boolean
  /** Earliest `performance.now()` at which contact may break. */
  holdUntil: number
}

/**
 * Minimum time a key is held down, in ms.
 *
 * The MSX scans its key matrix once per VDP frame, so a contact that opens and closes
 * inside 16 ms is never seen at all. A human tap lasts 60–120 ms and is never affected;
 * this floor only matters for synthetic input — automated tests, an on-screen keyboard,
 * a fast double-click — where the alternative is silently losing the keystroke.
 */
const MIN_KEY_HOLD_MS = 55

/**
 * Physical-key remapping. Resolved by `KeyboardEvent.key` first, so a Brazilian ABNT2
 * board and a US board both reach the right MSX cap: on ABNT2 the Ç key reports
 * `code: 'Semicolon'`, and the dead-key positions for `´ ~ ^` are swapped relative to
 * a US layout. `key` carries the intent; `code` only carries the position.
 */
const KEY_BY_CHARACTER: Readonly<Record<string, string>> = {
  ç: 'Cedilla',
  Ç: 'Cedilla',
  '´': 'Backquote',
  '~': 'Backquote',
  '^': 'Backquote',
  '`': 'Backquote',
  "'": 'Quote',
  '"': 'Quote',
}

/** Positions the XP-800 has under a different `code`. */
const KEY_BY_CODE: Readonly<Record<string, string>> = {
  ControlRight: 'ControlLeft',
  NumpadEnter: 'Enter',
  IntlRo: 'Slash',
  ScrollLock: 'Pause',
  PageUp: 'Home',
  PageDown: 'End',
}

/** Keys whose browser default would fight the emulator. */
const SWALLOW: ReadonlySet<string> = new Set([
  'Space',
  'Tab',
  'Backspace',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Slash',
  'Quote',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
])

function isBrowserControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.closest('input, textarea, select, button, a, [role="dialog"]') !== null
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

class Interactions implements InteractionsModule {
  readonly name = 'Interactions'
  readonly shortcuts = SHORTCUTS

  private readonly ctx: ModuleContext
  private readonly scene: THREE.Scene
  private readonly orbit: OrbitLike | null

  private picker: RaycastPicker | null = null

  // Model handles — every one optional.
  private crt: CrtMonitorModule | null = null
  private keyboard: KeyboardLike | null = null
  private joystick: JoystickLike | null = null
  private mainUnit: MainUnitModule | null = null
  private handles: MainUnitHandles | null = null

  // Emulator.
  private screen: ScreenPipeline | null = null
  /** ROM local armada antes de o pipeline de vídeo existir (máquina desligada). */
  private pendingLocalRom: Uint8Array | null = null
  private screenBooting: Promise<void> | null = null
  private screenBootController: AbortController | null = null
  private screenGeneration = 0
  /** The pipeline reached a reusable route (it may currently be stopped). */
  private screenReady = false
  /** The retained route has completed start() for the current power generation. */
  private screenRunning = false
  private readonly appliedCartridges = new Map<SlotId, string | null>([
    ['A', null],
    ['B', null],
  ])
  private emulator: 'webmsx' | 'procedural' | null = null

  // Physics rigs.
  private powerSwitch = new KeycapTravel({ travel: 0.0011, releaseZeta: 0.5 })
  private powerSwitchActuated = false
  private powerSwitchRest = 0
  private readonly slots = new Map<SlotId, SlotRig>()
  private readonly keyRigs = new Map<string, KeyRig>()
  private readonly cables: TubeCable[] = []
  private metrics: CartridgeMetrics = { ...DEFAULT_METRICS }

  // Cartridges available on the desk.
  private readonly resting: RestingCartridge[] = []
  private cartridgeCatalogue: readonly CartridgeOption[] = []

  // Display modes.
  private readonly snapshots: MaterialSnapshot[] = []
  private wireframeOn = false
  private xrayOn = false

  // Hover highlight. `highlightGeometry` is the placeholder we own and may dispose;
  // while a part is highlighted the mesh borrows *its* geometry, which we never touch.
  private highlight: THREE.Mesh | null = null
  private highlightMaterial: THREE.MeshBasicMaterial | null = null
  private highlightGeometry: THREE.BufferGeometry | null = null
  private readonly highlightFade = new Spring({ omega: 26, zeta: 1 })
  /**
   * Quadros que ainda precisam ser apresentados por causa de uma mutação one-shot
   * (hover trocou de alvo, wireframe/X-ray, seletor de voltagem): estados que mudam
   * pixels sem deixar nenhuma mola ativa para o `update()` reportar.
   */
  private wakeFrames = 0
  private highlightTarget: THREE.Object3D | null = null
  private highlightInstance: number | null = null

  // Power.
  private powerOn = false
  private localWarmth = 0
  private indicatorMaterial: THREE.MeshPhysicalMaterial | null = null

  // Knob drags.
  private brightness = 0.62
  private contrast = 0.58
  private speakerLevel = 0.5
  private voltage240 = false
  private voltageRestX = 0
  private speakerKnob: THREE.Object3D | null = null
  private voltageSelector: THREE.Object3D | null = null
  private joystickDragging = false
  private joystickAccumX = 0
  private joystickAccumY = 0
  /** Teclas atualmente pressionadas em nome do manche 3D (setas + Espaço do A). */
  private readonly joystickKeys = new Set<string>()
  /** Fontes segurando cada tecla do MSX — ver {@link driveMsxKey}. */
  private readonly msxKeyOwners = new Map<string, Set<'rig' | 'joystick'>>()
  /** Código físico do evento → tecla MSX e estado de liberação forçada. */
  private readonly physicalKeys = new Map<string, { code: string; released: boolean }>()

  // State + subscribers.
  private autoRotate = true
  private hoveredLabel: string | null = null
  private note: string | null = null
  private noteIsError = false
  private noteTimer: number | null = null
  private readonly timers = new Set<number>()
  private readonly listeners = new Set<(state: InteractionsState) => void>()
  private snapshotCache: InteractionsState | null = null

  private disposed = false
  private readonly scratchPos = new THREE.Vector3()
  private readonly scratchAxis = new THREE.Vector3()
  private readonly scratchImpulse = new THREE.Vector3()
  private readonly scratchMouthQuat = new THREE.Quaternion()
  private readonly scratchParentQuat = new THREE.Quaternion()
  private readonly scratchLocalQuat = new THREE.Quaternion()
  private readonly scratchMatrix = new THREE.Matrix4()

  constructor(ctx: ModuleContext) {
    this.ctx = ctx
    this.scene = ctx.scene
    // `AppContext` extends `ModuleContext` with the camera rig, but the contract in
    // types.ts does not promise it — so it is probed, not required.
    const rig = (ctx as { cameraRig?: unknown }).cameraRig
    this.orbit = hasMethods(rig, ['notifyInteraction', 'resetPose', 'setAutoRotate'])
      ? (rig as unknown as OrbitLike)
      : null
    this.autoRotate = this.orbit?.autoRotate ?? true
  }

  // ── SceneModule ────────────────────────────────────────────────────────────

  async build(ctx: ModuleContext): Promise<THREE.Group> {
    const group = new THREE.Group()
    group.name = 'interacoes'

    // Model transforms must be final before any world-space pose is captured.
    this.scene.updateMatrixWorld(true)

    this.discoverModels()
    this.collectSceneParts()
    this.buildSlots()
    this.collectCartridges()
    this.bindCables()
    this.buildHighlight(group)

    this.picker = new RaycastPicker({
      camera: ctx.camera,
      scene: this.scene,
      domElement: ctx.renderer.domElement,
      orbit: this.orbit,
      handlers: {
        onHover: (hit) => {
          // Hover troca alvo/realce/tooltip sem deixar mola ativa quando o fade já
          // está saturado — acorda o loop explicitamente.
          this.markVisualDirty()
          this.onHover(hit)
        },
        onPress: (hit) => {
          this.markVisualDirty()
          this.onPress(hit)
        },
        onDrag: (hit, dx, dy) => {
          // Knobs e o seletor escrevem transformações direto no handler — sem mola
          // que o update() reporte. O arrasto também move geometria projetora.
          this.markVisualDirty(2, true)
          this.onDrag(hit, dx, dy)
        },
        onRelease: (hit, dragged) => {
          this.markVisualDirty()
          this.onRelease(hit, dragged)
        },
        labelFor: (hit) => this.labelFor(hit),
      },
    })

    // Capture phase on `window`: this runs before *any* other listener in the document,
    // which is what makes this bridge the single authority on keyboard input. WebMSX
    // installs its own global key handlers when it boots; left to fight, neither path
    // delivers and typing silently does nothing.
    window.addEventListener('keydown', this.onKeyDown, { capture: true })
    window.addEventListener('keyup', this.onKeyUp, { capture: true })
    window.addEventListener('blur', this.onWindowBlur)
    document.addEventListener('visibilitychange', this.onVisibilityChange)

    this.publish()
    return group
  }

  update(dt: number): boolean {
    if (this.disposed) return false
    const step = Math.min(Math.max(dt, 0), 1 / 15)

    this.picker?.update()
    this.stepPowerSwitch(step)
    this.stepSlots(step)
    this.stepKeys(step)
    this.stepHighlight(step)
    let cablesAwake = false
    for (const cable of this.cables) {
      if (cable.step(step)) cablesAwake = true
    }

    if (this.crt === null) {
      // No CRT module: keep an honest warm-up ramp of our own so the HUD's readout and
      // the front lamp still behave.
      const tau = this.powerOn ? 1.5 : 0.42
      this.localWarmth += ((this.powerOn ? 1 : 0) - this.localWarmth) * (1 - Math.exp(-step / tau))
      // Snap espelhando o do CrtMonitor: a exponencial nunca chega a zero sozinha.
      if (!this.powerOn && this.localWarmth < 0.0015) this.localWarmth = 0
    }

    this.applyIndicator()
    // `stop()` has already halted the emulator/CPU. While powered off, keep only the
    // tube pipeline alive until the existing cooldown ramp is effectively black; once
    // warmth reaches this epsilon, the whole screen path sleeps instead of costing 60 Hz.
    const screenNeedsDrain = !this.powerOn && this.warmth > CRT_DRAIN_EPSILON
    if (this.screen !== null && (this.powerOn || screenNeedsDrain)) {
      try {
        this.screen.update(step)
        if (this.emulator !== this.screen.kind) {
          this.emulator = this.screen.kind
          this.publish()
        }
      } catch (error) {
        console.error('[Interactions] a fonte de vídeo falhou ao atualizar:', error)
      }
    }

    // Warmth changes every frame during the ramp; the HUD only needs to see it move,
    // so republish in coarse steps rather than sixty times a second.
    const cached = this.snapshotCache
    const warmth = this.warmth
    if (
      cached === null ||
      Math.abs(cached.power.warmth - warmth) > 0.02 ||
      (warmth >= CRT_READY_WARMTH && cached.power.warmth < CRT_READY_WARMTH) ||
      (warmth === 0 && cached.power.warmth !== 0)
    ) {
      this.publish()
    }

    // ── Agregado de atividade (render-on-demand) ─────────────────────────────
    // Cada rig já sabe se está em repouso; aqui só se agrega. Molas de geometria
    // projetora em movimento também redesenham o atlas de sombra congelado.
    let slotsBusy = false
    for (const rig of this.slots.values()) {
      if (
        rig.flap.moving ||
        rig.insertion.moving ||
        !rig.approach.isSettled(1e-4) ||
        rig.phase === 'entrando' ||
        rig.phase === 'saindo' ||
        rig.pushing
      ) {
        slotsBusy = true
        break
      }
    }
    const shadowCastersMoving =
      this.powerSwitch.moving || slotsBusy || this.keyRigs.size > 0 || cablesAwake
    if (shadowCastersMoving) this.ctx.renderer.shadowMap.needsUpdate = true

    const oneShot = this.wakeFrames > 0
    if (oneShot) this.wakeFrames -= 1

    return (
      oneShot ||
      shadowCastersMoving ||
      this.powerOn ||
      this.warmth > CRT_DRAIN_EPSILON ||
      !this.highlightFade.isSettled(1e-5)
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    window.removeEventListener('keydown', this.onKeyDown, { capture: true })
    window.removeEventListener('keyup', this.onKeyUp, { capture: true })
    window.removeEventListener('blur', this.onWindowBlur)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    for (const timer of this.timers) window.clearTimeout(timer)
    this.timers.clear()
    this.noteTimer = null

    this.joystickDragging = false
    this.joystick?.setDirection(0, 0)
    this.joystick?.setButton('a', false)
    this.joystick?.setButton('b', false)
    this.releaseJoystickKeys()

    this.picker?.dispose()
    this.picker = null

    this.setWireframe(false)
    this.setXRay(false)

    this.disposeScreen()

    // Only the placeholder is ours; a borrowed geometry belongs to its own module.
    if (this.highlight !== null) this.highlight.geometry = new THREE.BufferGeometry()
    this.highlight?.geometry.dispose()
    this.highlightGeometry?.dispose()
    this.highlightMaterial?.dispose()
    this.highlight = null
    this.highlightGeometry = null
    this.highlightMaterial = null

    this.listeners.clear()
    if (window.__msxInteractions === this) delete window.__msxInteractions
    if (singleton === this) singleton = null
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  private discoverModels(): void {
    // From the scene graph: modules that publish themselves on their root group.
    this.scene.traverse((object) => {
      const data = object.userData
      if (!isRecord(data)) return
      if (this.keyboard === null && isKeyboardLike(data['keyboard'])) this.keyboard = data['keyboard']
      if (this.joystick === null && isJoystickLike(data['joystick'])) this.joystick = data['joystick']
    })

    // Named singletons: these are the exact instances registered by `main.ts`.
    const crt = crtMonitorModule
    if (livesIn(crt.group, this.scene)) {
      this.crt = crt
    }

    const mainUnit = MainUnit
    if (livesIn(mainUnit.handles?.root, this.scene)) {
      this.mainUnit = mainUnit
      this.handles = mainUnit.handles
    }

    this.metrics = {
      nose: Math.abs(CARTRIDGE_DIMENSIONS.noseFrontZ),
      depth: CARTRIDGE_DIMENSIONS.insertionDepth,
    }
    for (const entry of CARTRIDGE_MANIFEST) {
      cartridgeNames.set(entry.id, entry.nome)
    }

    if (this.crt !== null) {
      this.brightness = clamp01(this.crt.controls.brightness)
      this.contrast = clamp01(this.crt.controls.contrast)
    }
  }

  /** Scene-graph parts that carry no module API: the indicator lens, the knobs. */
  private collectSceneParts(): void {
    const indicator = this.handles?.powerIndicator ?? this.scene.getObjectByName('power-indicator')
    if (indicator instanceof THREE.Mesh) {
      const material = indicator.material
      if (material instanceof THREE.MeshPhysicalMaterial) this.indicatorMaterial = material
    }
    const powerSwitch = this.handles?.powerSwitch ?? this.scene.getObjectByName('power-switch')
    if (powerSwitch !== null && powerSwitch !== undefined) this.powerSwitchRest = powerSwitch.position.z
    const travel = this.handles?.powerSwitchTravel
    if (typeof travel === 'number' && travel > 0) {
      this.powerSwitch = new KeycapTravel({ travel, releaseZeta: 0.5 })
    }

    this.scene.traverse((object) => {
      const partId = isRecord(object.userData) ? object.userData['partId'] : undefined
      if (partId === 'speaker-level-knob') this.speakerKnob = object
      else if (partId === 'voltage-selector') {
        this.voltageSelector = object
        this.voltageRestX = object.position.x
      }
    })
  }

  private buildSlots(): void {
    const openAngle = this.handles?.coverOpenAngle ?? 1.05
    const pushAngle = this.handles?.coverPushAngle ?? 0.2

    for (const slot of ['A', 'B'] as const) {
      const pivot =
        (slot === 'A' ? this.handles?.slotACoverPivot : this.handles?.slotBCoverPivot) ??
        this.scene.getObjectByName(`slot-${slot.toLowerCase()}-pivot`) ??
        null
      const mouth =
        (slot === 'A' ? this.handles?.slotAMouth : this.handles?.slotBMouth) ??
        this.scene.getObjectByName(`slot-${slot.toLowerCase()}-mouth`) ??
        null

      this.slots.set(slot, {
        slot,
        // ~17 mm from hinge to the flap's centre of mass; sprung firmly shut.
        flap: new HingeFlap({ length: 0.017, maxAngle: Math.max(openAngle, pushAngle) + 0.05 }),
        pivot,
        mouth,
        openAngle,
        pushAngle,
        approach: new Spring({ omega: 13, zeta: 1 }),
        insertion: new CartridgeInsertion(),
        phase: 'vazio',
        cartridge: null,
        romId: null,
        pushing: false,
        resetArmed: false,
        hovered: false,
        giving: false,
      })
    }
  }

  private collectCartridges(): void {
    const seen = new Set<THREE.Object3D>()
    this.scene.traverse((object) => {
      const data = object.userData
      if (!isRecord(data)) return
      const partId = data['partId']
      if (partId !== 'cartridge-a' && partId !== 'cartridge-b') return
      // Every child of a cartridge carries the same payload; keep the outermost.
      let root: THREE.Object3D = object
      while (
        root.parent !== null &&
        isRecord(root.parent.userData) &&
        root.parent.userData['partId'] === partId
      ) {
        root = root.parent
      }
      if (seen.has(root)) return
      seen.add(root)

      const romId = typeof data['romId'] === 'string' ? data['romId'] : root.name
      const label = typeof data['label'] === 'string' ? data['label'] : ''
      const name = cartridgeNames.get(romId) ?? label.split('—')[0]?.trim() ?? romId
      const slot = data['slot'] === 'A' || data['slot'] === 'B' ? data['slot'] : null

      this.resting.push({
        object: root,
        romId,
        name,
        position: root.position.clone(),
        quaternion: root.quaternion.clone(),
        slot,
      })
    })
    this.cartridgeCatalogue = this.resting.map((entry) => ({ id: entry.romId, name: entry.name }))
  }

  private bindCables(): void {
    for (const name of ['teclado-cabo', 'cabo-ac', 'monitor-cabo-ac']) {
      const mesh = this.scene.getObjectByName(name)
      if (!(mesh instanceof THREE.Mesh)) continue
      const cable = bindTubeToCable(mesh, { damping: 2.6 })
      if (cable !== null) this.cables.push(cable)
    }
  }

  private buildHighlight(group: THREE.Group): void {
    // Deliberately near the threshold of perception (SPEC §7 — if you can name the
    // effect it is turned up too high). This lands in the HDR buffer *before* tone
    // mapping, where graphite sits around 0.03 linear, so even 2 % additive is a read.
    // The primary hover cue is the cursor, the tooltip, and the part physically giving.
    const material = new THREE.MeshBasicMaterial({
      name: 'realce-interacao',
      color: new THREE.Color(0x9fb6cc),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    })
    const placeholder = new THREE.BufferGeometry()
    const mesh = new THREE.Mesh(placeholder, material)
    mesh.name = 'realce'
    mesh.visible = false
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    mesh.renderOrder = 6
    group.add(mesh)
    this.highlight = mesh
    this.highlightMaterial = material
    this.highlightGeometry = placeholder
  }

  // ── Pointer behaviour ──────────────────────────────────────────────────────

  private onHover(hit: PickHit | null): void {
    this.hoveredLabel = hit === null ? null : this.labelFor(hit)
    this.setHighlight(hit)
    this.applyHoverGive(hit)
    this.publish()
  }

  /**
   * The main hover cue on a *mechanical* part is not a glow — it is the part giving
   * under the finger. Empty slot covers flex in a degree and a half, which reads
   * instantly as "this pushes" and needs no legend to explain it.
   *
   * Only the intent is recorded here; {@link stepSlots} applies it, and only once the
   * flap is at rest — otherwise re-hovering mid-rebound would cancel the bounce the
   * cover makes when it slaps shut, which is the best half-second of the whole gesture.
   */
  private applyHoverGive(hit: PickHit | null): void {
    const hovered =
      hit?.partId === 'slot-a-cover' ? 'A' : hit?.partId === 'slot-b-cover' ? 'B' : null
    for (const [slot, rig] of this.slots) rig.hovered = slot === hovered
  }

  private onPress(hit: PickHit): void {
    this.orbit?.notifyInteraction()
    switch (hit.partId) {
      case 'power-switch':
        this.powerSwitch.press()
        break
      case 'slot-a-cover':
        this.pressCover('A')
        break
      case 'slot-b-cover':
        this.pressCover('B')
        break
      case 'keyboard-key':
        if (hit.keyCode !== undefined) this.pressKey(hit.keyCode)
        break
      case 'joystick-stick':
        this.joystickDragging = true
        this.joystickAccumX = 0
        this.joystickAccumY = 0
        break
      case 'joystick-button-a':
        this.joystick?.setButton('a', true)
        // Fire = Espaço, a convenção MSX de teclado — também começa a partida.
        // No conjunto do manche para o blur/desligar soltar junto com as setas.
        this.joystickKeys.add('Space')
        this.driveMsxKey('Space', 'joystick', true)
        break
      case 'joystick-button-b':
        this.joystick?.setButton('b', true)
        break
      default:
        break
    }
  }

  private onDrag(hit: PickHit, dx: number, dy: number): void {
    // Horizontal travel drives every rotary/slider control; a full sweep is ~220 px.
    const delta = (dx - dy) / 220
    switch (hit.partId) {
      case 'joystick-stick': {
        if (!this.joystickDragging) break
        this.joystickAccumX += dx
        this.joystickAccumY += dy
        const tiltX = THREE.MathUtils.clamp(this.joystickAccumX / 90, -1, 1)
        const tiltY = THREE.MathUtils.clamp(-this.joystickAccumY / 90, -1, 1)
        this.joystick?.setDirection(tiltX, tiltY)
        // O manche também É entrada: a deflexão vira setas para o MSX (o jogo e
        // qualquer ROM que leia cursores respondem — GTSTCK 0 os cobre).
        this.syncJoystickKeys(tiltX, tiltY)
        break
      }
      case 'crt-knob-brightness':
        this.brightness = clamp01(this.brightness + delta)
        this.crt?.setBrightness(this.brightness)
        break
      case 'crt-knob-contrast':
        this.contrast = clamp01(this.contrast + delta)
        this.crt?.setContrast(this.contrast)
        break
      case 'speaker-level-knob':
        this.speakerLevel = clamp01(this.speakerLevel + delta)
        if (this.speakerKnob !== null) {
          // ±140° of usable sweep, like the real detented pot.
          this.speakerKnob.rotation.z = (0.5 - this.speakerLevel) * 2 * THREE.MathUtils.degToRad(140)
        }
        break
      case 'voltage-selector':
        this.setVoltage(delta > 0 ? true : delta < 0 ? false : this.voltage240)
        break
      default:
        break
    }
  }

  private onRelease(hit: PickHit, dragged: boolean): void {
    switch (hit.partId) {
      case 'power-switch':
        this.powerSwitch.release()
        break
      case 'slot-a-cover':
        this.releaseCover('A', dragged)
        break
      case 'slot-b-cover':
        this.releaseCover('B', dragged)
        break
      case 'keyboard-key':
        if (hit.keyCode !== undefined) this.releaseKey(hit.keyCode)
        break
      case 'joystick-stick':
        if (this.joystickDragging) {
          this.joystickDragging = false
          this.joystickAccumX = 0
          this.joystickAccumY = 0
          this.joystick?.setDirection(0, 0)
          this.syncJoystickKeys(0, 0)
        }
        break
      case 'joystick-button-a':
        this.joystick?.setButton('a', false)
        this.joystickKeys.delete('Space')
        this.driveMsxKey('Space', 'joystick', false)
        break
      case 'joystick-button-b':
        this.joystick?.setButton('b', false)
        break
      case 'cartridge-a':
      case 'cartridge-b':
        if (!dragged) this.clickCartridge(hit)
        break
      case 'voltage-selector':
        if (!dragged) this.setVoltage(!this.voltage240)
        break
      default:
        break
    }
    this.picker?.invalidate()
  }

  /** Hover text that depends on state — the userData label cannot know any of this. */
  private labelFor(hit: PickHit): string {
    switch (hit.partId) {
      case 'power-switch':
        return this.powerOn ? TXT.powerOffHint : TXT.powerOnHint
      case 'slot-a-cover':
      case 'slot-b-cover': {
        const slot: SlotId = hit.partId === 'slot-a-cover' ? 'A' : 'B'
        const rig = this.slots.get(slot)
        return rig !== undefined && rig.phase === 'inserido'
          ? `Compartimento ${slot} — ${TXT.ejectHint}`
          : `Compartimento ${slot} — ${TXT.coverIsReset}`
      }
      case 'cartridge-a':
      case 'cartridge-b': {
        const romId = typeof hit.userData['romId'] === 'string' ? hit.userData['romId'] : null
        const entry = this.resting.find((candidate) => candidate.romId === romId)
        const name = entry?.name ?? hit.label
        return this.slotHolding(hit.object) === null
          ? `${name} — clique para inserir`
          : `${name} — ${TXT.ejectHint}`
      }
      default:
        return hit.label
    }
  }

  // ── Highlight ──────────────────────────────────────────────────────────────

  private static readonly NO_HIGHLIGHT: ReadonlySet<string> = new Set([
    'keyboard-key',
    'crt-screen',
  ])

  private setHighlight(hit: PickHit | null): void {
    const mesh = this.highlight
    if (mesh === null) return

    const source =
      hit !== null && !Interactions.NO_HIGHLIGHT.has(hit.partId) && hit.object instanceof THREE.Mesh
        ? hit.object
        : null

    if (source === null) {
      this.highlightTarget = null
      this.highlightFade.target = 0
      return
    }
    if (this.highlightTarget !== source || this.highlightInstance !== (hit?.instanceId ?? null)) {
      this.highlightTarget = source
      this.highlightInstance = hit?.instanceId ?? null
      mesh.geometry = source.geometry
      mesh.visible = true
    }
    this.highlightFade.target = 1
  }

  private stepHighlight(dt: number): void {
    const mesh = this.highlight
    const material = this.highlightMaterial
    if (mesh === null || material === null) return
    this.highlightFade.step(dt)
    const level = clamp01(this.highlightFade.value)
    material.opacity = level * 0.022

    if (level < 0.002) {
      mesh.visible = false
      return
    }
    const target = this.highlightTarget
    if (target === null) return
    mesh.visible = true
    mesh.matrix.copy(target.matrixWorld)
    if (target instanceof THREE.InstancedMesh && this.highlightInstance !== null) {
      target.getMatrixAt(this.highlightInstance, this.scratchMatrix)
      mesh.matrix.multiply(this.scratchMatrix)
    }
    mesh.matrixWorldNeedsUpdate = true
  }

  // ── Power ──────────────────────────────────────────────────────────────────

  private stepPowerSwitch(dt: number): void {
    this.powerSwitch.step(dt)
    const object = this.handles?.powerSwitch
    if (object !== undefined) object.position.z = this.powerSwitchRest - this.powerSwitch.travel

    // The contact makes part-way down, like every real momentary push switch.
    const fraction = this.powerSwitch.travel / this.powerSwitch.maxTravel
    if (!this.powerSwitchActuated && fraction > 0.7) {
      this.powerSwitchActuated = true
      this.togglePower()
    } else if (this.powerSwitchActuated && fraction < 0.35) {
      this.powerSwitchActuated = false
    }
  }

  private applyIndicator(): void {
    const warmth = this.warmth
    if (this.mainUnit !== null) {
      this.mainUnit.setPower({ on: this.powerOn, warmth })
      return
    }
    const material = this.indicatorMaterial
    if (material === null) return
    material.emissiveIntensity = this.powerOn ? (0.25 + 0.75 * warmth) * 2.6 : 0
  }

  private get warmth(): number {
    return this.crt !== null ? clamp01(this.crt.power.warmth) : clamp01(this.localWarmth)
  }

  /**
   * Traduz a deflexão do manche em setas para o MSX, com histerese: entra em
   * ±0,5 e só solta abaixo de ±0,35 — sem isso a mola do manche oscilando no
   * limiar metralharia pressiona/solta na matriz de teclado. Duas setas
   * simultâneas formam as diagonais legítimas do GTSTCK.
   */
  private syncJoystickKeys(x: number, y: number): void {
    const axes: ReadonlyArray<readonly [code: string, value: number]> = [
      ['ArrowRight', x],
      ['ArrowLeft', -x],
      ['ArrowUp', y],
      ['ArrowDown', -y],
    ]
    for (const [code, value] of axes) {
      const held = this.joystickKeys.has(code)
      const wanted = held ? value > 0.35 : value > 0.5
      if (wanted === held) continue
      if (wanted) this.joystickKeys.add(code)
      else this.joystickKeys.delete(code)
      this.driveMsxKey(code, 'joystick', wanted)
    }
  }

  /** Solta toda tecla que o manche estiver segurando (blur, desligar, descarte). */
  private releaseJoystickKeys(): void {
    for (const code of this.joystickKeys) this.driveMsxKey(code, 'joystick', false)
    this.joystickKeys.clear()
  }

  /**
   * Acorda o loop por `frames` quadros para mutações one-shot que nenhuma mola
   * reporta (hover trocado, wireframe/X-ray, voltagem). `movesShadowCasters` também
   * redesenha o atlas de sombra congelado no próximo render.
   */
  private markVisualDirty(frames = 2, movesShadowCasters = false): void {
    this.wakeFrames = Math.max(this.wakeFrames, frames)
    if (movesShadowCasters) this.ctx.renderer.shadowMap.needsUpdate = true
  }

  setPower(on: boolean): void {
    if (this.disposed || this.powerOn === on) return
    this.powerOn = on
    this.crt?.setPower(on)
    this.keyboard?.setInUse(on)
    this.shakeCables(on ? 0.02 : 0.012)

    if (on) {
      void this.bootScreen()
    } else {
      this.releaseAllKeys()
      this.stopScreen()
    }
    this.publish()
  }

  togglePower(): void {
    this.setPower(!this.powerOn)
  }

  // ── Emulator ───────────────────────────────────────────────────────────────

  private async bootScreen(): Promise<void> {
    if (this.disposed || !this.powerOn) return
    if (this.screenBooting !== null) return this.screenBooting

    const generation = ++this.screenGeneration
    const controller = new AbortController()
    this.screenBootController = controller
    const source = this.screen
    const boot =
      source !== null && this.screenReady
        ? this.resumeScreen(source, generation, controller.signal)
        : this.resolveScreen(generation, controller.signal)
    this.screenBooting = boot
    try {
      await boot
    } finally {
      if (this.screenBooting === boot) this.screenBooting = null
      if (this.screenBootController === controller) this.screenBootController = null
    }
  }

  private async resolveScreen(generation: number, signal: AbortSignal): Promise<void> {
    const source = await loadScreenSource(this.ctx)
    if (source === null) {
      if (this.screenIsCurrent(generation, signal)) this.setNote(TXT.emulatorMissing, true)
      return
    }

    if (!this.screenIsCurrent(generation, signal)) {
      source.dispose()
      return
    }

    // Connect the stable pipeline texture before startup settles. Its update() is now
    // driven every frame, so the procedural grace route becomes visible at 500 ms while
    // WebMSX is still allowed to promote asynchronously.
    this.screen = source
    this.screenReady = false
    this.screenRunning = false
    this.appliedCartridges.set('A', null)
    this.appliedCartridges.set('B', null)
    this.emulator = source.kind
    this.crt?.setScreenTexture(source.texture)
    // ROM local carregada com a máquina desligada: aplica agora que há pipeline.
    if (this.pendingLocalRom !== null) source.setLocalRom(this.pendingLocalRom)
    this.publish()

    try {
      await source.start(signal)
    } catch (error) {
      if (!isAbortError(error) && this.screenIsCurrent(generation, signal)) {
        console.warn(`[Interactions] fonte de vídeo "${source.kind}" recusou iniciar:`, error)
        this.setNote(TXT.emulatorMissing, true)
      }
      if (this.screen === source) {
        this.screen = null
        this.screenReady = false
        this.emulator = null
      }
      source.dispose()
      if (this.screenIsCurrent(generation, signal)) this.publish()
      return
    }

    if (!this.screenIsCurrent(generation, signal) || this.screen !== source) {
      source.dispose()
      return
    }

    this.emulator = source.kind
    this.screenReady = true
    this.screenRunning = true
    await this.syncCartridges(source, generation, signal)
    if (this.screenIsCurrent(generation, signal)) {
      this.publish()
    }
  }

  private async resumeScreen(
    source: ScreenSource,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.screenRunning = false
    try {
      await source.start(signal)
    } catch (error) {
      if (!isAbortError(error) && this.screenIsCurrent(generation, signal)) {
        console.warn('[Interactions] a fonte de vídeo não reiniciou:', error)
        this.setNote(TXT.emulatorMissing, true)
      }
      return
    }
    if (!this.screenIsCurrent(generation, signal) || this.screen !== source) return
    this.emulator = source.kind
    this.screenRunning = true
    await this.syncCartridges(source, generation, signal)
    if (this.screenIsCurrent(generation, signal)) this.publish()
  }

  private async syncCartridges(
    source: ScreenSource,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    for (const rig of this.slots.values()) {
      if (!this.screenIsCurrent(generation, signal) || this.screen !== source) return
      const wanted = rig.phase === 'inserido' ? rig.romId : null
      const applied = this.appliedCartridges.get(rig.slot) ?? null
      if (applied !== null && applied !== wanted) {
        source.ejectCartridge(rig.slot)
        this.appliedCartridges.set(rig.slot, null)
      }
      if (wanted !== null && applied !== wanted) {
        await this.applyCartridge(rig, source, generation)
      }
    }
  }

  private screenIsCurrent(generation: number, signal: AbortSignal): boolean {
    return (
      !this.disposed &&
      this.powerOn &&
      !signal.aborted &&
      generation === this.screenGeneration
    )
  }

  private disposeScreen(): void {
    this.screenGeneration += 1
    this.screenBootController?.abort()
    this.screenBootController = null
    this.screenBooting = null

    const source = this.screen
    this.screen = null
    this.screenReady = false
    this.screenRunning = false
    this.emulator = null
    this.appliedCartridges.set('A', null)
    this.appliedCartridges.set('B', null)
    if (source === null) return
    try {
      source.stop()
    } catch (error) {
      console.error('[Interactions] falha ao parar a fonte de vídeo:', error)
    }
    try {
      source.dispose()
    } catch (error) {
      console.error('[Interactions] falha ao descartar a fonte de vídeo:', error)
    }
  }

  private stopScreen(): void {
    this.screenGeneration += 1
    this.screenBootController?.abort()
    this.screenBootController = null
    this.screenBooting = null

    const source = this.screen
    if (source === null) return
    this.screenRunning = false
    try {
      source.stop()
    } catch (error) {
      console.error('[Interactions] falha ao parar a fonte de vídeo:', error)
    }

    // A pipeline that reached a usable route owns a one-shot WebMSX room and must be
    // retained for the next power-on. A still-pending pipeline has no reusable contract:
    // dispose it so no stale startup or late promotion can publish behind the dark CRT.
    if (!this.screenReady) {
      this.screen = null
      this.emulator = null
      this.appliedCartridges.set('A', null)
      this.appliedCartridges.set('B', null)
      try {
        source.dispose()
      } catch (error) {
        console.error('[Interactions] falha ao descartar a fonte de vídeo pendente:', error)
      }
    }
  }

  // ── Reset ──────────────────────────────────────────────────────────────────

  reset(): void {
    // The HUD's "Reiniciar" is the same gesture as the physical one: it pushes a cover.
    const free = (['A', 'B'] as const).find((slot) => this.slots.get(slot)?.phase === 'vazio')
    if (free === undefined) {
      this.setNote(TXT.resetBlocked, false)
      return
    }
    this.pressCover(free)
    this.later(() => {
      this.releaseCover(free, false)
    }, 190)
  }

  private fireReset(): void {
    if (!this.powerOn) {
      this.setNote(TXT.resetPowerOff, false)
      return
    }
    const screen = this.screen
    if (screen === null || !this.screenRunning) {
      this.setNote(TXT.emulatorStarting, false)
      return
    }
    try {
      screen.reset()
    } catch (error) {
      console.error('[Interactions] a fonte de vídeo não aceitou o reinício:', error)
      return
    }
    this.releaseAllKeys()
    this.shakeCables(0.008)
    this.setNote(TXT.resetDone, false)
  }

  // ── Cartridge slot covers ──────────────────────────────────────────────────

  private pressCover(slot: SlotId): void {
    const rig = this.slots.get(slot)
    if (rig === undefined) return
    if (rig.phase !== 'vazio') return
    rig.pushing = true
    rig.giving = false
    rig.resetArmed = true
    rig.flap.drive(rig.pushAngle)
  }

  private releaseCover(slot: SlotId, dragged: boolean): void {
    const rig = this.slots.get(slot)
    if (rig === undefined) return
    if (rig.phase === 'inserido' && !dragged) {
      this.ejectCartridge(slot)
      return
    }
    if (!rig.pushing) return
    rig.pushing = false
    rig.resetArmed = false
    rig.giving = false
    // Hand the flap back to gravity and its return spring — it slaps shut and bounces.
    rig.flap.release()
  }

  // ── Cartridges ─────────────────────────────────────────────────────────────

  private slotHolding(object: THREE.Object3D): SlotId | null {
    for (const [slot, rig] of this.slots) {
      if (rig.cartridge === null) continue
      if (rig.cartridge === object || isDescendant(object, rig.cartridge)) return slot
    }
    return null
  }

  private clickCartridge(hit: PickHit): void {
    const held = this.slotHolding(hit.object)
    if (held !== null) {
      this.ejectCartridge(held)
      return
    }
    const romId = typeof hit.userData['romId'] === 'string' ? hit.userData['romId'] : null
    const entry = this.resting.find((candidate) =>
      romId !== null ? candidate.romId === romId : candidate.object === hit.object,
    )
    const preferred = entry?.slot ?? (hit.partId === 'cartridge-b' ? 'B' : 'A')
    const free =
      this.slots.get(preferred)?.phase === 'vazio'
        ? preferred
        : (['A', 'B'] as const).find((slot) => this.slots.get(slot)?.phase === 'vazio')
    if (free === undefined) {
      this.setNote(TXT.slotOccupied, false)
      return
    }
    this.insertCartridge(free, entry?.romId ?? romId ?? undefined)
  }

  insertCartridge(slot: SlotId, romId?: string): void {
    const rig = this.slots.get(slot)
    if (rig === undefined) return
    if (rig.phase === 'inserido' || rig.phase === 'entrando') {
      this.setNote(TXT.slotOccupied, false)
      return
    }

    const wanted = romId ?? this.defaultRomFor(slot)
    const entry = this.pickResting(wanted, slot)
    if (entry === null) {
      this.setNote(wanted === undefined ? TXT.cartridgeNone : TXT.cartridgeBusy, false)
      return
    }

    rig.cartridge = entry.object
    rig.romId = entry.romId
    rig.phase = 'entrando'
    rig.approach.target = 1
    rig.insertion.snap(0)
    rig.flap.drive(rig.openAngle)
    this.orbit?.notifyInteraction()
    this.publish()
  }

  ejectCartridge(slot: SlotId): void {
    const rig = this.slots.get(slot)
    if (rig === undefined || rig.cartridge === null) return
    if (rig.phase === 'vazio' || rig.phase === 'saindo') return

    rig.phase = 'saindo'
    rig.flap.drive(rig.openAngle)
    rig.insertion.push(0)
    if (this.powerOn && this.screenRunning) {
      try {
        this.screen?.ejectCartridge(slot)
        this.appliedCartridges.set(slot, null)
      } catch (error) {
        console.error('[Interactions] a fonte de vídeo não aceitou a ejeção:', error)
      }
    }
    this.publish()
  }

  toggleCartridge(slot: SlotId): void {
    const rig = this.slots.get(slot)
    if (rig === undefined) return
    if (rig.phase === 'inserido' || rig.phase === 'entrando') this.ejectCartridge(slot)
    else this.insertCartridge(slot)
  }

  loadLocalRom(bytes: Uint8Array, fileName: string): boolean {
    // Validação mínima, com recusa honesta: teto de tamanho e a assinatura "AB"
    // num dos layouts que o WebMSX aceita (header em 0, 0x4000 ou 0x8000 — há
    // imagens de 32–64 KB com a página inteira e dumps pequenos legítimos).
    // Formato/mapper é decisão do emulador: recusas legítimas dele voltam pelo
    // caminho `cartridgeRejected` existente.
    if (bytes.length > 2 * 1024 * 1024) {
      this.setNote(TXT.romTooBig, true)
      return false
    }
    const signatureAt = (offset: number): boolean =>
      bytes.length >= offset + 2 && bytes[offset] === 0x41 && bytes[offset + 1] === 0x42
    if (bytes.length < 0x10 || (!signatureAt(0) && !signatureAt(0x4000) && !signatureAt(0x8000))) {
      this.setNote(TXT.romInvalid, true)
      return false
    }

    // A máquina NASCE desligada e `screen` só existe depois do primeiro ligar —
    // a ROM fica armada aqui e `resolveScreen` a aplica quando o pipeline subir.
    this.pendingLocalRom = bytes
    const screen = this.screen
    screen?.setLocalRom(bytes)

    // Cartucho preto já no compartimento: recarrega o conteúdo na fonte viva.
    // Fora dele: insere fisicamente no primeiro compartimento livre. Se não der
    // (mesa vazia ou slots ocupados), a ROM fica armada para a próxima inserção.
    let seated: SlotId | null = null
    for (const [slot, rig] of this.slots) {
      if (rig.romId === 'preto-generico' && (rig.phase === 'inserido' || rig.phase === 'entrando')) {
        seated = slot
        break
      }
    }
    if (seated !== null) {
      if (this.powerOn && this.screenRunning && screen !== null) {
        screen.insertCartridge(seated, 'preto-generico').catch((error: unknown) => {
          console.error('[Interactions] a fonte recusou a ROM local:', error)
          this.setNote(TXT.cartridgeRejected, true)
        })
      }
    } else {
      const freeSlot = (['A', 'B'] as const).find((slot) => {
        const rig = this.slots.get(slot)
        return rig !== undefined && rig.phase === 'vazio'
      })
      if (freeSlot !== undefined) this.insertCartridge(freeSlot, 'preto-generico')
    }

    const needsEmulator = screen === null || screen.kind !== 'webmsx'
    this.setNote(
      `“${fileName}” — ${needsEmulator ? TXT.romNeedsEmulator : TXT.romLoaded}`,
      false,
    )
    this.publish()
    return true
  }

  private defaultRomFor(slot: SlotId): string | undefined {
    const preferred = this.resting.find((entry) => entry.slot === slot && this.isFree(entry))
    return (preferred ?? this.resting.find((entry) => this.isFree(entry)))?.romId
  }

  private isFree(entry: RestingCartridge): boolean {
    for (const rig of this.slots.values()) if (rig.cartridge === entry.object) return false
    return true
  }

  private pickResting(romId: string | undefined, slot: SlotId): RestingCartridge | null {
    if (romId !== undefined) {
      const exact = this.resting.find((entry) => entry.romId === romId)
      if (exact !== undefined) return this.isFree(exact) ? exact : null
    }
    return (
      this.resting.find((entry) => entry.slot === slot && this.isFree(entry)) ??
      this.resting.find((entry) => this.isFree(entry)) ??
      null
    )
  }

  private stepSlots(dt: number): void {
    for (const rig of this.slots.values()) {
      this.stepHoverGive(rig)
      rig.flap.step(dt)
      if (rig.pivot !== null) rig.pivot.rotation.x = rig.flap.angle

      // Reset trips at the bottom of the push, not on release — that is where the
      // switch under the flap actually closes.
      if (rig.resetArmed && rig.flap.angle > rig.pushAngle * 0.9) {
        rig.resetArmed = false
        this.fireReset()
      }

      if (rig.cartridge === null) continue
      rig.approach.step(dt)
      const aligned = rig.approach.value > 0.985

      if (rig.phase === 'entrando' && aligned) rig.insertion.push(1)
      rig.insertion.step(dt)

      if (rig.insertion.consumeSeated() && rig.phase === 'entrando') this.onCartridgeSeated(rig)
      if (rig.phase === 'saindo' && rig.insertion.u < 0.02) rig.approach.target = 0
      if (rig.phase === 'saindo' && rig.approach.value < 0.02) this.onCartridgeHome(rig)

      this.placeCartridge(rig)
    }
  }

  /** Engage or drop the hover give, waiting for the flap to be at rest before engaging. */
  private stepHoverGive(rig: SlotRig): void {
    const wants = rig.hovered && !rig.pushing && rig.phase === 'vazio'
    if (wants === rig.giving) return
    if (wants) {
      // Do not steal the flap mid-rebound — let it finish slapping shut first.
      if (rig.flap.moving) return
      rig.giving = true
      rig.flap.drive(rig.pushAngle * 0.05)
    } else {
      rig.giving = false
      if (!rig.pushing && rig.phase === 'vazio') rig.flap.release()
    }
  }

  private onCartridgeSeated(rig: SlotRig): void {
    rig.phase = 'inserido'
    // A seated cartridge holds the flap open with no give at all.
    rig.flap.block(rig.openAngle)
    this.shakeCables(0.01)
    const source = this.screen
    if (this.powerOn && this.screenRunning && rig.romId !== null && source !== null) {
      void this.applyCartridge(rig, source, this.screenGeneration)
    }
    this.picker?.invalidate()
    this.publish()
  }

  private onCartridgeHome(rig: SlotRig): void {
    const entry = this.resting.find((candidate) => candidate.object === rig.cartridge)
    if (entry !== undefined && rig.cartridge !== null) {
      rig.cartridge.position.copy(entry.position)
      rig.cartridge.quaternion.copy(entry.quaternion)
    }
    rig.cartridge = null
    rig.romId = null
    rig.phase = 'vazio'
    rig.insertion.snap(0)
    rig.approach.snap(0)
    rig.flap.release()
    this.picker?.invalidate()
    this.publish()
  }

  private async applyCartridge(
    rig: SlotRig,
    source: ScreenSource,
    generation: number,
  ): Promise<void> {
    const romId = rig.romId
    if (romId === null) return
    try {
      await source.insertCartridge(rig.slot, romId)
    } catch (error) {
      if (
        !isAbortError(error) &&
        this.powerOn &&
        this.screen === source &&
        generation === this.screenGeneration &&
        rig.phase === 'inserido' &&
        rig.romId === romId
      ) {
        console.warn('[Interactions] o emulador recusou o cartucho:', error)
        rig.phase = 'saindo'
        rig.flap.drive(rig.openAngle)
        rig.insertion.push(0)
        this.setNote(TXT.cartridgeRejected, true)
        this.picker?.invalidate()
        this.publish()
      }
      return
    }
    if (
      this.powerOn &&
      this.screen === source &&
      generation === this.screenGeneration &&
      rig.phase === 'inserido' &&
      rig.romId === romId
    ) {
      this.appliedCartridges.set(rig.slot, romId)
    }
  }

  /**
   * Pose the cartridge for this frame: an arced lift from the desk to the mouth, then a
   * straight slide down the rails with the wobble the insertion physics produced.
   */
  private placeCartridge(rig: SlotRig): void {
    const cartridge = rig.cartridge
    const mouth = rig.mouth
    if (cartridge === null || mouth === null) return
    const entry = this.resting.find((candidate) => candidate.object === cartridge)
    if (entry === undefined) return

    mouth.getWorldPosition(this.scratchPos)
    mouth.getWorldQuaternion(this.scratchMouthQuat)
    // Insertion axis: −Z of the mouth frame, pointing into the machine. At u = 0 the
    // nose just touches the mouth; at u = 1 it has travelled the full insertion depth.
    this.scratchAxis.set(0, 0, -1).applyQuaternion(this.scratchMouthQuat)

    const slide = this.metrics.nose - rig.insertion.u * this.metrics.depth
    const target = this.scratchPos.addScaledVector(this.scratchAxis, slide)

    const parent = cartridge.parent
    if (parent !== null) parent.worldToLocal(target)

    const t = clamp01(rig.approach.value)
    const ease = t * t * (3 - 2 * t)
    cartridge.position.copy(entry.position).lerp(target, ease)
    // Lift over the desk on the way across, so the shell never scrapes the top.
    cartridge.position.y += Math.sin(Math.PI * ease) * 0.028

    const parentQuat =
      parent === null ? IDENTITY_QUAT : parent.getWorldQuaternion(this.scratchParentQuat)
    this.scratchLocalQuat.copy(parentQuat).invert().multiply(this.scratchMouthQuat)
    cartridge.quaternion.copy(entry.quaternion).slerp(this.scratchLocalQuat, ease)

    if (rig.insertion.u > 0.001) {
      // Rails have slop: the shell rolls and yaws a little as it seats.
      cartridge.rotateZ(rig.insertion.wobbleRoll)
      cartridge.rotateY(rig.insertion.wobbleYaw)
    }
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  pressKey(code: string): void {
    const rig = this.keyRigs.get(code) ?? {
      travel: new KeycapTravel(),
      actuated: false,
      held: false,
      spent: false,
      forced: false,
      holdUntil: 0,
    }
    if (rig.held) return
    rig.held = true
    rig.spent = false
    rig.forced = false
    rig.travel.press()
    this.keyRigs.set(code, rig)
    this.keyboard?.pressKey(code)
    this.orbit?.notifyInteraction()
  }

  releaseKey(code: string): void {
    const rig = this.keyRigs.get(code)
    if (rig === undefined || !rig.held) return
    rig.held = false
    rig.travel.release()
    this.keyboard?.releaseKey(code)

    // A stroke shorter than the ~10 ms the cap needs to reach the contact point would
    // otherwise be swallowed by the travel gate. Physics decides how a keypress *feels*;
    // it does not get to decide whether the user's input happened. The contact is
    // asserted on the next frame instead of right here, so it is held for a real
    // interval rather than opening and closing inside one tick.
    if (!rig.actuated && !rig.spent) rig.forced = true
  }

  tapKey(code: string): void {
    this.pressKey(code)
    this.later(() => {
      this.releaseKey(code)
    }, 90)
  }

  /**
   * Advance every live keycap and gate the emulator on real switch travel: contact is
   * made around 60 % of the 3 mm stroke and broken on the way back up, which is what a
   * mechanical switch does and what makes a fast double-tap feel right.
   */
  private stepKeys(dt: number): void {
    const now = performance.now()
    for (const [code, rig] of this.keyRigs) {
      rig.travel.step(dt)
      const fraction = rig.travel.travel / rig.travel.maxTravel

      if (!rig.actuated && !rig.spent && (rig.forced || fraction > 0.6)) {
        rig.actuated = true
        rig.spent = true
        rig.forced = false
        rig.holdUntil = now + MIN_KEY_HOLD_MS
        this.driveMsxKey(code, 'rig', true)
      } else if (rig.actuated && !rig.held && fraction < 0.35 && now >= rig.holdUntil) {
        rig.actuated = false
        this.driveMsxKey(code, 'rig', false)
      }

      if (!rig.held && !rig.actuated && !rig.forced && !rig.travel.moving) {
        this.keyRigs.delete(code)
      }
    }
  }

  private sendKey(code: string, down: boolean): void {
    if (!this.powerOn || !this.screenRunning) return
    try {
      this.screen?.sendKey(code, down)
    } catch (error) {
      console.error('[Interactions] a fonte de vídeo recusou a tecla:', error)
    }
  }

  /**
   * Posse agregada de uma tecla do MSX entre fontes independentes (rig de tecla
   * física/3D e manche). A tecla desce na PRIMEIRA fonte e só sobe quando a
   * ÚLTIMA solta — sem isto, centrar o manche soltava uma seta que o teclado
   * físico ainda segurava, e vice-versa (mesma colisão para o Espaço do botão A).
   */
  private driveMsxKey(code: string, source: 'rig' | 'joystick', down: boolean): void {
    const owners = this.msxKeyOwners.get(code) ?? new Set<'rig' | 'joystick'>()
    const before = owners.size
    if (down) owners.add(source)
    else owners.delete(source)
    if (owners.size > 0) this.msxKeyOwners.set(code, owners)
    else this.msxKeyOwners.delete(code)
    if (down && before === 0) this.sendKey(code, true)
    else if (!down && before > 0 && owners.size === 0) this.sendKey(code, false)
  }

  private releaseAllKeys(): void {
    // A tecla física pode continuar pressionada após reset/power-off/blur. Preserve a
    // posse DOM até keyup para engolir repeats, mas permita um novo keydown não-repeat.
    for (const owned of this.physicalKeys.values()) owned.released = true
    for (const code of [...this.keyRigs.keys()]) this.releaseKey(code)
    // Setas do manche não passam pelos rigs de tecla — soltar explicitamente,
    // senão um blur no meio do arrasto deixa o MSX com a direção presa.
    this.releaseJoystickKeys()
  }

  /** Map a physical key event onto a cap this machine actually has. */
  private resolveKey(event: KeyboardEvent): string | null {
    const byCharacter = KEY_BY_CHARACTER[event.key]
    if (byCharacter !== undefined && this.hasKey(byCharacter)) return byCharacter
    if (this.hasKey(event.code)) return event.code
    const alias = KEY_BY_CODE[event.code]
    if (alias !== undefined && this.hasKey(alias)) return alias
    return null
  }

  private hasKey(code: string): boolean {
    const keyboard = this.keyboard
    if (keyboard === null) return false
    return keyboard.keyCodes.includes(code)
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.disposed) return
    const owned = this.physicalKeys.get(event.code)
    if (owned !== undefined) {
      if (!event.repeat && owned.released) {
        this.physicalKeys.delete(event.code)
      } else {
        if (SWALLOW.has(owned.code)) event.preventDefault()
        event.stopPropagation()
        return
      }
    }
    if (isBrowserControl(event.target)) return
    if (event.ctrlKey || event.metaKey) return

    // Alt is the shortcut namespace (and L GRA / R GRA on the MSX, which still pass).
    if (event.altKey && event.code !== 'AltLeft' && event.code !== 'AltRight') {
      if (event.defaultPrevented || event.repeat) return
      if (this.handleShortcut(event.code)) {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }
    if (event.repeat) return

    const code = this.resolveKey(event)
    if (code === null) return
    // Only swallow what the *browser* would otherwise steal (scroll, focus, back).
    if (SWALLOW.has(code)) event.preventDefault()
    // Stop the emulator's own global handler from injecting the same key a second time:
    // `ScreenSource.sendKey` is the one documented path in, and this is it.
    event.stopPropagation()
    this.physicalKeys.set(event.code, { code, released: false })
    this.pressKey(code)
  }

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (this.disposed) return
    const owned = this.physicalKeys.get(event.code)
    if (owned === undefined) return
    this.physicalKeys.delete(event.code)
    event.stopPropagation()
    if (!owned.released) this.releaseKey(owned.code)
  }

  private handleShortcut(code: string): boolean {
    switch (code) {
      case 'KeyL':
        this.togglePower()
        return true
      case 'KeyR':
        this.reset()
        return true
      case 'KeyA':
        this.toggleCartridge('A')
        return true
      case 'KeyB':
        this.toggleCartridge('B')
        return true
      case 'KeyV':
        this.resetView()
        return true
      case 'KeyW':
        this.toggleWireframe()
        return true
      case 'KeyX':
        this.toggleXRay()
        return true
      case 'KeyG':
        this.toggleAutoRotate()
        return true
      default:
        return false
    }
  }

  private readonly onWindowBlur = (): void => {
    this.releaseAllKeys()
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.releaseAllKeys()
  }

  // ── Display modes ──────────────────────────────────────────────────────────

  private snapshotMaterials(): void {
    if (this.snapshots.length > 0) return
    const seen = new Set<THREE.Material>()
    this.scene.traverse((object) => {
      const holder = object as unknown as { material?: THREE.Material | THREE.Material[] }
      const material = holder.material
      if (material === undefined) return
      for (const entry of Array.isArray(material) ? material : [material]) {
        if (!entry || seen.has(entry)) continue
        // The phosphor is the picture, not a surface — it never joins a display mode.
        if (entry === this.highlightMaterial || entry instanceof THREE.MeshBasicMaterial) continue
        seen.add(entry)
        this.snapshots.push({
          material: entry,
          transparent: entry.transparent,
          opacity: entry.opacity,
          depthWrite: entry.depthWrite,
          side: entry.side,
          wireframe: (entry as { wireframe?: boolean }).wireframe ?? false,
        })
      }
    })
  }

  private applyDisplayMode(): void {
    this.snapshotMaterials()
    for (const snapshot of this.snapshots) {
      const material = snapshot.material as THREE.Material & { wireframe?: boolean }
      if (this.xrayOn) {
        material.transparent = true
        material.opacity = snapshot.opacity * 0.22
        material.depthWrite = false
        material.side = THREE.DoubleSide
      } else {
        material.transparent = snapshot.transparent
        material.opacity = snapshot.opacity
        material.depthWrite = snapshot.depthWrite
        material.side = snapshot.side
      }
      if (material.wireframe !== undefined) material.wireframe = this.wireframeOn
    }
  }

  setWireframe(on: boolean): void {
    if (this.wireframeOn === on) return
    this.wireframeOn = on
    this.applyDisplayMode()
    this.markVisualDirty(2, true)
    this.publish()
  }

  toggleWireframe(): void {
    this.setWireframe(!this.wireframeOn)
  }

  setXRay(on: boolean): void {
    if (this.xrayOn === on) return
    this.xrayOn = on
    this.applyDisplayMode()
    this.markVisualDirty(2, true)
    this.publish()
  }

  toggleXRay(): void {
    this.setXRay(!this.xrayOn)
  }

  // ── View ───────────────────────────────────────────────────────────────────

  resetView(): void {
    this.orbit?.resetPose(false)
    this.orbit?.notifyInteraction()
  }

  setAutoRotate(on: boolean): void {
    if (this.autoRotate === on) return
    this.autoRotate = on
    this.orbit?.setAutoRotate(on)
    this.publish()
  }

  toggleAutoRotate(): void {
    this.setAutoRotate(!this.autoRotate)
  }

  // ── Misc hardware ──────────────────────────────────────────────────────────

  private setVoltage(on240: boolean): void {
    if (this.voltage240 === on240) return
    this.voltage240 = on240
    const selector = this.voltageSelector
    if (selector !== null) selector.position.x = this.voltageRestX + (on240 ? 0.0028 : 0)
    // Escrita direta de transformação: sem isto o seletor só apareceria movido no
    // próximo quadro que outra coisa acordasse.
    this.markVisualDirty(2, true)
  }

  private shakeCables(strength: number): void {
    this.scratchImpulse.set(0, -strength, strength * 0.35)
    for (const cable of this.cables) cable.disturb(this.scratchImpulse, 0.55, 0.4)
  }

  // ── State ──────────────────────────────────────────────────────────────────

  get cartridges(): readonly CartridgeOption[] {
    return this.cartridgeCatalogue
  }

  getState(): InteractionsState {
    if (this.snapshotCache !== null) return this.snapshotCache
    const slotOption = (slot: SlotId): CartridgeOption | null => {
      const rig = this.slots.get(slot)
      if (rig === undefined || rig.romId === null) return null
      if (rig.phase !== 'inserido' && rig.phase !== 'entrando') return null
      const entry = this.resting.find((candidate) => candidate.romId === rig.romId)
      return { id: rig.romId, name: entry?.name ?? rig.romId }
    }

    const base = {
      power: { on: this.powerOn, warmth: this.warmth },
      slotA: slotOption('A'),
      slotB: slotOption('B'),
      wireframe: this.wireframeOn,
      xray: this.xrayOn,
      autoRotate: this.autoRotate,
      emulator: this.emulator,
      hovered: this.hoveredLabel,
      note: this.note,
    } satisfies Omit<InteractionsState, 'error'>

    // `error` is present only when it is real: the HUD keys its alert colour off the
    // presence of the field, not its value.
    this.snapshotCache =
      this.note !== null && this.noteIsError ? { ...base, error: this.note } : base
    return this.snapshotCache
  }

  subscribe(listener: (state: InteractionsState) => void): () => void {
    this.listeners.add(listener)
    try {
      listener(this.getState())
    } catch (error) {
      console.error('[Interactions] assinante falhou na primeira notificação:', error)
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(): void {
    this.snapshotCache = null
    const state = this.getState()
    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch (error) {
        console.error('[Interactions] assinante falhou:', error)
      }
    }
  }

  private setNote(text: string, isError: boolean): void {
    if (this.noteTimer !== null) {
      window.clearTimeout(this.noteTimer)
      this.timers.delete(this.noteTimer)
      this.noteTimer = null
    }
    this.note = text
    this.noteIsError = isError
    this.publish()
    this.noteTimer = this.later(() => {
      this.noteTimer = null
      this.note = null
      this.noteIsError = false
      this.publish()
    }, isError ? 9000 : 5200)
  }

  private later(callback: () => void, delayMs: number): number | null {
    if (this.disposed) return null
    const timer = window.setTimeout(() => {
      this.timers.delete(timer)
      if (!this.disposed) callback()
    }, delayMs)
    this.timers.add(timer)
    return timer
  }
}

const IDENTITY_QUAT = new THREE.Quaternion()

function isDescendant(node: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = node
  while (current !== null) {
    if (current === ancestor) return true
    current = current.parent
  }
  return false
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Display names harvested from the cartridge manifest, id → pt-BR name. */
const cartridgeNames = new Map<string, string>()

/**
 * Build the video source.
 *
 * Exactly one is built: {@link ScreenPipeline}, which *is* the whole chain — the routed
 * WebMSX→procedural fallback feeding the CRT processor (barrel, shadow mask, scanlines,
 * persistence, halation — SPEC §5). Its `texture` has stable identity, so the CRT
 * material is pointed at it once and survives the emulator swapping underneath.
 *
 * The import is dynamic so the emulator chunk is fetched on first power-on and never at
 * page load (SPEC §10).
 */
async function loadScreenSource(ctx: ModuleContext): Promise<ScreenPipeline | null> {
  try {
    const { ScreenPipeline } = await import('../emulator/index.ts')
    // Slots vazios ficam no BASIC procedural; o WebMSX entra quando há cartucho.
    // Sem isto o C-BIOS abre em "No cartridge found" e o teclado não faz nada.
    return new ScreenPipeline({ renderer: ctx.renderer, webMsxNeedsCartridge: true })
  } catch (error) {
    console.error('[Interactions] o módulo de vídeo falhou ao importar:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

let singleton: Interactions | null = null

/** Build the interaction layer and expose its handle to capture tools. */
export function createInteractions(ctx: ModuleContext): InteractionsModule {
  if (singleton !== null) return singleton
  singleton = new Interactions(ctx)
  window.__msxInteractions = singleton
  return singleton
}
