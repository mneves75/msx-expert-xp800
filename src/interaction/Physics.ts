import * as THREE from 'three'

/**
 * Physics — hand-rolled spring/damper solvers for the interaction layer.
 *
 * No physics engine: everything the XP-800 does mechanically is a one- or two-degree-of-
 * freedom system, and a 6 kB analytic solver beats a 600 kB library that would blow the
 * asset budget (SPEC §10).
 *
 * The four systems SPEC §8 calls for:
 *
 * - {@link KeycapTravel} — 3 mm of keycap stroke. Critically damped going down (a real
 *   switch never bounces *into* the bottom-out), under-damped coming back up, with a
 *   restitution stop at each end so the cap audibly-visibly taps its limits.
 * - {@link CartridgeInsertion} — an insertion axis with a rising friction profile, a
 *   Gaussian detent well where the connector seats, and a wobble excited by the snap.
 * - {@link HingeFlap} — the dust-cover flap: a top-hinged pendulum with a return spring,
 *   an angle limit, and a soft bounce when it slaps closed.
 * - {@link Cable} — inextensible chain solving deviations from a rest curve, so the
 *   keyboard lead and the AC cord swing and settle when the machine is disturbed.
 *   {@link catenary} supplies the rest curve when nobody else has authored one.
 *
 * Every integrator here is **frame-rate independent**. {@link Spring} uses the exact
 * solution of the damped harmonic oscillator rather than an Euler step, so a 12 fps
 * frame and eighty 144 fps frames land in the same place and neither one explodes.
 *
 * The module exports plain classes with no `three` dependency except {@link Cable}
 * and {@link catenary}, which speak `Vector3`.
 */

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

const TINY = 1e-9

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

/** Frame-rate independent exponential approach. `rate` is in 1/s. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  if (!(dt > 0)) return current
  return target + (current - target) * Math.exp(-rate * dt)
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

// ---------------------------------------------------------------------------
// Spring — exact damped harmonic oscillator
// ---------------------------------------------------------------------------

export interface SpringOptions {
  /** Undamped angular frequency, rad/s. Higher = snappier. */
  readonly omega?: number
  /** Damping ratio. `1` critical, `<1` overshoots, `>1` crawls in. */
  readonly zeta?: number
  readonly value?: number
  readonly velocity?: number
  readonly target?: number
}

/**
 * Scalar spring/damper integrated in closed form.
 *
 * For `x = value − target` the equation is `ẍ + 2ζω·ẋ + ω²·x = 0`, whose exact solution
 * is used for all three damping regimes. That matters: a keycap driven at ω = 190 rad/s
 * would diverge under semi-implicit Euler on a 30 ms frame, and the whole point of the
 * mechanism is that it stays believable when the tab stutters.
 */
export class Spring {
  value: number
  velocity: number
  target: number

  private omega: number
  private zeta: number

  constructor(options: SpringOptions = {}) {
    this.omega = Math.max(TINY, finite(options.omega ?? 40, 40))
    this.zeta = Math.max(0, finite(options.zeta ?? 1, 1))
    this.value = finite(options.value ?? 0, 0)
    this.velocity = finite(options.velocity ?? 0, 0)
    this.target = finite(options.target ?? this.value, this.value)
  }

  /** Retune mid-flight — used to give press and release different characters. */
  configure(options: Pick<SpringOptions, 'omega' | 'zeta'>): void {
    if (options.omega !== undefined) this.omega = Math.max(TINY, finite(options.omega, this.omega))
    if (options.zeta !== undefined) this.zeta = Math.max(0, finite(options.zeta, this.zeta))
  }

  /** Teleport: value, target and velocity all reset. */
  snap(value: number): void {
    this.value = value
    this.target = value
    this.velocity = 0
  }

