import * as THREE from 'three'

/**
 * CameraRig — spherical orbit / pan / zoom controller with damped inertia.
 *
 * Written in-house instead of using `OrbitControls` because we need:
 *  - programmatic, instantaneous pose control for the screenshot harness,
 *  - a desk-plane floor constraint that depends on the *target* height, not just a
 *    fixed polar-angle clamp,
 *  - an idle auto-rotate that ramps in rather than snapping,
 *  - a drag threshold so single clicks stay available to the raycast interaction layer.
 *
 * Coordinate convention (matches `tools/shoot.mjs` poses):
 *   azimuth  0°  → camera in front of the target, on +Z, looking towards −Z.
 *   azimuth  90° → camera on +X (the machine's right-hand side).
 *   elevation 0° → camera level with the target; 90° → straight above.
 *
 *   x = target.x + d·cos(elevation)·sin(azimuth)
 *   y = target.y + d·sin(elevation)
 *   z = target.z + d·cos(elevation)·cos(azimuth)
 */

/** Camera pose. Angles in **degrees**, distance in **metres**. All fields optional. */
export interface CameraPose {
  readonly azimuth?: number
  readonly elevation?: number
  readonly distance?: number
  readonly target?: Vec3Like
}

/** A resolved pose — every field present. Returned by {@link CameraRig.getPose}. */
export interface ResolvedCameraPose {
  readonly azimuth: number
  readonly elevation: number
  readonly distance: number
  readonly target: readonly [number, number, number]
}

/** Accepts `[x, y, z]`, `{ x, y, z }` or a `THREE.Vector3`. */
export type Vec3Like =
  | readonly [number, number, number]
  | { readonly x: number; readonly y: number; readonly z: number }

export interface CameraRigOptions {
  /** Metres. Default 0.15. */
  readonly minDistance?: number
  /** Metres. Default 2.5. */
  readonly maxDistance?: number
  /** Degrees. Hard lower bound on elevation. Default 1.5. */
  readonly minElevation?: number
  /** Degrees. Default 89 (avoids the gimbal singularity at the pole). */
  readonly maxElevation?: number
  /** World Y of the desk surface. The camera never descends below this. Default 0. */
  readonly floorY?: number
  /** Metres of clearance kept above `floorY`. Default 0.015. */
  readonly floorMargin?: number
  /** Seconds of inactivity before auto-rotate engages. Default 8. */
  readonly idleDelay?: number
  /** Degrees per second once auto-rotate is at full speed. Default 2.6. */
  readonly autoRotateSpeed?: number
  /** Seconds the auto-rotate takes to ramp from 0 to full speed. Default 2.2. */
  readonly autoRotateRamp?: number
  /** Idle auto-rotate. Default false for reduced motion or coarse pointers, true otherwise. */
  readonly autoRotate?: boolean
  /** Exponential damping rate (1/s). Higher = snappier. Default 9. */
  readonly damping?: number
  /** Pixels of pointer travel before a press is treated as a drag. Default 4. */
  readonly dragThreshold?: number
  /** Bounds the pan target so the user cannot fly off the set. */
  readonly panBounds?: THREE.Box3
  /** Starting pose. Default is the hero pose. */
  readonly initialPose?: CameraPose
}

const DEG = Math.PI / 180
const TAU = Math.PI * 2

