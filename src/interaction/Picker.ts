import * as THREE from 'three'
import type { InteractiveUserData, PartId } from '../core/types'

/**
 * Picker — raycast hit-testing, hover state, and pointer gestures over the 3D scene.
 *
 * ## What counts as a hit
 *
 * Interactive parts are tagged by their own modules with {@link InteractiveUserData} on
 * `Object3D.userData` (`partId`, pt-BR `label`, CSS `cursor`). The picker snapshots those
 * targets into a small dedicated raycast set. Opaque scene geometry is represented by
 * low-poly bounding-box blockers, preserving occlusion without intersecting the complete
 * production mesh tree on every hover frame.
 *
 * Intersections are consumed front-to-back with one rule that does all the work:
 *
 * - tagged (directly or via an ancestor) → that is the hit;
 * - **see-through** (transparent, `depthWrite: false`, or transmissive) → keep going;
 * - anything else → an opaque blocker, the ray stops there and nothing is hit.
 *
 * That single rule is why the silkscreen decal floating 0.15 mm in front of a cartridge
 * cover does not eat its own click, why the transmissive CRT faceplate does not shield
 * the phosphor behind it, and why you still cannot click a keycap through the console.
 *
 * ## Instanced keycaps
 *
 * The 89 keycaps render from a handful of `InstancedMesh`es, so they carry no per-key
 * userData. `Keyboard.ts` solves this with an invisible, correctly-sized proxy box per
 * key that *does* carry the tag — three's raycaster ignores `visible`, so the proxies
 * cost nothing to draw and everything still hit-tests per key. The picker also supports
 * the direct route: an `InstancedMesh` tagged with `instanceKeys` / `instanceLabels`
 * resolves `intersection.instanceId` into a `keyCode` and label, so a future keyboard
 * that drops the proxies keeps working.
 *
 * ## Pointer model
 *
 * The picker shares the canvas with `CameraRig`. On a press that lands on a part it
 * disables the rig for the duration of the gesture, so dragging a knob never spins the
 * camera, and hands control straight back on release. Hover is recomputed once per frame
 * from the last pointer position rather than on every `pointermove`, which keeps the cost
 * flat when a trackpad fires 240 events a second.
 *
 * Touch has no hover: a tap is press + release at the same point, and the tooltip is
 * suppressed entirely.
 */

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type PickCursor = NonNullable<InteractiveUserData['cursor']>

export interface PickHit {
  /** The tagged object — not necessarily the mesh the ray touched. */
  readonly object: THREE.Object3D
  readonly partId: PartId
  readonly label: string
  readonly cursor: PickCursor
  readonly keyCode: string | undefined
  /** Set when the tagged object is an `InstancedMesh`. */
  readonly instanceId: number | undefined
  readonly point: THREE.Vector3
  readonly distance: number
  /** Everything else the module left on `userData` (`romId`, `slot`, …). */
  readonly userData: Readonly<Record<string, unknown>>
}

export interface PickerHandlers {
  /** Hover entered, moved to another part, or left (`null`). */
  onHover?(hit: PickHit | null): void
  onPress?(hit: PickHit, event: PointerEvent): void
  /** Pointer moved past the drag threshold while pressing `hit`. Deltas in pixels. */
  onDrag?(hit: PickHit, dx: number, dy: number, event: PointerEvent): void
  /** Gesture finished. `dragged` distinguishes a click from a drag. */
  onRelease?(hit: PickHit, dragged: boolean, event: PointerEvent): void
  /** Press that landed on nothing interactive. */
  onMiss?(event: PointerEvent): void
  /** Last word on the tooltip text — lets state-dependent labels override userData. */
  labelFor?(hit: PickHit): string
}

/** The slice of `CameraRig` the picker needs. Structural so it never imports it. */
export interface OrbitControlLike {
  enabled: boolean
  notifyInteraction(): void
}

export interface PickerOptions {
  readonly camera: THREE.Camera
  readonly scene: THREE.Scene
  readonly domElement: HTMLElement
  readonly handlers?: PickerHandlers
  readonly orbit?: OrbitControlLike | null
  /** Where the tooltip is appended. Defaults to the canvas's parent. */
  readonly tooltipHost?: HTMLElement | null
  /** Pixels of travel before a press becomes a drag. Must match `CameraRig`'s (4). */
  readonly dragThreshold?: number
  /** Milliseconds the pointer must rest on a part before the tooltip appears. */
  readonly tooltipDelay?: number
  readonly tooltips?: boolean
}