  step(dt: number): number {
    if (!(dt > 0)) return this.value
    // Cap the step rather than sub-stepping: the solution is exact, so a long step is
    // accurate, it just skips motion the user could not have seen anyway.
    const h = Math.min(dt, 0.25)
    const w = this.omega
    const z = this.zeta
    const x0 = this.value - this.target
    const v0 = this.velocity

    let x: number
    let v: number

    if (z > 1 + 1e-4) {
      // Over-damped: two real roots.
      const root = w * Math.sqrt(z * z - 1)
      const r1 = -w * z + root
      const r2 = -w * z - root
      const denom = r1 - r2
      const c1 = (v0 - r2 * x0) / denom
      const c2 = x0 - c1
      const e1 = Math.exp(r1 * h)
      const e2 = Math.exp(r2 * h)
      x = c1 * e1 + c2 * e2
      v = c1 * r1 * e1 + c2 * r2 * e2
    } else if (z < 1 - 1e-4) {
      // Under-damped: this is where the overshoot lives.
      const wd = w * Math.sqrt(1 - z * z)
      const e = Math.exp(-z * w * h)
      const c = (v0 + z * w * x0) / wd
      const cs = Math.cos(wd * h)
      const sn = Math.sin(wd * h)
      x = e * (x0 * cs + c * sn)
      v = e * (-z * w * (x0 * cs + c * sn) + wd * (c * cs - x0 * sn))
    } else {
      // Critically damped: x(t) = (x0 + b·t)·e^(−ωt), b = v0 + ω·x0.
      const b = v0 + w * x0
      const e = Math.exp(-w * h)
      x = (x0 + b * h) * e
      v = (v0 - w * b * h) * e
    }

    this.value = this.target + x
    this.velocity = v
    return this.value
  }

  isSettled(tolerance = 1e-5): boolean {
    return Math.abs(this.value - this.target) <= tolerance && Math.abs(this.velocity) <= tolerance * 40
  }
}

// ---------------------------------------------------------------------------
// Keycap travel
// ---------------------------------------------------------------------------

/** Stroke of an MSX-era keycap, in metres (SPEC §8). */
export const KEYCAP_TRAVEL = 0.003

export interface KeycapTravelOptions {
  readonly travel?: number
  /** Attack: the finger wins instantly, so this is stiff and critically damped. */
  readonly pressOmega?: number
  readonly pressZeta?: number
  /** Return: the switch spring alone, lighter and slightly under-damped. */
  readonly releaseOmega?: number
  readonly releaseZeta?: number
  /** Energy kept when the stem hits the bottom-out stop. */
  readonly bottomRestitution?: number
  /** Energy kept when the cap slams back against its retention clip. */
  readonly topRestitution?: number
}

/**
 * One keycap's vertical stroke.
 *
 * The feel is carried by two things a linear lerp cannot produce: the press and release
 * use *different* springs (a finger is stiffer than a return spring), and both ends of
 * the stroke are hard stops with restitution, so the cap taps out at the bottom and
 * rebounds off its retention clip at the top instead of easing to a halt in mid-air.
 */
export class KeycapTravel {
  readonly maxTravel: number

  private readonly spring: Spring
  private readonly pressOmega: number
  private readonly pressZeta: number
  private readonly releaseOmega: number
  private readonly releaseZeta: number
  private readonly bottomRestitution: number
  private readonly topRestitution: number
  private held = false

  constructor(options: KeycapTravelOptions = {}) {
    this.maxTravel = Math.max(TINY, options.travel ?? KEYCAP_TRAVEL)
    this.pressOmega = options.pressOmega ?? 190
    this.pressZeta = options.pressZeta ?? 1
    this.releaseOmega = options.releaseOmega ?? 128
    this.releaseZeta = options.releaseZeta ?? 0.58
    this.bottomRestitution = clamp01(options.bottomRestitution ?? 0.1)
    this.topRestitution = clamp01(options.topRestitution ?? 0.32)
    this.spring = new Spring({ omega: this.releaseOmega, zeta: this.releaseZeta })
  }

  press(): void {
    if (this.held) return
    this.held = true
    this.spring.configure({ omega: this.pressOmega, zeta: this.pressZeta })
    this.spring.target = this.maxTravel
  }

  release(): void {
    if (!this.held) return
    this.held = false
    this.spring.configure({ omega: this.releaseOmega, zeta: this.releaseZeta })
    this.spring.target = 0
  }

  step(dt: number): number {
    this.spring.step(dt)

    if (this.spring.value > this.maxTravel) {
      this.spring.value = this.maxTravel
      if (this.spring.velocity > 0) this.spring.velocity *= -this.bottomRestitution
    } else if (this.spring.value < 0) {
      this.spring.value = 0
      if (this.spring.velocity < 0) this.spring.velocity *= -this.topRestitution
    }
    return this.spring.value
  }