const DEFAULT_POSE: Required<Omit<CameraPose, 'target'>> & {
  target: readonly [number, number, number]
} = {
  azimuth: 38,
  elevation: 22,
  distance: 0.95,
  target: [0, 0.06, 0],
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Signed shortest angular delta from `from` to `to`, in radians. */
function shortestDelta(from: number, to: number): number {
  return ((((to - from) % TAU) + TAU + Math.PI) % TAU) - Math.PI
}

function readVec3(v: Vec3Like, out: THREE.Vector3): THREE.Vector3 {
  if (Array.isArray(v)) {
    const [x, y, z] = v as readonly [number, number, number]
    return out.set(x, y, z)
  }
  const o = v as { readonly x: number; readonly y: number; readonly z: number }
  return out.set(o.x, o.y, o.z)
}

function defaultAutoRotate(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return !(
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    window.matchMedia('(pointer: coarse)').matches
  )
}

interface PointerSample {
  x: number
  y: number
}

type DragMode = 'none' | 'orbit' | 'pan' | 'gesture'

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera
  readonly domElement: HTMLElement

  /** Set false to hand pointer control over to another system (e.g. dragging a part). */
  enabled = true

  private readonly minDistance: number
  private readonly maxDistance: number
  private readonly minElevation: number
  private readonly maxElevation: number
  private readonly floorY: number
  private readonly floorMargin: number
  private readonly idleDelay: number
  private readonly autoRotateSpeed: number
  private readonly autoRotateRamp: number
  private readonly damping: number
  private readonly dragThreshold: number
  private readonly panBounds: THREE.Box3

  private readonly defaultPose: ResolvedCameraPose

  // Goal (what input drives) and current (what the camera actually shows).
  private goalAzimuth: number
  private goalElevation: number
  private goalDistance: number
  private readonly goalTarget = new THREE.Vector3()

  private curAzimuth: number
  private curElevation: number
  private curDistance: number
  private readonly curTarget = new THREE.Vector3()

  private autoRotateEnabled = true
  private idleTime = 0

  private readonly pointers = new Map<number, PointerSample>()
  private dragMode: DragMode = 'none'
  private dragArmed = false
  private dragging = false
  private downX = 0
  private downY = 0
  private lastX = 0
  private lastY = 0
  private gestureDistance = 0
  private gestureMidX = 0
  private gestureMidY = 0

  private disposed = false

  private readonly scratchVec = new THREE.Vector3()
  private readonly right = new THREE.Vector3()
  private readonly up = new THREE.Vector3()

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    options: CameraRigOptions = {},
  ) {
    this.camera = camera
    this.domElement = domElement

    this.minDistance = options.minDistance ?? 0.15
    this.maxDistance = options.maxDistance ?? 2.5
    this.minElevation = (options.minElevation ?? 1.5) * DEG
    this.maxElevation = (options.maxElevation ?? 89) * DEG
    this.floorY = options.floorY ?? 0
    this.floorMargin = options.floorMargin ?? 0.015
    this.idleDelay = options.idleDelay ?? 8
    this.autoRotateSpeed = (options.autoRotateSpeed ?? 2.6) * DEG
    this.autoRotateRamp = options.autoRotateRamp ?? 2.2
    this.autoRotateEnabled = options.autoRotate ?? defaultAutoRotate()
    this.damping = options.damping ?? 9
    this.dragThreshold = options.dragThreshold ?? 4
    this.panBounds =
      options.panBounds ??
      new THREE.Box3(new THREE.Vector3(-0.7, -0.05, -0.7), new THREE.Vector3(0.7, 0.55, 0.7))

    const initial = options.initialPose ?? DEFAULT_POSE
    this.goalAzimuth = (initial.azimuth ?? DEFAULT_POSE.azimuth) * DEG
    this.goalElevation = (initial.elevation ?? DEFAULT_POSE.elevation) * DEG
    this.goalDistance = initial.distance ?? DEFAULT_POSE.distance
    readVec3(initial.target ?? DEFAULT_POSE.target, this.goalTarget)

    this.clampGoals()
    this.curAzimuth = this.goalAzimuth
    this.curElevation = this.goalElevation
    this.curDistance = this.goalDistance
    this.curTarget.copy(this.goalTarget)

    this.defaultPose = this.getPose()

    this.camera.up.set(0, 1, 0)
    this.applyToCamera()
    this.attach()
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Drive the camera to a pose. Angles in degrees, distance in metres.
   * Omitted fields keep their current goal.
   *
   * @param immediate skip damping and land on the pose this instant (screenshot harness).
   */
  setPose(pose: CameraPose, immediate = false): void {
    if (pose.azimuth !== undefined) {
      const wanted = pose.azimuth * DEG
      // Take the short way round so a 359°→1° move does not spin the whole scene.
      this.goalAzimuth = this.goalAzimuth + shortestDelta(this.goalAzimuth, wanted)
    }
    if (pose.elevation !== undefined) this.goalElevation = pose.elevation * DEG
    if (pose.distance !== undefined) this.goalDistance = pose.distance
    if (pose.target !== undefined) readVec3(pose.target, this.goalTarget)

    this.clampGoals()

    if (immediate) {
      this.curAzimuth = this.goalAzimuth
      this.curElevation = this.goalElevation
      this.curDistance = this.goalDistance
      this.curTarget.copy(this.goalTarget)
      this.applyToCamera()
    }
    this.notifyInteraction()
  }

  /** Land on a pose instantly, with no damping. Used by `window.__msxCamera`. */
  jumpTo(pose: CameraPose): void {
    this.setPose(pose, true)
  }

  /** Current *goal* pose, in degrees / metres. */
  getPose(): ResolvedCameraPose {
    return {
      azimuth: this.goalAzimuth / DEG,
      elevation: this.goalElevation / DEG,
      distance: this.goalDistance,
      target: [this.goalTarget.x, this.goalTarget.y, this.goalTarget.z],
    }
  }

  /** Return to the pose the rig was constructed with. */
  resetPose(immediate = false): void {
    this.setPose(this.defaultPose, immediate)
  }

  setAutoRotate(enabled: boolean): void {
    this.autoRotateEnabled = enabled
    if (!enabled) this.idleTime = 0
  }

  get autoRotate(): boolean {
    return this.autoRotateEnabled
  }

  get autoRotating(): boolean {
    return this.autoRotateEnabled && this.idleTime > this.idleDelay
  }

  /** Reset the idle timer — call this from any other system that counts as user input. */
  notifyInteraction(): void {
    this.idleTime = 0
  }

  /**
   * True when the damping has landed and the auto-rotate is not driving: the next
   * `update()` will not move the camera. The Engine reads this (plus a raw camera
   * matrix comparison) to decide whether a frame needs presenting at all.
   */
  get isSettled(): boolean {
    return (
      !this.autoRotating &&
      this.curAzimuth === this.goalAzimuth &&
      this.curElevation === this.goalElevation &&
      this.curDistance === this.goalDistance &&
      this.curTarget.equals(this.goalTarget)
    )
  }

  /** Advance damping and auto-rotate, then write the result to the camera. */
  update(dt: number): void {
    if (this.disposed) return
    const step = clamp(dt, 0, 0.1)

    this.idleTime += step
    if (this.autoRotateEnabled && this.idleTime > this.idleDelay) {
      const ramp = smoothstep(0, this.autoRotateRamp, this.idleTime - this.idleDelay)
      this.goalAzimuth += this.autoRotateSpeed * ramp * step
    }

    this.clampGoals()

    if (this.isSettled) return

    // Frame-rate independent exponential smoothing.
    const k = 1 - Math.exp(-this.damping * step)
    this.curAzimuth += shortestDelta(this.curAzimuth, this.goalAzimuth) * k
    this.curElevation += (this.goalElevation - this.curElevation) * k
    this.curDistance += (this.goalDistance - this.curDistance) * k
    this.curTarget.lerp(this.goalTarget, k)

    // Snap once inside the sub-pixel band, so the exponential approach converges in
    // finite time instead of asymptotically. 1e-5 rad at 0.95 m is ≈ 0.01 mm of
    // subject motion — far below a pixel at 1440p — and without the snap the loop
    // would keep re-rendering forever chasing deltas the screen cannot show.
    if (
      Math.abs(shortestDelta(this.curAzimuth, this.goalAzimuth)) < 1e-5 &&
      Math.abs(this.goalElevation - this.curElevation) < 1e-5 &&
      Math.abs(this.goalDistance - this.curDistance) < 1e-6 &&
      this.curTarget.distanceToSquared(this.goalTarget) < 1e-12
    ) {
      this.curAzimuth = this.goalAzimuth
      this.curElevation = this.goalElevation
      this.curDistance = this.goalDistance
      this.curTarget.copy(this.goalTarget)
    }

    this.applyToCamera()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.detach()
    this.pointers.clear()
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private clampGoals(): void {
    this.goalDistance = clamp(this.goalDistance, this.minDistance, this.maxDistance)
    this.goalTarget.clamp(this.panBounds.min, this.panBounds.max)

    // The camera must never dip below the desk plane. With the target possibly raised
    // above the desk, the admissible minimum elevation depends on the distance.
    const rise = this.floorY + this.floorMargin - this.goalTarget.y
    const geometricMin = Math.asin(clamp(rise / this.goalDistance, -1, 1))
    const lo = Math.max(this.minElevation, geometricMin)
    const hi = Math.max(lo, this.maxElevation)
    this.goalElevation = clamp(this.goalElevation, lo, hi)
  }

  private applyToCamera(): void {
    const cosE = Math.cos(this.curElevation)
    const sinE = Math.sin(this.curElevation)
    this.camera.position.set(
      this.curTarget.x + this.curDistance * cosE * Math.sin(this.curAzimuth),
      this.curTarget.y + this.curDistance * sinE,
      this.curTarget.z + this.curDistance * cosE * Math.cos(this.curAzimuth),
    )
    // Belt and braces: even mid-damping the camera stays above the desk.
    if (this.camera.position.y < this.floorY + this.floorMargin) {
      this.camera.position.y = this.floorY + this.floorMargin
    }
    this.camera.lookAt(this.curTarget)
    this.camera.updateMatrixWorld()
  }

  private attach(): void {
    const el = this.domElement
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('wheel', this.onWheel, { passive: false })
    el.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('pointermove', this.onPointerMove, { passive: false })
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    window.addEventListener('blur', this.onBlur)
  }

  private detach(): void {
    const el = this.domElement
    el.removeEventListener('pointerdown', this.onPointerDown)
    el.removeEventListener('wheel', this.onWheel)
    el.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    window.removeEventListener('blur', this.onBlur)
  }

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault()
  }

  private readonly onBlur = (): void => {
    this.pointers.clear()
    this.dragMode = 'none'
    this.dragArmed = false
    this.dragging = false
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    this.notifyInteraction()

    if (this.pointers.size === 1) {
      const wantsPan = e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey || e.metaKey
      this.dragMode = wantsPan ? 'pan' : 'orbit'
      this.dragArmed = true
      this.dragging = false
      this.downX = e.clientX
      this.downY = e.clientY
      this.lastX = e.clientX
      this.lastY = e.clientY
    } else if (this.pointers.size === 2) {
      this.dragMode = 'gesture'
      this.dragArmed = true
      this.dragging = true
      this.readGesture()
    } else {
      this.dragMode = 'none'
    }
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.enabled || !this.pointers.has(e.pointerId)) return
    const sample = this.pointers.get(e.pointerId)
    if (!sample) return
    sample.x = e.clientX
    sample.y = e.clientY

    if (this.dragMode === 'gesture') {
      this.applyGesture()
      this.notifyInteraction()
      if (e.cancelable) e.preventDefault()
      return
    }
    if (!this.dragArmed || this.dragMode === 'none') return

    if (!this.dragging) {
      const travel = Math.hypot(e.clientX - this.downX, e.clientY - this.downY)
      // Below the threshold the press still belongs to the raycast interaction layer.
      if (travel < this.dragThreshold) return
      this.dragging = true
    }

    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY

    if (this.dragMode === 'pan') this.pan(dx, dy)
    else this.orbit(dx, dy)

    this.notifyInteraction()
    if (e.cancelable) e.preventDefault()
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (!this.pointers.delete(e.pointerId)) return
    if (this.pointers.size === 1) {
      // Dropped from a two-finger gesture back to one finger: re-seat the orbit anchor.
      const remaining = this.pointers.values().next().value
      if (remaining) {
        this.dragMode = 'orbit'
        this.dragArmed = true
        this.dragging = true
        this.lastX = remaining.x
        this.lastY = remaining.y
        this.downX = remaining.x
        this.downY = remaining.y
      }
    } else if (this.pointers.size === 0) {
      this.dragMode = 'none'
      this.dragArmed = false
      this.dragging = false
    }
    this.notifyInteraction()
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return
    e.preventDefault()
    // Normalise line / page deltas to pixels.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.viewportHeight() : 1
    const delta = clamp(e.deltaY * unit, -600, 600)
    this.goalDistance *= Math.exp(delta * 0.0011)
    this.clampGoals()
    this.notifyInteraction()
  }

  private orbit(dx: number, dy: number): void {
    const h = this.viewportHeight()
    const speed = 0.85
    this.goalAzimuth -= (TAU * dx * speed) / h
    this.goalElevation += (TAU * dy * speed) / h
    this.clampGoals()
  }

  private pan(dx: number, dy: number): void {
    const h = this.viewportHeight()
    // World units per screen pixel at the target plane.
    const perPx = (2 * this.goalDistance * Math.tan((this.camera.fov * DEG) / 2)) / h
    const m = this.camera.matrixWorld.elements
    this.right.set(m[0] ?? 1, m[1] ?? 0, m[2] ?? 0)
    this.up.set(m[4] ?? 0, m[5] ?? 1, m[6] ?? 0)

    this.goalTarget.add(this.scratchVec.copy(this.right).multiplyScalar(-dx * perPx))
    this.goalTarget.add(this.scratchVec.copy(this.up).multiplyScalar(dy * perPx))
    this.clampGoals()
  }

  private readGesture(): void {
    const it = this.pointers.values()
    const a = it.next().value
    const b = it.next().value
    if (!a || !b) return
    this.gestureDistance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
    this.gestureMidX = (a.x + b.x) / 2
    this.gestureMidY = (a.y + b.y) / 2
  }

  private applyGesture(): void {
    const it = this.pointers.values()
    const a = it.next().value
    const b = it.next().value
    if (!a || !b) return

    const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
    const midX = (a.x + b.x) / 2
    const midY = (a.y + b.y) / 2

    // Pinch → zoom.
    this.goalDistance *= this.gestureDistance / dist
    // Two-finger drag → pan.
    this.pan(midX - this.gestureMidX, midY - this.gestureMidY)

    this.gestureDistance = dist
    this.gestureMidX = midX
    this.gestureMidY = midY
    this.clampGoals()
  }

  private viewportHeight(): number {
    return Math.max(1, this.domElement.clientHeight || window.innerHeight)
  }
}
