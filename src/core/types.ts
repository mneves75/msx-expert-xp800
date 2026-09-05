import type * as THREE from 'three'

/**
 * Shared contracts. Every model module implements `SceneModule` so the Engine can
 * compose them without knowing their internals. Physical model modules share these
 * contracts; the interaction layer coordinates their explicit control APIs.
 */

/** Names of interactive parts, used for raycast hit-testing and the HUD. */
export type PartId =
  | 'power-switch'
  | 'slot-a-cover'
  | 'slot-b-cover'
  | 'cartridge-a'
  | 'cartridge-b'
  | 'keyboard-key'
  | 'crt-screen'
  | 'crt-knob-brightness'
  | 'crt-knob-contrast'
  | 'joystick-stick'
  | 'joystick-button-a'
  | 'joystick-button-b'
  | 'speaker-level-knob'
  | 'voltage-selector'

/** Attached to `Object3D.userData` on every interactive mesh. */
export interface InteractiveUserData {
  readonly partId: PartId
  /** Free-form key identity for keyboard caps, e.g. 'KeyA', 'Enter', 'F1'. */
  readonly keyCode?: string
  /** pt-BR tooltip shown on hover. */
  readonly label: string
  /** Cursor to show on hover. */
  readonly cursor?: 'pointer' | 'grab' | 'ew-resize'
}

export interface ModuleContext {
  readonly scene: THREE.Scene
  readonly renderer: THREE.WebGLRenderer
  readonly camera: THREE.PerspectiveCamera
  /** Shared PBR material library — never construct case plastic yourself. */
  readonly materials: MaterialLibrary
  /** Seconds since start. */
  readonly clock: THREE.Clock
}

export interface SceneModule {
  readonly name: string
  /** Build geometry. Must be pure — no side effects outside the returned group. */
  build(ctx: ModuleContext): Promise<THREE.Group> | THREE.Group
  /**
   * Per-frame update. `dt` in seconds. Optional.
   *
   * Return `false` to declare the module *settled* — nothing it owns will change
   * pixels this frame. When every module is settled (and the camera too) the Engine
   * skips presenting the frame entirely: render-on-demand. `true` or `undefined`
   * keep the frame rendering, so a module that never opts in never regresses.
   *
   * A module that moves shadow-casting geometry must also raise
   * `renderer.shadowMap.needsUpdate = true` on the frames it writes transforms —
   * the shadow atlas is frozen (`shadowMap.autoUpdate = false`) and only redraws
   * when asked, the same dirty idiom as `instanceMatrix.needsUpdate`.
   */
  update?(dt: number, elapsed: number): boolean | void
  /**
   * Called only on frames that will actually be presented, after every `update()`
   * and immediately before the pipeline renders. This is where render-coupled work
   * belongs (reflection probes, contact captures): work done here never runs for a
   * frame the Engine decided to skip.
   */
  beforeRender?(dt: number, elapsed: number): void
  /** Release GPU resources. */
  dispose?(): void
}

/**
 * Shared material library. Guarantees every module renders with identical
 * plastic/metal/rubber response so parts don't look like they came from different scenes.
 */
export interface MaterialLibrary {
  /** Graphite main-unit shell; calibrated response lives in SPEC §4. */
  caseGraphite(): THREE.MeshPhysicalMaterial
  /** Darker front fascia; calibrated response lives in SPEC §4. */
  caseFascia(): THREE.MeshPhysicalMaterial
  /** Warm silver keyboard shell; calibrated response lives in SPEC §4. */
  caseSilver(): THREE.MeshPhysicalMaterial
  /** Generic matte near-black inset material. */
  panelBlack(): THREE.MeshPhysicalMaterial
  /**
   * Keycap plastic. `worn` raises gloss for finger-polished caps (spacebar, Enter).
   * @param hex base colour, e.g. 0xB8B5AC
   */
  keycap(hex: number, worn?: boolean): THREE.MeshPhysicalMaterial
  /** Tinted metal — thumbscrews, connector shells. */
  metal(hex: number, roughness?: number): THREE.MeshPhysicalMaterial
  /** Soft black rubber feet. */
  rubber(): THREE.MeshPhysicalMaterial
  /** Emissive screen surface fed by the emulator texture. */
  screenEmissive(map: THREE.Texture): THREE.MeshBasicMaterial
}

/** Contract for whatever drives the CRT: real emulator or procedural fallback. */
export interface ScreenSource {
  readonly kind: 'webmsx' | 'procedural'
  /**
   * Native logical framebuffer size, not necessarily the backing texture size.
   * WebMSX reports 272×208. The procedural source reports its 256×192 active
   * framebuffer although its presentation texture is padded to 272×240 so the
   * CRT can retain an authentic border/overscan.
   */
  readonly width: number
  readonly height: number
  /** The live texture to sample. */
  readonly texture: THREE.Texture
  /** Start lazily; abort must prevent stale boot work from publishing a source. */
  start(signal?: AbortSignal): Promise<void>
  /**
   * Power off without releasing the resolved route. A later `start()` must
   * relight the same mounted emulator; terminal teardown belongs to `dispose()`.
   */
  stop(): void
  /** Soft reset — triggered by pushing a cartridge slot cover in. */
  reset(): void
  /** Forward a key event from a clicked 3D keycap or the physical keyboard. */
  sendKey(code: string, down: boolean): void
  /** Load a cartridge ROM by id. */
  insertCartridge(slot: 'A' | 'B', romId: string): Promise<void>
  ejectCartridge(slot: 'A' | 'B'): void
  update(dt: number): void
  /** Idempotently release in-flight work, DOM hooks, and owned GPU resources. */
  dispose(): void
}

export interface PowerState {
  readonly on: boolean
  /** 0→1 CRT warm-up ramp. Screen brightness follows this, never snaps on. */
  readonly warmth: number
}