  /** Current stroke, in metres. 0 = at rest, `maxTravel` = bottomed out. */
  get travel(): number {
    return this.spring.value
  }

  get down(): boolean {
    return this.held
  }

  get moving(): boolean {
    return !this.spring.isSettled(1e-6)
  }
}

// ---------------------------------------------------------------------------
// Cartridge insertion
// ---------------------------------------------------------------------------

export interface CartridgeInsertionOptions {
  /** Normalised position of the detent centre. Default 0.95 — it seats near the end. */
  readonly seat?: number
  /** Half-width of the detent well, in `u`. */
  readonly detentWidth?: number
  /**
   * Detent depth. Clamped so the well can always be escaped — see
   * {@link CartridgeInsertion} for why that clamp is not optional.
   */
  readonly detentStrength?: number
  /** Peak connector friction, in the same units as the drive force. */
  readonly friction?: number
  /** How hard the hand pushes toward the target. */
  readonly drive?: number
  readonly damping?: number
  /** Wobble oscillator frequency, rad/s. */
  readonly wobbleOmega?: number
  readonly wobbleZeta?: number
}

/**
 * The insertion axis of one cartridge.
 *
 * `u` runs 0 (nose touching the mouth) → 1 (fully home). Three forces act on it:
 *
 * 1. **Drive** — a spring toward the commanded end, i.e. the hand.
 * 2. **Friction** — near zero while the nose is still in free air, rising sharply once
 *    the 50 gold fingers engage, which is exactly where a real cartridge fights back.
 * 3. **Detent** — a Gaussian potential well at {@link CartridgeInsertionOptions.seat}.
 *    Crossing its lip is what produces the *click* of the connector seating; the same
 *    event dumps energy into the wobble oscillators.
 *
 * The result is asymmetric on purpose: pushing in is a shove-then-snap, pulling out
 * needs a tug to escape the well and then comes free.
 *
 * **The detent is clamped, and that clamp is load-bearing.** `−dU/du` for a Gaussian
 * well peaks at `2A·e^(−½)/√2·/w ≈ 0.858·A/w`, while the strongest pull the drive can
 * ever exert on a seated cartridge is `drive · seat`. Let the first exceed the second
 * and the cartridge is trapped: it seats, and no eject can ever free it again. The
 * constructor caps the depth at 60 % of the escape force so that is unrepresentable.
 */
export class CartridgeInsertion {
  private readonly seat: number
  private readonly detentWidth: number
  private readonly detentStrength: number
  private readonly seatThreshold: number
  private readonly friction: number
  private readonly drive: number
  private readonly damping: number

  private readonly wobbleX: Spring
  private readonly wobbleZ: Spring

  private position = 0
  private velocity = 0
  private goal = 0
  private wasSeated = false
  private seatedEvent = false

  constructor(options: CartridgeInsertionOptions = {}) {
    this.seat = clamp(options.seat ?? 0.95, 0.1, 1)
    this.detentWidth = Math.max(0.01, options.detentWidth ?? 0.085)
    this.friction = Math.max(0, options.friction ?? 3.2)
    this.drive = Math.max(TINY, options.drive ?? 26)
    this.damping = options.damping ?? 5.4

    // Peak of |−dU/du| for U = −A·exp(−s²) is 2A·(1/√2)·e^(−½)/w = 0.8578·A/w.
    const escape = 0.6 * (this.drive * this.seat - this.friction)
    const maxStrength = Math.max(TINY, (escape * this.detentWidth) / 0.8578)
    this.detentStrength = Math.min(options.detentStrength ?? 1.2, maxStrength)

    // Seated well before the bottom of the well, so a cartridge resting just short of
    // the centre does not chatter across the threshold.
    this.seatThreshold = this.seat - this.detentWidth * 0.5
    this.wobbleX = new Spring({ omega: options.wobbleOmega ?? 58, zeta: options.wobbleZeta ?? 0.13 })
    this.wobbleZ = new Spring({ omega: (options.wobbleOmega ?? 58) * 0.78, zeta: options.wobbleZeta ?? 0.13 })
  }

  /** Command the axis. `1` inserts, `0` ejects. */
  push(target: number): void {
    this.goal = clamp01(target)
  }