// ---------------------------------------------------------------------------
// userData decoding
// ---------------------------------------------------------------------------

const CURSORS: ReadonlySet<string> = new Set(['pointer', 'grab', 'ew-resize'])
const PART_IDS: ReadonlySet<string> = new Set<PartId>([
  'power-switch',
  'slot-a-cover',
  'slot-b-cover',
  'cartridge-a',
  'cartridge-b',
  'keyboard-key',
  'crt-screen',
  'crt-knob-brightness',
  'crt-knob-contrast',
  'joystick-stick',
  'joystick-button-a',
  'joystick-button-b',
  'speaker-level-knob',
  'voltage-selector',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readCursor(value: unknown): PickCursor {
  return typeof value === 'string' && CURSORS.has(value) ? (value as PickCursor) : 'pointer'
}

/** `userData` carries a `partId` we recognise. */
function taggedPart(object: THREE.Object3D): { partId: PartId; data: Record<string, unknown> } | null {
  const data = object.userData
  if (!isRecord(data)) return null
  const partId = data['partId']
  if (typeof partId !== 'string' || !PART_IDS.has(partId)) return null
  return { partId: partId as PartId, data }
}

interface TaggedTarget {
  readonly kind: 'target'
  readonly rayObject: THREE.Object3D
  readonly taggedObject: THREE.Object3D
  readonly partId: PartId
  readonly data: Record<string, unknown>
}

interface OcclusionTarget {
  readonly kind: 'occluder'
  readonly rayObject: THREE.Object3D
  readonly source: THREE.Object3D
  /** Source-local unit-box transform. `null` means raycast the source directly. */
  readonly localMatrix: THREE.Matrix4 | null
}

type PickCandidate = TaggedTarget | OcclusionTarget

/**
 * Per-instance identity for a tagged `InstancedMesh`. Accepts an array indexed by
 * `instanceId` or a record keyed by it — whichever the geometry's author found natural.
 */
function readInstanceEntry(source: unknown, instanceId: number): string | undefined {
  if (Array.isArray(source)) {
    const value = (source as readonly unknown[])[instanceId]
    return typeof value === 'string' ? value : undefined
  }
  if (isRecord(source)) {
    const value = source[String(instanceId)]
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

/** Can the ray keep going through this mesh, or does it stop here? */
function isSeeThrough(object: THREE.Object3D): boolean {
  const holder = object as unknown as { material?: THREE.Material | THREE.Material[] }
  const material = holder.material
  if (material === undefined) return true
  const list = Array.isArray(material) ? material : [material]
  if (list.length === 0) return true
  return list.every((entry) => {
    if (!entry) return true
    if (entry.transparent === true) return true
    if (entry.depthWrite === false) return true
    // Transmissive glass renders opaque-queued but is physically see-through: the CRT
    // faceplate must not shield the phosphor it sits in front of.
    const physical = entry as Partial<THREE.MeshPhysicalMaterial>
    return typeof physical.transmission === 'number' && physical.transmission > 0
  })
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

export class RaycastPicker {
  enabled = true

  private readonly camera: THREE.Camera
  private readonly scene: THREE.Scene
  private readonly domElement: HTMLElement
  private readonly handlers: PickerHandlers
  private readonly orbit: OrbitControlLike | null
  private readonly dragThreshold: number
  private readonly tooltipDelay: number
  private readonly tooltipsEnabled: boolean

  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly intersections: THREE.Intersection[] = []
  private readonly pickObjects: THREE.Object3D[] = []
  private readonly candidateByObject = new Map<THREE.Object3D, PickCandidate>()
  private readonly occluderGeometry = new THREE.BoxGeometry(1, 1, 1)
  private readonly occluderMaterial = new THREE.MeshBasicMaterial()
  private pickSetDirty = true

  private hoverHit: PickHit | null = null
  private hoverStale = false
  private pointerDirty = true
  private pointerInside = false
  private pointerReachable = false
  private pointerIsFine = true
  private clientX = 0
  private clientY = 0

  private activeHit: PickHit | null = null
  private activePointerId: number | null = null
  private activeDragged = false
  private downX = 0
  private downY = 0
  private lastX = 0
  private lastY = 0
  private orbitWasEnabled = true

  private tooltip: HTMLDivElement | null = null
  private readonly tooltipHost: HTMLElement | null
  private tooltipTimer = 0
  private tooltipText = ''

  private cachedRect: DOMRectReadOnly | null = null
  private rectDirty = true
  private readonly cameraWorld = new THREE.Matrix4()
  private readonly cameraProjection = new THREE.Matrix4()
  private cameraCached = false
  private readonly resizeObserver: ResizeObserver | null

  private disposed = false

  constructor(options: PickerOptions) {
    this.camera = options.camera
    this.scene = options.scene
    this.domElement = options.domElement
    this.handlers = options.handlers ?? {}
    this.orbit = options.orbit ?? null
    this.dragThreshold = options.dragThreshold ?? 4
    this.tooltipDelay = options.tooltipDelay ?? 130
    this.tooltipsEnabled = options.tooltips ?? true
    this.tooltipHost = options.tooltipHost ?? this.domElement.parentElement ?? document.body

    // A 1.2 mm keycap gap is a lot smaller than the raycaster's default line/point
    // thresholds; meshes ignore those, but keeping them tight costs nothing.
    this.raycaster.params.Line = { threshold: 0.0005 }
    this.raycaster.params.Points = { threshold: 0.0005 }

    this.resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            this.markRectDirty()
          })
    this.resizeObserver?.observe(this.domElement)
    this.refreshPickSet()
    this.attach()
  }

  // ── Frame hook ─────────────────────────────────────────────────────────────

  /** Recompute hover. Call once per frame — the camera may have moved on its own. */
  update(): void {
    if (this.disposed) return
    const cameraChanged = this.captureCameraMatrices()
    if (!cameraChanged && !this.pointerDirty && !this.hoverStale && !this.pickSetDirty) return

    if (this.pickSetDirty) this.refreshPickSet()
    if (this.pointerDirty || this.rectDirty) {
      const rect = this.readRect()
      this.pointerReachable = this.pointerInside && this.pointerOverCanvas(rect)
    }
    this.pointerDirty = false

    if (!this.enabled || !this.pointerReachable || this.activeHit !== null) {
      if (this.hoverHit !== null && (!this.enabled || !this.pointerReachable)) this.setHover(null)
      return
    }

    if (this.hoverStale) {
      this.hoverStale = false
      this.hoverHit = null
    }
    this.setHover(this.hitTest(this.clientX, this.clientY, this.readRect()))
  }

  /**
   * Drop the cached hover so the next frame re-emits it. Call after the scene changed
   * under a stationary cursor — a cartridge left the slot, a label became stale.
   */
  invalidate(): void {
    this.hoverStale = true
    this.pickSetDirty = true
  }

  get hovered(): PickHit | null {
    return this.hoverHit
  }

  get pressed(): PickHit | null {
    return this.activeHit
  }

  /** True while the pointer is a mouse or pen — i.e. hover and tooltips make sense. */
  get fine(): boolean {
    return this.pointerIsFine
  }

  /**
   * Is the canvas really the top-most thing under the cursor?
   *
   * `pointerenter` alone is not enough: the HUD floats over the canvas, and hovering a
   * control panel must not also light up the machine behind it. `elementFromPoint`
   * answers that exactly. The result is cached until the pointer or canvas rect changes,
   * so camera auto-rotation does not trigger another DOM hit-test by itself.
   */
  private pointerOverCanvas(rect: DOMRectReadOnly): boolean {
    if (
      this.clientX < rect.left ||
      this.clientX > rect.right ||
      this.clientY < rect.top ||
      this.clientY > rect.bottom
    ) {
      return false
    }
    if (typeof document.elementFromPoint !== 'function') return true
    const top = document.elementFromPoint(this.clientX, this.clientY)
    return top === null || top === this.domElement
  }

  private markRectDirty = (): void => {
    this.rectDirty = true
    this.pointerDirty = true
  }

  private readRect(): DOMRectReadOnly {
    if (this.cachedRect === null || this.rectDirty) {
      this.cachedRect = this.domElement.getBoundingClientRect()
      this.rectDirty = false
    }
    return this.cachedRect
  }

  private captureCameraMatrices(): boolean {
    if (
      this.cameraCached &&
      this.cameraWorld.equals(this.camera.matrixWorld) &&
      this.cameraProjection.equals(this.camera.projectionMatrix)
    ) {
      return false
    }
    this.cameraWorld.copy(this.camera.matrixWorld)
    this.cameraProjection.copy(this.camera.projectionMatrix)
    this.cameraCached = true
    return true
  }

  // ── Picking ────────────────────────────────────────────────────────────────

  /** Hit-test at viewport coordinates. Returns the nearest reachable tagged part. */
  pickAt(clientX: number, clientY: number): PickHit | null {
    if (this.pickSetDirty) this.refreshPickSet()
    return this.hitTest(clientX, clientY, this.readRect())
  }

  private hitTest(clientX: number, clientY: number, rect: DOMRectReadOnly): PickHit | null {
    if (rect.width <= 0 || rect.height <= 0) return null
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(this.pointer, this.camera)

    this.syncOccluderMatrices()
    this.intersections.length = 0
    this.raycaster.intersectObjects(this.pickObjects, false, this.intersections)

    for (const intersection of this.intersections) {
      const candidate = this.candidateByObject.get(intersection.object)
      if (candidate === undefined || candidate.kind === 'occluder') return null
      return this.toHit(
        candidate.taggedObject,
        candidate.partId,
        candidate.data,
        intersection,
      )
    }
    return null
  }

  private findTaggedAncestor(object: THREE.Object3D): {
    object: THREE.Object3D
    partId: PartId
    data: Record<string, unknown>
  } | null {
    let node: THREE.Object3D | null = object
    while (node !== null) {
      const tag = taggedPart(node)
      if (tag !== null) return { object: node, partId: tag.partId, data: tag.data }
      node = node.parent
    }
    return null
  }

  private refreshPickSet(): void {
    this.pickSetDirty = false
    this.pickObjects.length = 0
    this.candidateByObject.clear()
    this.scene.updateMatrixWorld()

    const center = new THREE.Vector3()
    const size = new THREE.Vector3()
    const rotation = new THREE.Quaternion()
    const targetPoints: THREE.Vector3[] = []
    const occluders: THREE.Mesh[] = []

    this.scene.traverse((object) => {
      if (
        !(object instanceof THREE.Mesh) &&
        !(object instanceof THREE.Line) &&
        !(object instanceof THREE.Points) &&
        !(object instanceof THREE.Sprite)
      ) {
        return
      }

      const tagged = this.findTaggedAncestor(object)
      if (tagged !== null) {
        const candidate: TaggedTarget = {
          kind: 'target',
          rayObject: object,
          taggedObject: tagged.object,
          partId: tagged.partId,
          data: tagged.data,
        }
        this.pickObjects.push(object)
        this.candidateByObject.set(object, candidate)
        if (object instanceof THREE.Mesh) {
          const geometry = object.geometry
          if (geometry.boundingBox === null) geometry.computeBoundingBox()
          if (geometry.boundingBox !== null && !geometry.boundingBox.isEmpty()) {
            targetPoints.push(
              geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(object.matrixWorld),
            )
          }
        } else {
          targetPoints.push(object.getWorldPosition(new THREE.Vector3()))
        }
        return
      }

      if (!(object instanceof THREE.Mesh) || isSeeThrough(object)) return
      occluders.push(object)
    })

    const addOccluder = (
      rayObject: THREE.Object3D,
      source: THREE.Object3D,
      localMatrix: THREE.Matrix4 | null,
    ): void => {
      const candidate: OcclusionTarget = {
        kind: 'occluder',
        rayObject,
        source,
        localMatrix,
      }
      this.pickObjects.push(rayObject)
      this.candidateByObject.set(rayObject, candidate)
    }

    for (const object of occluders) {
      if (object instanceof THREE.InstancedMesh || object instanceof THREE.SkinnedMesh) {
        addOccluder(object, object, null)
        continue
      }

      const geometry = object.geometry
      if (geometry.boundingBox === null) geometry.computeBoundingBox()
      const bounds = geometry.boundingBox
      if (bounds === null || bounds.isEmpty()) continue

      // A box cannot stand in for a bezel, shell, or panel whose aperture contains an
      // interactive control: it would fill that aperture and make the target unreachable.
      // Keep the exact geometry only for those exceptional blockers; every other opaque
      // detail gets the shared 12-triangle proxy below.
      const worldBounds = bounds.clone().applyMatrix4(object.matrixWorld)
      if (targetPoints.some((point) => worldBounds.containsPoint(point))) {
        addOccluder(object, object, null)
        continue
      }

      bounds.getCenter(center)
      bounds.getSize(size)
      if (size.x <= 0 || size.y <= 0 || size.z <= 0) continue

      const localMatrix = new THREE.Matrix4().compose(center, rotation, size)
      const proxy = new THREE.Mesh(this.occluderGeometry, this.occluderMaterial)
      proxy.name = `oclusor:${object.name}`
      proxy.matrixAutoUpdate = false
      addOccluder(proxy, object, localMatrix)
    }
  }

  private syncOccluderMatrices(): void {
    for (const candidate of this.candidateByObject.values()) {
      if (candidate.kind !== 'occluder' || candidate.localMatrix === null) continue
      candidate.rayObject.matrixWorld.multiplyMatrices(
        candidate.source.matrixWorld,
        candidate.localMatrix,
      )
    }
  }

  private toHit(
    object: THREE.Object3D,
    partId: PartId,
    data: Record<string, unknown>,
    intersection: THREE.Intersection,
  ): PickHit {
    const instanceId = intersection.object === object ? intersection.instanceId : undefined

    let keyCode = typeof data['keyCode'] === 'string' ? data['keyCode'] : undefined
    let label = typeof data['label'] === 'string' ? data['label'] : ''

    if (instanceId !== undefined) {
      const instanceKey = readInstanceEntry(data['instanceKeys'], instanceId)
      if (instanceKey !== undefined) keyCode = instanceKey
      const instanceLabel = readInstanceEntry(data['instanceLabels'], instanceId)
      if (instanceLabel !== undefined) label = instanceLabel
    }

    return {
      object,
      partId,
      label,
      cursor: readCursor(data['cursor']),
      keyCode,
      instanceId,
      point: intersection.point,
      distance: intersection.distance,
      userData: data,
    }
  }

  // ── Hover ──────────────────────────────────────────────────────────────────

  private setHover(hit: PickHit | null): void {
    const previous = this.hoverHit
    const sameTarget =
      previous !== null &&
      hit !== null &&
      previous.object === hit.object &&
      previous.keyCode === hit.keyCode &&
      previous.instanceId === hit.instanceId

    this.hoverHit = hit

    if (sameTarget) {
      // Same part, new ray position: only the tooltip needs to follow the cursor.
      this.positionTooltip()
      return
    }

    this.applyCursor(hit)
    this.updateTooltip(hit)
    this.handlers.onHover?.(hit)
  }

  private applyCursor(hit: PickHit | null): void {
    // Mid-gesture the cursor belongs to the gesture, not to whatever is under the ray.
    if (this.activeHit !== null) return
    this.domElement.style.cursor = hit === null ? '' : hit.cursor
  }

  // ── Tooltip ────────────────────────────────────────────────────────────────

  private ensureTooltip(): HTMLDivElement | null {
    if (!this.tooltipsEnabled || this.tooltipHost === null) return null
    if (this.tooltip !== null) return this.tooltip
    const node = document.createElement('div')
    node.dataset['msxTooltip'] = ''
    node.setAttribute('role', 'tooltip')
    node.setAttribute('aria-hidden', 'true')
    // Inline so the HUD's stylesheet is never a load-bearing dependency; every value is
    // a custom property the HUD can override without touching this file.
    node.style.cssText = [
      'position:fixed',
      'z-index:8',
      'pointer-events:none',
      'opacity:0',
      'transform:translate3d(0,4px,0)',
      'transition:opacity 120ms ease,transform 120ms ease',
      'padding:var(--msx-tip-pad,5px 9px)',
      'border-radius:var(--msx-tip-radius,3px)',
      'border:1px solid var(--msx-tip-border,rgba(214,210,199,0.16))',
      'background:var(--msx-tip-bg,rgba(14,14,16,0.92))',
      'color:var(--msx-tip-fg,#d8d5cc)',
      'font:500 11.5px/1.35 Inter,system-ui,sans-serif',
      'letter-spacing:0.02em',
      // Wraps rather than truncating: a hover label that ends in "…" tells the user
      // nothing, and these labels are full sentences in pt-BR.
      'max-width:min(300px,62vw)',
      'white-space:normal',
      'text-wrap:balance',
      'backdrop-filter:blur(6px)',
      '-webkit-backdrop-filter:blur(6px)',
    ].join(';')
    this.tooltipHost.appendChild(node)
    this.tooltip = node
    return node
  }

  private updateTooltip(hit: PickHit | null): void {
    window.clearTimeout(this.tooltipTimer)
    if (hit === null || !this.pointerIsFine || this.activeHit !== null) {
      this.hideTooltip()
      return
    }
    const text = this.handlers.labelFor?.(hit) ?? hit.label
    if (text.trim() === '') {
      this.hideTooltip()
      return
    }
    this.tooltipText = text
    this.tooltipTimer = window.setTimeout(() => {
      this.showTooltip()
    }, this.tooltipDelay)
  }

  private showTooltip(): void {
    const node = this.ensureTooltip()
    if (node === null || this.hoverHit === null) return
    node.textContent = this.tooltipText
    node.setAttribute('aria-hidden', 'false')
    node.style.opacity = '1'
    node.style.transform = 'translate3d(0,0,0)'
    this.positionTooltip()
  }

  private positionTooltip(): void {
    const node = this.tooltip
    if (node === null || node.style.opacity === '0') return
    const width = node.offsetWidth
    const height = node.offsetHeight
    const margin = 14
    const left = Math.min(this.clientX + margin, window.innerWidth - width - 8)
    // Flip above the cursor when there is no room below.
    const below = this.clientY + margin
    const top = below + height > window.innerHeight - 8 ? this.clientY - height - margin : below
    node.style.left = `${Math.max(8, left)}px`
    node.style.top = `${Math.max(8, top)}px`
  }

  private hideTooltip(): void {
    const node = this.tooltip
    if (node === null) return
    node.style.opacity = '0'
    node.style.transform = 'translate3d(0,4px,0)'
    node.setAttribute('aria-hidden', 'true')
  }

  /** Let the HUD suppress the built-in tooltip and render hover text itself. */
  setTooltipVisible(visible: boolean): void {
    if (!visible) {
      window.clearTimeout(this.tooltipTimer)
      this.hideTooltip()
    } else if (this.hoverHit !== null) {
      this.updateTooltip(this.hoverHit)
    }
  }

  // ── Pointer plumbing ───────────────────────────────────────────────────────

  private attach(): void {
    const el = this.domElement
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointerenter', this.onPointerEnter)
    el.addEventListener('pointerleave', this.onPointerLeave)
    window.addEventListener('pointermove', this.onPointerMove, { passive: true })
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerCancel)
    window.addEventListener('blur', this.onWindowBlur)
    window.addEventListener('resize', this.markRectDirty)
    window.addEventListener('scroll', this.markRectDirty, true)
  }

  private detach(): void {
    const el = this.domElement
    el.removeEventListener('pointerdown', this.onPointerDown)
    el.removeEventListener('pointerenter', this.onPointerEnter)
    el.removeEventListener('pointerleave', this.onPointerLeave)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerCancel)
    window.removeEventListener('blur', this.onWindowBlur)
    window.removeEventListener('resize', this.markRectDirty)
    window.removeEventListener('scroll', this.markRectDirty, true)
  }

  private readonly onPointerEnter = (event: PointerEvent): void => {
    this.pointerIsFine = event.pointerType !== 'touch'
    this.pointerInside = true
    this.pointerDirty = true
  }

  private readonly onPointerLeave = (): void => {
    this.pointerInside = false
    this.pointerReachable = false
    this.pointerDirty = true
    if (this.activeHit === null) this.setHover(null)
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (
      event.clientX !== this.clientX ||
      event.clientY !== this.clientY ||
      this.pointerIsFine !== (event.pointerType !== 'touch') ||
      (!this.pointerInside && event.target === this.domElement)
    ) {
      this.pointerDirty = true
    }
    this.clientX = event.clientX
    this.clientY = event.clientY
    this.pointerIsFine = event.pointerType !== 'touch'
    if (event.target === this.domElement) this.pointerInside = true

    if (this.activeHit === null) {
      this.positionTooltip()
      return
    }
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) return

    if (!this.activeDragged) {
      const travel = Math.hypot(event.clientX - this.downX, event.clientY - this.downY)
      if (travel < this.dragThreshold) return
      this.activeDragged = true
    }
    const dx = event.clientX - this.lastX
    const dy = event.clientY - this.lastY
    this.lastX = event.clientX
    this.lastY = event.clientY
    this.handlers.onDrag?.(this.activeHit, dx, dy, event)
    this.orbit?.notifyInteraction()
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled || this.activeHit !== null) return
    // Secondary and middle buttons belong to the camera rig (pan).
    if (event.button !== 0 && event.pointerType === 'mouse') return

    this.clientX = event.clientX
    this.clientY = event.clientY
    this.pointerIsFine = event.pointerType !== 'touch'
    this.pointerInside = true
    this.pointerDirty = true

    const hit = this.pickAt(event.clientX, event.clientY)
    if (hit === null) {
      this.handlers.onMiss?.(event)
      return
    }

    this.activeHit = hit
    this.activePointerId = event.pointerId
    this.activeDragged = false
    this.downX = event.clientX
    this.downY = event.clientY
    this.lastX = event.clientX
    this.lastY = event.clientY

    // Take the gesture away from the orbit controller: dragging a knob must not also
    // swing the camera. `CameraRig` reads `enabled` inside its own move handler, so
    // flipping it here is enough — no event has to be swallowed.
    if (this.orbit !== null) {
      this.orbitWasEnabled = this.orbit.enabled
      this.orbit.enabled = false
      this.orbit.notifyInteraction()
    }

    this.hideTooltip()
    window.clearTimeout(this.tooltipTimer)
    this.domElement.style.cursor = hit.cursor === 'grab' ? 'grabbing' : hit.cursor
    this.handlers.onPress?.(hit, event)
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const hit = this.activeHit
    if (hit === null) return
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) return
    this.finishGesture(hit, event)
  }

  private readonly onPointerCancel = (event: PointerEvent): void => {
    const hit = this.activeHit
    if (hit === null) return
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) return
    this.finishGesture(hit, event, true)
  }

  private finishGesture(hit: PickHit, event: PointerEvent, cancelled = false): void {
    const dragged = this.activeDragged || cancelled
    this.activeHit = null
    this.activePointerId = null
    this.activeDragged = false

    if (this.orbit !== null) this.orbit.enabled = this.orbitWasEnabled

    this.handlers.onRelease?.(hit, dragged, event)

    if (this.pointerIsFine && this.pointerInside) {
      this.setHover(this.pickAt(event.clientX, event.clientY))
      this.pointerDirty = false
    } else {
      this.setHover(null)
      this.domElement.style.cursor = ''
    }
  }

  private readonly onWindowBlur = (): void => {
    const hit = this.activeHit
    this.activeHit = null
    this.activePointerId = null
    this.activeDragged = false
    if (this.orbit !== null) this.orbit.enabled = this.orbitWasEnabled
    if (hit !== null) this.handlers.onRelease?.(hit, true, new PointerEvent('pointercancel'))
    this.setHover(null)
    this.pointerDirty = true
    this.domElement.style.cursor = ''
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.detach()
    this.resizeObserver?.disconnect()
    window.clearTimeout(this.tooltipTimer)
    this.tooltip?.remove()
    this.tooltip = null
    this.hoverHit = null
    if (this.activeHit !== null && this.orbit !== null) this.orbit.enabled = this.orbitWasEnabled
    this.activeHit = null
    this.pickObjects.length = 0
    this.candidateByObject.clear()
    this.occluderGeometry.dispose()
    this.occluderMaterial.dispose()
    this.domElement.style.cursor = ''
  }
}