  /** Place the axis without animating — used to restore state. */
  snap(position: number): void {
    this.position = clamp01(position)
    this.goal = this.position
    this.velocity = 0
    this.wasSeated = this.position >= this.seatThreshold
    this.wobbleX.snap(0)
    this.wobbleZ.snap(0)
  }

  /** Kick the wobble directly, e.g. when the cartridge is first set down on the rails. */
  nudge(strength: number): void {
    this.wobbleX.velocity += strength
    this.wobbleZ.velocity -= strength * 0.62
  }

  step(dt: number): number {
    if (!(dt > 0)) return this.position
    const total = Math.min(dt, 0.1)
    // Sub-step: the detent is a stiff non-linearity and tunnelling straight through it
    // would silently delete the snap.
    const steps = Math.max(1, Math.ceil(total / 0.002))
    const h = total / steps

    for (let i = 0; i < steps; i++) {
      const u = this.position
      const driveForce = this.drive * (this.goal - u)

      // Friction ramps in over the second half of the stroke, where the PCB fingers are.
      const engagement = smoothstep(0.32, 0.78, u)
      const resistance = this.friction * engagement * Math.tanh(this.velocity * 24)

      // −dU/du for U(u) = −A·exp(−s²), s = (u − seat)/w.
      const s = (u - this.seat) / this.detentWidth
      const detent = (-2 * this.detentStrength * s * Math.exp(-s * s)) / this.detentWidth

      const acceleration = driveForce - resistance + detent - this.damping * this.velocity
      this.velocity += acceleration * h
      this.position += this.velocity * h

      if (this.position <= 0) {
        this.position = 0
        if (this.velocity < 0) this.velocity *= -0.15
      } else if (this.position >= 1) {
        this.position = 1
        if (this.velocity > 0) {
          // Bottomed out against the back of the bay: that thud shakes the shell.
          this.nudge(this.velocity * 0.9)
          this.velocity *= -0.12
        }
      }
    }

    const seated = this.position >= this.seatThreshold
    if (seated && !this.wasSeated) {
      this.seatedEvent = true
      this.nudge(Math.max(0.4, Math.abs(this.velocity) * 1.6))
    }
    this.wasSeated = seated

    this.wobbleX.step(total)
    this.wobbleZ.step(total)
    return this.position
  }

  /** 0 → at the mouth, 1 → fully home. */
  get u(): number {
    return this.position
  }

  get seated(): boolean {
    return this.position >= this.seatThreshold
  }

  get moving(): boolean {
    return Math.abs(this.velocity) > 1e-4 || Math.abs(this.goal - this.position) > 1e-4
  }

  /** Roll of the cartridge in its rails, radians. */
  get wobbleRoll(): number {
    return this.wobbleX.value * 0.02
  }

  /** Yaw of the cartridge in its rails, radians. */
  get wobbleYaw(): number {
    return this.wobbleZ.value * 0.014
  }

  /** True exactly once, on the frame the connector seats. */
  consumeSeated(): boolean {
    const value = this.seatedEvent
    this.seatedEvent = false
    return value
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------------------
// Dust-cover flap
// ---------------------------------------------------------------------------

export interface HingeFlapOptions {
  /** Distance from the hinge to the flap's centre of mass, metres. */
  readonly length?: number
  readonly gravity?: number
  /** Return-spring rate, 1/s². The XP-800's flaps are sprung shut. */
  readonly returnStiffness?: number
  readonly damping?: number
  /** Energy kept when the flap slaps against its closed stop. */
  readonly restitution?: number
  readonly minAngle?: number
  readonly maxAngle?: number
  /** Stiffness of the driven mode — this is a finger, so it is very stiff. */
  readonly driveOmega?: number
}

type FlapMode = 'free' | 'driven' | 'blocked'

/**
 * A top-hinged, spring-loaded dust cover.
 *
 * Free swing is a real pendulum — `α = −(3g / 2L)·sin θ` for a thin flap hinged at its
 * end — plus the return spring and viscous damping. `sin θ` rather than `θ` matters
 * here: at the 60° a cartridge holds the flap open, the small-angle approximation is
 * 15 % wrong and the flap falls too fast.
 *
 * The closed stop is a real collision with restitution, so the flap taps shut, rebounds
 * a couple of degrees, and settles — the detail that stops it reading as an animation.
 */
export class HingeFlap {
  private readonly length: number
  private readonly gravity: number
  private readonly returnStiffness: number
  private readonly dampingRate: number
  private readonly restitution: number
  private readonly minAngle: number
  private readonly maxAngle: number
  private readonly driveSpring: Spring

  private mode: FlapMode = 'free'
  private angleValue = 0
  private angularVelocity = 0
  private blockedAt = 0

  constructor(options: HingeFlapOptions = {}) {
    this.length = Math.max(0.005, options.length ?? 0.017)
    this.gravity = options.gravity ?? 9.81
    this.returnStiffness = options.returnStiffness ?? 130
    this.dampingRate = options.damping ?? 5.5
    this.restitution = clamp01(options.restitution ?? 0.26)
    this.minAngle = options.minAngle ?? 0
    this.maxAngle = options.maxAngle ?? 1.25
    this.driveSpring = new Spring({ omega: options.driveOmega ?? 46, zeta: 1 })
  }

  /** Drive the flap to an angle — a finger pushing it, or a cartridge riding it open. */
  drive(angle: number): void {
    this.mode = 'driven'
    this.driveSpring.value = this.angleValue
    this.driveSpring.velocity = this.angularVelocity
    this.driveSpring.target = clamp(angle, this.minAngle, this.maxAngle)
  }

  /** Pin the flap open — a seated cartridge holds it there with no give at all. */
  block(angle: number): void {
    this.mode = 'blocked'
    this.blockedAt = clamp(angle, this.minAngle, this.maxAngle)
  }

  /** Hand the flap back to gravity and its return spring. */
  release(): void {
    if (this.mode === 'driven') {
      this.angleValue = this.driveSpring.value
      this.angularVelocity = this.driveSpring.velocity
    }
    this.mode = 'free'
  }

  step(dt: number): number {
    if (!(dt > 0)) return this.angle

    if (this.mode === 'blocked') {
      this.angleValue = this.blockedAt
      this.angularVelocity = 0
      return this.angleValue
    }

    if (this.mode === 'driven') {
      this.driveSpring.step(dt)
      this.angleValue = clamp(this.driveSpring.value, this.minAngle, this.maxAngle)
      this.angularVelocity = this.driveSpring.velocity
      return this.angleValue
    }

    const total = Math.min(dt, 0.1)
    const steps = Math.max(1, Math.ceil(total / 0.004))
    const h = total / steps

    for (let i = 0; i < steps; i++) {
      const gravityTorque = -((3 * this.gravity) / (2 * this.length)) * Math.sin(this.angleValue)
      const springTorque = -this.returnStiffness * this.angleValue
      const dampingTorque = -this.dampingRate * this.angularVelocity
      this.angularVelocity += (gravityTorque + springTorque + dampingTorque) * h
      this.angleValue += this.angularVelocity * h

      if (this.angleValue <= this.minAngle) {
        this.angleValue = this.minAngle
        if (this.angularVelocity < 0) {
          this.angularVelocity *= -this.restitution
          // Below a couple of degrees per second the rebound is invisible; killing it
          // stops the flap from buzzing forever at sub-pixel amplitude.
          if (Math.abs(this.angularVelocity) < 0.12) this.angularVelocity = 0
        }
      } else if (this.angleValue >= this.maxAngle) {
        this.angleValue = this.maxAngle
        if (this.angularVelocity > 0) this.angularVelocity *= -this.restitution
      }
    }
    return this.angleValue
  }

  get angle(): number {
    return this.mode === 'driven' ? this.driveSpring.value : this.angleValue
  }

  get moving(): boolean {
    if (this.mode === 'blocked') return false
    if (this.mode === 'driven') return !this.driveSpring.isSettled(1e-4)
    return Math.abs(this.angularVelocity) > 1e-3 || Math.abs(this.angleValue - this.minAngle) > 1e-4
  }
}

// ---------------------------------------------------------------------------
// Catenary
// ---------------------------------------------------------------------------

/**
 * Sample the catenary hanging between `a` and `b` with `slack` extra arc length
 * (`0.1` = the cord is 10 % longer than the straight line between its ends).
 *
 * A hanging cable is `y = c·cosh(x/c)`, not a parabola and certainly not a Bézier. The
 * shape parameter `c` is found from `√(S² − v²) = 2c·sinh(h / 2c)` — no closed form, so
 * Newton on `sinh(z)/z` with a bisection fallback, which converges in three or four
 * iterations for every slack value we care about.
 *
 * Returned points are in world space, in the vertical plane containing `a` and `b`.
 */
export function catenary(
  a: THREE.Vector3,
  b: THREE.Vector3,
  slack = 0.12,
  samples = 24,
): THREE.Vector3[] {
  const count = Math.max(2, Math.floor(samples))
  const out: THREE.Vector3[] = []

  const horizontal = new THREE.Vector3(b.x - a.x, 0, b.z - a.z)
  const h = horizontal.length()
  const v = b.y - a.y
  const chord = Math.hypot(h, v)
  const arc = chord * (1 + Math.max(0, slack))

  // Degenerate: the ends are stacked vertically, or there is no slack to hang.
  if (h < 1e-5 || arc <= chord + 1e-6) {
    for (let i = 0; i < count; i++) out.push(a.clone().lerp(b, i / (count - 1)))
    return out
  }

  const axis = horizontal.divideScalar(h)
  const targetRatio = Math.sqrt(Math.max(0, arc * arc - v * v)) / h

  const z = solveSinhOverZ(targetRatio)
  const c = h / (2 * z)
  // Horizontal offset of the low point from `a`.
  const offset = h / 2 - c * Math.atanh(clamp(v / arc, -0.999999, 0.999999))

  for (let i = 0; i < count; i++) {
    const t = i / (count - 1)
    const x = t * h
    const y = c * (Math.cosh((x - offset) / c) - Math.cosh(offset / c))
    out.push(new THREE.Vector3(a.x + axis.x * x, a.y + y, a.z + axis.z * x))
  }
  // Nail the endpoints: the analytic form is exact, floating point is not.
  out[0] = a.clone()
  out[count - 1] = b.clone()
  return out
}

/** Solve `sinh(z)/z = ratio` for `z > 0`. `ratio` must be ≥ 1. */
function solveSinhOverZ(ratio: number): number {
  if (!(ratio > 1)) return TINY
  // Bracket, then Newton. `sinh(z)/z` tends to 1 at zero and is monotonic for z > 0,
  // so the lower bound must stay at zero. Using `hi / 2` here misses the root whenever
  // the cable has little slack (ratio < sinh(0.5) / 0.5) and fabricates a deep sag.
  let hi = 1
  while (Math.sinh(hi) / hi < ratio && hi < 512) hi *= 2
  let lo = 0
  let z = (lo + hi) / 2

  for (let i = 0; i < 40; i++) {
    const f = Math.sinh(z) / z - ratio
    if (Math.abs(f) < 1e-10) break
    if (f > 0) hi = z
    else lo = z
    const derivative = (Math.cosh(z) * z - Math.sinh(z)) / (z * z)
    const next = derivative > TINY ? z - f / derivative : (lo + hi) / 2
    z = next > lo && next < hi ? next : (lo + hi) / 2
  }
  return Math.max(TINY, z)
}

// ---------------------------------------------------------------------------
// Cable
// ---------------------------------------------------------------------------

export interface CableOptions {
  /** Pendulum length used to derive the restoring rate, metres. */
  readonly span?: number
  readonly gravity?: number
  /** Viscous damping, 1/s. */
  readonly damping?: number
  /** Position-based constraint iterations per step. */
  readonly iterations?: number
  /** Motion below this (metres) counts as asleep. */
  readonly sleepEpsilon?: number
  /** Indices pinned to their rest position. Defaults to both ends. */
  readonly pinned?: readonly number[]
}

/**
 * An inextensible cable that solves **deviations from a rest curve**.
 *
 * The rest curve is the gravity solution — either an authored sag or {@link catenary} —
 * so at rest the cable is exactly where the artist put it and the still frame can never
 * be made worse. What this adds is the transient: disturb the machine and the lead swings
 * at its real pendulum frequency `√(g/L)`, stretches nowhere thanks to the distance
 * constraints, and settles back. Verlet + position constraints, sleeping when quiet, so
 * an idle scene pays nothing.
 */
export class Cable {
  readonly points: THREE.Vector3[]
  readonly rest: readonly THREE.Vector3[]

  private readonly previous: THREE.Vector3[]
  private readonly lengths: number[]
  private readonly pinned: ReadonlySet<number>
  private readonly stiffness: number
  private readonly dampingRate: number
  private readonly iterations: number
  private readonly sleepEpsilon: number
  private awakeValue = false
  private readonly scratch = new THREE.Vector3()

  constructor(rest: readonly THREE.Vector3[], options: CableOptions = {}) {
    this.rest = rest.map((p) => p.clone())
    this.points = rest.map((p) => p.clone())
    this.previous = rest.map((p) => p.clone())

    this.lengths = []
    for (let i = 1; i < this.rest.length; i++) {
      const a = this.rest[i - 1]
      const b = this.rest[i]
      this.lengths.push(a && b ? a.distanceTo(b) : 0)
    }

    const gravity = options.gravity ?? 9.81
    const span = Math.max(0.02, options.span ?? this.estimateSpan())
    // Pendulum frequency of the free span: ω² = g/L. This is what makes a 15 cm
    // keyboard lead swing at ~1.3 Hz instead of at whatever a tuned lerp felt like.
    this.stiffness = gravity / span
    this.dampingRate = options.damping ?? 2.4
    this.iterations = Math.max(1, options.iterations ?? 4)
    this.sleepEpsilon = options.sleepEpsilon ?? 2e-5

    const last = this.points.length - 1
    this.pinned = new Set(options.pinned ?? (last > 0 ? [0, last] : [0]))
  }

  private estimateSpan(): number {
    let total = 0
    for (const length of this.lengths) total += length
    return total
  }

  /** Inject velocity, tapered around `centre` (0..1 along the cable). */
  disturb(impulse: THREE.Vector3, centre = 0.5, width = 0.45): void {
    const n = this.points.length
    if (n === 0) return
    for (let i = 0; i < n; i++) {
      if (this.pinned.has(i)) continue
      const t = n > 1 ? i / (n - 1) : 0
      const spread = (t - centre) / Math.max(0.02, width)
      const falloff = Math.exp(-(spread * spread))
      const previous = this.previous[i]
      if (!previous) continue
      previous.addScaledVector(impulse, -falloff)
    }
    this.awakeValue = true
  }

  /** Advance the simulation. Returns `true` while the cable is still moving. */
  step(dt: number): boolean {
    if (!this.awakeValue || !(dt > 0)) return false
    const h = Math.min(dt, 1 / 30)
    const drag = Math.exp(-this.dampingRate * h)
    let maxMotion = 0

    for (let i = 0; i < this.points.length; i++) {
      const point = this.points[i]
      const previous = this.previous[i]
      const rest = this.rest[i]
      if (!point || !previous || !rest) continue
      if (this.pinned.has(i)) {
        point.copy(rest)
        previous.copy(rest)
        continue
      }
      // Verlet with damped inertia, pulled toward the rest curve.
      this.scratch.subVectors(point, previous).multiplyScalar(drag)
      previous.copy(point)
      point.add(this.scratch)
      point.addScaledVector(this.scratch.subVectors(rest, point), this.stiffness * h * h)
      maxMotion = Math.max(maxMotion, point.distanceTo(previous))
    }

    for (let iteration = 0; iteration < this.iterations; iteration++) this.satisfyLengths()

    if (maxMotion < this.sleepEpsilon) {
      this.sleep()
      return false
    }
    return true
  }

  private satisfyLengths(): void {
    for (let i = 1; i < this.points.length; i++) {
      const a = this.points[i - 1]
      const b = this.points[i]
      const target = this.lengths[i - 1]
      if (!a || !b || target === undefined || target <= TINY) continue
      this.scratch.subVectors(b, a)
      const current = this.scratch.length()
      if (current <= TINY) continue
      const correction = (current - target) / current
      const aFixed = this.pinned.has(i - 1)
      const bFixed = this.pinned.has(i)
      if (aFixed && bFixed) continue
      if (aFixed) b.addScaledVector(this.scratch, -correction)
      else if (bFixed) a.addScaledVector(this.scratch, correction)
      else {
        a.addScaledVector(this.scratch, correction * 0.5)
        b.addScaledVector(this.scratch, -correction * 0.5)
      }
    }
  }

  private sleep(): void {
    for (let i = 0; i < this.points.length; i++) {
      const point = this.points[i]
      const previous = this.previous[i]
      const rest = this.rest[i]
      if (!point || !previous || !rest) continue
      point.copy(rest)
      previous.copy(rest)
    }
    this.awakeValue = false
  }

  get awake(): boolean {
    return this.awakeValue
  }
}

// ---------------------------------------------------------------------------
// Tube skinning
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Binds a {@link Cable} to a mesh built from `THREE.TubeGeometry`.
 *
 * The rings of a tube are laid out `(tubularSegments + 1) × (radialSegments + 1)`, so
 * each ring's centre can be recovered by averaging it and the whole ring translated by
 * the cable's displacement. Translating rather than re-sweeping is deliberate: for the
 * millimetre-scale motion this produces, a rigid ring offset is visually identical to a
 * full re-frame, keeps the baked normals and UVs valid, and cannot introduce a twist
 * artefact if the frames disagree.
 *
 * Returns `null` for any geometry that is not a tube — a silent, safe no-op.
 */
export function bindTubeToCable(mesh: THREE.Mesh, options: CableOptions = {}): TubeCable | null {
  const geometry = mesh.geometry
  const parameters = (geometry as { parameters?: unknown }).parameters
  if (!isRecord(parameters)) return null
  const tubular = parameters['tubularSegments']
  const radial = parameters['radialSegments']
  if (typeof tubular !== 'number' || typeof radial !== 'number') return null

  const attribute = geometry.getAttribute('position')
  if (!(attribute instanceof THREE.BufferAttribute)) return null

  const rings = Math.floor(tubular) + 1
  const perRing = Math.floor(radial) + 1
  if (rings < 2 || perRing < 2 || attribute.count !== rings * perRing) return null

  const centres: THREE.Vector3[] = []
  for (let i = 0; i < rings; i++) {
    const centre = new THREE.Vector3()
    for (let j = 0; j < perRing; j++) {
      centre.x += attribute.getX(i * perRing + j)
      centre.y += attribute.getY(i * perRing + j)
      centre.z += attribute.getZ(i * perRing + j)
    }
    centres.push(centre.divideScalar(perRing))
  }

  return new TubeCable(mesh, attribute, rings, perRing, centres, options)
}

/** A cable simulation wired to the vertices of a tube mesh. See {@link bindTubeToCable}. */
export class TubeCable {
  readonly cable: Cable

  private readonly mesh: THREE.Mesh
  private readonly attribute: THREE.BufferAttribute
  private readonly rings: number
  private readonly perRing: number
  private readonly base: Float32Array
  private dirty = false

  constructor(
    mesh: THREE.Mesh,
    attribute: THREE.BufferAttribute,
    rings: number,
    perRing: number,
    centres: readonly THREE.Vector3[],
    options: CableOptions,
  ) {
    this.mesh = mesh
    this.attribute = attribute
    this.rings = rings
    this.perRing = perRing
    this.base = Float32Array.from(attribute.array)
    this.cable = new Cable(centres, options)
  }

  /** Shake the cable. `impulse` is in the mesh's local space. */
  disturb(impulse: THREE.Vector3, centre = 0.5, width = 0.45): void {
    this.cable.disturb(impulse, centre, width)
  }

  /** Advance and rewrite the tube. Returns `true` on frames that wrote geometry. */
  step(dt: number): boolean {
    const awake = this.cable.step(dt)
    if (!awake && !this.dirty) return false

    const array = this.attribute.array as Float32Array
    for (let i = 0; i < this.rings; i++) {
      const point = this.cable.points[i]
      const rest = this.cable.rest[i]
      if (!point || !rest) continue
      const dx = point.x - rest.x
      const dy = point.y - rest.y
      const dz = point.z - rest.z
      for (let j = 0; j < this.perRing; j++) {
        const index = (i * this.perRing + j) * 3
        array[index] = (this.base[index] ?? 0) + dx
        array[index + 1] = (this.base[index + 1] ?? 0) + dy
        array[index + 2] = (this.base[index + 2] ?? 0) + dz
      }
    }
    this.attribute.needsUpdate = true
    this.mesh.geometry.computeBoundingSphere()
    this.dirty = awake
    return true
  }
}
