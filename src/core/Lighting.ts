import * as THREE from 'three'
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js'
import type { ModuleContext, PowerState, SceneModule } from './types.ts'

/**
 * Studio lighting rig — SPEC §6.
 *
 * A photographic set floating in a void, not a lit room. The rig is built the way a
 * stills photographer builds one, and every source has exactly one job:
 *
 *  1. **Key** — a 0.8 × 0.4 m RectAreaLight softbox, above the keyboard's front-left,
 *     4500 K. Its proximity keeps the keyboard legible while letting the console's
 *     graphite lid fall darker. SPEC §6 records the clean-surface capture measurements.
 *  2. **Key shadow** — a DirectionalLight co-directional with the key. RectAreaLight
 *     cannot cast, so this supplies the cast shadow at a subordinate intensity.
 *  3. **Fill** — a second RectAreaLight at ~1/10 the key, opposite side, 6000 K. Opens
 *     the right flank without touching the modelling.
 *  4. **Rim** and **Kicker** — two thin strips (0.032 m and 0.05 m tall). A strip is what
 *     draws a crisp specular line along the 5.5 mm case fillet; a broad soft source just lifts
 *     the whole plane and the silhouette dissolves. `rim` sits behind-left for the 3/4
 *     views, `kicker` low at front-left for the reverse views (and doubles as the
 *     bounce card that keeps the fascia off black).
 *  5. **Screen** — the CRT face as a real emitter, ramped by the power-on sequence via
 *     {@link LightingRig.setScreenLight}.
 *
 * The IBL is deliberately *quiet*. An environment strong enough to be the base light is
 * also strong enough to lift every shadow, desaturate every accent colour and replace
 * the key's rectangle with a round blob — the three failure modes that read instantly as
 * CG. It is here for reflections (glass, metal, the sheen on the case), not for exposure.
 *
 * The void itself is not a flat clamp either: a large gradient shell gives the black a
 * *toe* (3–8/255 with a real falloff) instead of a floor of clipped zeros, and the desk
 * fades into the exact same function so the horizon has no seam.
 *
 * Nothing is downloaded: the environment map is rendered from a tiny procedural scene of
 * emissive softbox quads inside a gradient shell, then convolved by PMREMGenerator.
 */

// ---------------------------------------------------------------------------
// Colour temperature
// ---------------------------------------------------------------------------

/**
 * Convert a correlated colour temperature to a linear-sRGB colour.
 *
 * Chromaticity comes from the analytic approximation of the Planckian locus
 * (Kim et al., "Design of Advanced Color Temperature Control System for HDTV
 * Applications", 2002), which tracks CIE 1931 xy to within ~0.00005 over
 * 1667–25000 K. That xy is lifted to XYZ at unit luminance, converted to linear
 * sRGB with the D65 primaries matrix, negative lobes clipped, and normalised so
 * the brightest channel is 1 — brightness belongs to `light.intensity`, not here.
 *
 * @param kelvin Colour temperature in K. Clamped to [1667, 25000].
 * @param target Optional colour to write into, avoiding an allocation.
 */
export function kelvinToRGB(kelvin: number, target?: THREE.Color): THREE.Color {
  const out = target ?? new THREE.Color()
  const t = Math.min(25000, Math.max(1667, kelvin))

  // --- Planckian locus: CCT -> CIE 1931 x
  const invT = 1 / t
  const invT2 = invT * invT
  const invT3 = invT2 * invT

  const x =
    t < 4000
      ? -0.2661239e9 * invT3 - 0.2343589e6 * invT2 + 0.8776956e3 * invT + 0.17991
      : -3.0258469e9 * invT3 + 2.1070379e6 * invT2 + 0.2226347e3 * invT + 0.24039

  // --- ...and x -> y, piecewise over three CCT bands
  const x2 = x * x
  const x3 = x2 * x
  let y: number
  if (t < 2222) {
    y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
  } else if (t < 4000) {
    y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
  } else {
    y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483
  }

  // --- xyY (Y = 1) -> XYZ
  const bigY = 1
  const bigX = (x / y) * bigY
  const bigZ = ((1 - x - y) / y) * bigY

  // --- XYZ -> linear sRGB (IEC 61966-2-1, D65)
  let r = 3.2404542 * bigX - 1.5371385 * bigY - 0.4985314 * bigZ
  let g = -0.969266 * bigX + 1.8760108 * bigY + 0.041556 * bigZ
  let b = 0.0556434 * bigX - 0.2040259 * bigY + 1.0572252 * bigZ

  // Clip the out-of-gamut lobes (deep reds below ~2000 K leave sRGB).
  r = Math.max(0, r)
  g = Math.max(0, g)
  b = Math.max(0, b)

  const peak = Math.max(r, g, b)
  if (peak > 0) {
    r /= peak
    g /= peak
    b /= peak
  }

  // Lights are shaded in the working (linear) space; write linear values directly
  // so no sRGB decode is applied on top.
  return out.setRGB(r, g, b, THREE.LinearSRGBColorSpace)
}

const _wbReference = new THREE.Color()

/**
 * Colour of a light at `kelvin`, white-balanced against `whiteKelvin`.
 *
 * A camera white-balances to *some* illuminant, and the choice is an artistic one. Set
 * the reference above the key and the frame keeps a deliberate warm cast in the key and
 * a cool cast in the fill — which is the entire point of a 4500 K key against a 6500 K
 * fill. Set it *at* the key and the separation collapses to neutral grey, which is how a
 * period machine ends up looking like a 1998 beige box.
 *
 * The adaptation is von Kries (per-channel ratio against the reference illuminant). The
 * result is normalised to Rec. 709 luminance 1, not to peak 1, so `intensity` means the
 * same photometric level at every temperature. Individual channels may exceed 1; that is
 * intentional and three.js handles it.
 */
export function balancedLightColour(
  kelvin: number,
  whiteKelvin: number,
  target?: THREE.Color,
): THREE.Color {
  const out = kelvinToRGB(kelvin, target)
  if (!(whiteKelvin > 0)) return out

  kelvinToRGB(whiteKelvin, _wbReference)
  const eps = 1e-6
  let r = out.r / Math.max(eps, _wbReference.r)
  let g = out.g / Math.max(eps, _wbReference.g)
  let b = out.b / Math.max(eps, _wbReference.b)

  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (luma > eps) {
    r /= luma
    g /= luma
    b /= luma
  }
  return out.setRGB(r, g, b, THREE.LinearSRGBColorSpace)
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/**
 * Scene white point. Above the key temperature so the 4500 K key reads warm while
 * the 6000 K fill reads cool, preserving the separation requested in SPEC §6.
 */
const DEFAULT_WHITE_BALANCE = 5150

/** Colour temperatures, kelvin. SPEC §6. */
const KELVIN = {
  key: 4500,
  fill: 6000,
  /** Rim/kicker: near the white point, so the edge line reads as light, not as tint. */
  rim: 5400,
  kicker: 4800,
  /** The IBL is neutral daylight — it must not push the frame warm or cool on its own. */
  env: 5600,
  envFill: 6500,
} as const

/**
 * Base intensities before `exposureScale`. RectAreaLight is in nits and
 * DirectionalLight in lux; their numeric intensities are not an energy ratio.
 * The directional contribution is deliberately small: unlike the nearby area key,
 * it has no distance falloff and otherwise lifts the console relative to the keyboard.
 */
const BASE = {
  key: 10.6,
  keyShadow: 1.0,
  fill: 1.05,
  /**
   * Thin strip behind-left. Small solid angle limits diffuse spill; high radiance
   * keeps its specular reflection visible along the case fillet.
   */
  rim: 280,
  /** Thin strip low front-left. Rims the reverse views and lifts the fascia off black. */
  kicker: 5.3,
  /**
   * Full-brightness CRT spill. `setScreenLight` scales this. Deliberately subordinate
   * to the key: a 14" tube throws a legible blue-green wash over the keyboard and desk,
   * not a second key light.
   */
  screen: 4.5,
} as const

/** Default CRT phosphor spill — blue-green, the MSX/composite monitor look. */
const SCREEN_PHOSPHOR = 0x6ad3e0
/** Colour of the spill at the very start of the warm-up, before the beam is up. */
const SCREEN_COLD = 0x4a7f86

/** Metres. Half-extent of the directional shadow camera around the origin. */
const DEFAULT_SHADOW_EXTENT = 0.85

// ---------------------------------------------------------------------------
// The void
// ---------------------------------------------------------------------------

/**
 * Radiance of the studio void, as a function of view direction.
 *
 * Shared verbatim between the backdrop shell and the desk's outer fade, so the two meet
 * with no seam whatever: for any screen pixel both evaluate the *same* view ray.
 *
 * The numbers are chosen against the tone curve, not by eye: AgX at exposure 1 maps
 * linear 0.0036 → ~3/255 and linear 0.0075 → ~7/255. That is the toe the image needs.
 * A flat clear colour instead lands every background pixel on the same clipped value,
 * which is what "23.9 % of the frame at ≤ 2/255" looks like.
 */
export const VOID_GRADIENT_GLSL = /* glsl */ `
uniform vec3 uVoidLow;
uniform vec3 uVoidHorizon;
uniform vec3 uVoidHigh;
uniform vec3 uVoidSpill;
uniform vec3 uVoidSpillDir;

vec3 msxVoidRadiance( vec3 rayDirection ) {
  vec3 d = normalize( rayDirection );
  float h = clamp( d.y, -1.0, 1.0 );
  vec3 base = ( h < 0.0 )
    ? mix( uVoidHorizon, uVoidLow, smoothstep( 0.0, -0.5, h ) )
    : mix( uVoidHorizon, uVoidHigh, smoothstep( 0.0, 0.55, h ) );

  // Broad, soft pool of key spill on the seamless — the only thing that keeps the
  // backdrop from being a uniform field.
  vec3 flat3 = vec3( d.x, 0.0, d.z );
  float len = max( length( flat3 ), 1e-4 );
  float lobe = max( 0.0, dot( flat3 / len, uVoidSpillDir ) );
  lobe = pow( lobe, 2.0 ) * exp( -abs( h ) * 2.6 );
  return base + uVoidSpill * lobe;
}
`

/** Linear radiances of the void. See {@link VOID_GRADIENT_GLSL}. */
const VOID = {
  low: new THREE.Color().setRGB(0.0019, 0.0019, 0.0021, THREE.LinearSRGBColorSpace),
  horizon: new THREE.Color().setRGB(0.0039, 0.0038, 0.004, THREE.LinearSRGBColorSpace),
  high: new THREE.Color().setRGB(0.0014, 0.0015, 0.0018, THREE.LinearSRGBColorSpace),
  spill: new THREE.Color().setRGB(0.0046, 0.0042, 0.0035, THREE.LinearSRGBColorSpace),
} as const

/**
 * Shared uniform block for {@link VOID_GRADIENT_GLSL}. One object, referenced by both the
 * backdrop material and the desk material, so they can never drift apart.
 */
export const voidUniforms = {
  uVoidLow: { value: VOID.low.clone() },
  uVoidHorizon: { value: VOID.horizon.clone() },
  uVoidHigh: { value: VOID.high.clone() },
  uVoidSpill: { value: VOID.spill.clone() },
  /** Horizontal direction the key throws towards. Set at build time from the key. */
  uVoidSpillDir: { value: new THREE.Vector3(0.64, 0, -0.77) },
} as const

const BACKDROP_VERT = /* glsl */ `
  varying vec3 vRay;
  void main() {
    vRay = ( modelMatrix * vec4( position, 1.0 ) ).xyz - cameraPosition;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`

const BACKDROP_FRAG = /* glsl */ `
  ${VOID_GRADIENT_GLSL}
  varying vec3 vRay;
  void main() {
    gl_FragColor = vec4( msxVoidRadiance( vRay ), 1.0 );
  }
`

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Plain positional literal so callers do not have to allocate a Vector3. */
export interface Point3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** Direct handles on every light, for debug UI or per-scene fine tuning. */
export interface LightingLights {
  /** Dominant 1.2 × 0.8 m softbox, upper front-left, 4500 K. No shadow (RectAreaLight). */
  readonly key: THREE.RectAreaLight
  /** Co-directional shadow caster for the key. */
  readonly keyShadow: THREE.DirectionalLight
  /** Cool fill, opposite side, ~1/6 of the key. */
  readonly fill: THREE.RectAreaLight
  /** Thin bright strip behind-left — the silhouette separator for the 3/4 views. */
  readonly rim: THREE.RectAreaLight
  /** Thin bright strip low front-left — reverse-view rim, and the fascia's bounce card. */
  readonly kicker: THREE.RectAreaLight
  /** The CRT face as a real emitter. Driven by `setScreenLight`. */
  readonly screen: THREE.RectAreaLight
}

export interface LightingOptions {
  /** Multiplies every light intensity. Default 1. */
  readonly exposureScale?: number
  /**
   * `scene.environmentIntensity` for the procedural IBL. Default 0.11 — the IBL is for
   * reflections, not exposure. Raising it flattens the key and desaturates the accents.
   */
  readonly environmentIntensity?: number
  /**
   * Scene white point in kelvin. Every source is von Kries-adapted against it, so this
   * temperature renders neutral. Default 5150, which leaves the 4500 K key visibly warm.
   * Pass 0 to disable and get raw blackbody colours.
   */
  readonly whiteBalanceKelvin?: number
  /** Enable shadow casting. Default true. */
  readonly shadows?: boolean
  /** Shadow map resolution for the key. Default 2048. */
  readonly shadowMapSize?: number
  /** Half-extent (m) of the key's ortho shadow frustum around the origin. Default 0.85. */
  readonly shadowExtent?: number
  /**
   * Apply tone mapping / shadow-map settings to the renderer, but only where they are
   * still at three.js defaults, so an Engine that configures them first always wins.
   * Default true.
   */
  readonly configureRenderer?: boolean
  /** Override the CRT phosphor spill colour. */
  readonly screenColour?: THREE.ColorRepresentation
  /** Seconds. Time constant of the screen-light smoothing. Default 0.09. */
  readonly screenResponse?: number
  /** Draw the gradient backdrop shell. Default true. */
  readonly backdrop?: boolean
}

/**
 * The lighting module. It *is* a {@link SceneModule} — hand it to the Engine like any
 * other module — and additionally exposes the runtime controls the power-on sequence
 * and the CRT need.
 */
export interface LightingRig extends SceneModule {
  /** Null until `build()` has run. */
  readonly group: THREE.Group | null
  /** Null until `build()` has run. */
  readonly lights: LightingLights | null
  /** PMREM-filtered procedural environment. Null until `build()` has run. */
  readonly environmentTexture: THREE.Texture | null

  /**
   * Set the CRT spill. `intensity` is a 0..1 fraction of full screen brightness;
   * values above 1 are allowed for a blown-out white frame. The change is smoothed
   * over ~`screenResponse` seconds, so even a step input ramps rather than snaps.
   */
  setScreenLight(intensity: number, colour?: THREE.ColorRepresentation): void

  /**
   * Convenience wrapper for the power sequence: maps {@link PowerState.warmth} onto
   * the spill with a CRT-like non-linear ramp and a cold→phosphor colour shift.
   */
  applyPowerState(state: PowerState): void

  /** Park the screen emitter on the real CRT face. Call this from the CRT module. */
  setScreenLightTransform(position: Point3, target: Point3): void

  /** Match the emitter to the actual visible screen area, in metres. */
  setScreenLightSize(width: number, height: number): void

  /** Runtime IBL trim. */
  setEnvironmentIntensity(value: number): void

  /** Rescale every light at once, e.g. when the Engine changes tone-map exposure. */
  setExposureScale(scale: number): void
}

// ---------------------------------------------------------------------------
// Procedural studio environment
// ---------------------------------------------------------------------------

interface SoftboxSpec {
  readonly width: number
  readonly height: number
  readonly position: Point3
  readonly kelvin: number
  /** Linear radiance multiplier. Written straight into a half-float target. */
  readonly radiance: number
  /** 0..0.5 — fraction of the panel edge that fades out, mimicking diffusion cloth. */
  readonly feather: number
}

/**
 * Broad studio panels supply the glass and metal reflections. The local key has
 * finite-distance falloff that this distant environment cannot reproduce.
 */
const ENV_SOFTBOXES: readonly SoftboxSpec[] = [
  // Key softbox, upper front-left. High radiance, modest solid angle: it is
  // here to be *seen* in glass and metal, not to light the scene.
  {
    width: 3.0,
    height: 2.0,
    position: { x: -3.02, y: 3.53, z: 3.6 },
    kelvin: KELVIN.env,
    radiance: 5.4,
    feather: 0.2,
  },
  // Fill panel, front-right, cooler and much weaker.
  {
    width: 2.8,
    height: 2.0,
    position: { x: 4.0, y: 1.6, z: 2.8 },
    kelvin: KELVIN.envFill,
    radiance: 0.5,
    feather: 0.3,
  },
  // Overhead rim strip, behind-left. Narrow, so it stays a *line* after convolution.
  {
    width: 4.4,
    height: 0.36,
    position: { x: -2.6, y: 2.4, z: -2.4 },
    kelvin: KELVIN.rim,
    radiance: 2.6,
    feather: 0.3,
  },
]

/**
 * Vertical gradient of the shell the set floats in. Deliberately an order of magnitude
 * below the previous value: this term is the IBL's *ambient*, and ambient is what lifts
 * shadows, greys accent colours and kills the key's modelling.
 */
const ENV_SHELL = {
  /** Straight down. */
  floor: new THREE.Color().setRGB(0.0026, 0.0025, 0.0025, THREE.LinearSRGBColorSpace),
  /** Horizon — the brightest part of the shell, as in a seamless sweep. */
  horizon: new THREE.Color().setRGB(0.0088, 0.0087, 0.0092, THREE.LinearSRGBColorSpace),
  /** Straight up, slightly cool. */
  zenith: new THREE.Color().setRGB(0.0034, 0.0036, 0.0042, THREE.LinearSRGBColorSpace),
} as const

const SHELL_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize( position );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`

const SHELL_FRAG = /* glsl */ `
  uniform vec3 uFloor;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  varying vec3 vDir;
  void main() {
    float h = clamp( vDir.y, -1.0, 1.0 );
    // Two smooth ramps meeting at the horizon; a soft knee keeps it seamless.
    vec3 below = mix( uFloor, uHorizon, smoothstep( -0.85, 0.0, h ) );
    vec3 above = mix( uHorizon, uZenith, smoothstep( 0.0, 0.75, h ) );
    vec3 c = h < 0.0 ? below : above;
    gl_FragColor = vec4( c, 1.0 );
  }
`

const PANEL_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`

const PANEL_FRAG = /* glsl */ `
  uniform vec3 uColour;
  uniform float uRadiance;
  uniform float uFeather;
  varying vec2 vUv;
  void main() {
    // Feathered rectangle: real diffusion cloth does not have a razor edge, and a
    // razor edge is exactly what makes a CG reflection read as CG.
    float f = max( uFeather, 1e-4 );
    float m = smoothstep( 0.0, f, vUv.x ) * smoothstep( 0.0, f, 1.0 - vUv.x )
            * smoothstep( 0.0, f, vUv.y ) * smoothstep( 0.0, f, 1.0 - vUv.y );
    gl_FragColor = vec4( uColour * uRadiance * m, 1.0 );
  }
`

interface DisposableEnvScene {
  readonly scene: THREE.Scene
  dispose(): void
}

function buildEnvironmentScene(whiteBalance: number): DisposableEnvScene {
  const scene = new THREE.Scene()
  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []

  // --- The void itself: an inverted box carrying a vertical gradient.
  const shellGeo = new THREE.BoxGeometry(24, 24, 24)
  const shellMat = new THREE.ShaderMaterial({
    uniforms: {
      uFloor: { value: ENV_SHELL.floor.clone() },
      uHorizon: { value: ENV_SHELL.horizon.clone() },
      uZenith: { value: ENV_SHELL.zenith.clone() },
    },
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    side: THREE.BackSide,
    // PMREMGenerator packs all six cube faces into one render target without clearing
    // depth between them. Ordering these by hand removes any dependence on the depth
    // buffer's state: the shell first, the panels over it. They never overlap.
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  })
  const shell = new THREE.Mesh(shellGeo, shellMat)
  shell.renderOrder = -1
  scene.add(shell)
  geometries.push(shellGeo)
  materials.push(shellMat)

  // --- The softboxes. These become the specular highlights on the case plastic.
  const colour = new THREE.Color()
  for (const spec of ENV_SOFTBOXES) {
    const geo = new THREE.PlaneGeometry(spec.width, spec.height)
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColour: { value: balancedLightColour(spec.kelvin, whiteBalance, colour.clone()) },
        uRadiance: { value: spec.radiance },
        uFeather: { value: spec.feather },
      },
      vertexShader: PANEL_VERT,
      fragmentShader: PANEL_FRAG,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.renderOrder = 0
    mesh.position.set(spec.position.x, spec.position.y, spec.position.z)
    mesh.lookAt(0, 0, 0)
    scene.add(mesh)
    geometries.push(geo)
    materials.push(mat)
  }

  return {
    scene,
    dispose(): void {
      for (const g of geometries) g.dispose()
      for (const m of materials) m.dispose()
      scene.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Rig placement
// ---------------------------------------------------------------------------

/** Everything aims a touch above the desk, at the machine's mass. */
const AIM = new THREE.Vector3(0, 0.05, 0.02)

/** Spherical placement helper: azimuth 0° = camera side (+Z), 90° = +X. */
function place(azimuthDeg: number, elevationDeg: number, distance: number): THREE.Vector3 {
  const az = (azimuthDeg * Math.PI) / 180
  const el = (elevationDeg * Math.PI) / 180
  return new THREE.Vector3(
    AIM.x + distance * Math.cos(el) * Math.sin(az),
    AIM.y + distance * Math.sin(el),
    AIM.z + distance * Math.cos(el) * Math.cos(az),
  )
}

/**
 * The nearby key aims at the keyboard. Moving the old broad source forward restores
 * the photographed console/keyboard contrast without darkening either material.
 */
const KEY_AIM = new THREE.Vector3(0, 0.03, 0.265)
const KEY_POS = new THREE.Vector3(-0.15, 0.4, 0.55)
/** Direction the key arrives from, for the co-directional shadow caster. */
const KEY_DIR = KEY_POS.clone().sub(KEY_AIM).normalize()
/** Distance the shadow-casting directional sits at, so its ortho depth range stays tight. */
const KEY_SHADOW_DISTANCE = 2.0

const FILL_POS = place(58, 20, 1.2)
/**
 * Behind-left strip. Parked *far* back on purpose: a rim's diffuse spill falls with the
 * square of its distance while the brightness of its specular reflection does not, so
 * distance is the knob that buys an edge line without washing the top plane.
 */
const RIM_POS = place(-132, 20, 4.0)
/** Low front-left strip: rims the reverse views and lifts the fascia off black. */
const KICKER_POS = place(-62, 15, 0.9)

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

class StudioLighting implements LightingRig {
  public readonly name = 'lighting'

  public group: THREE.Group | null = null
  public lights: LightingLights | null = null
  public environmentTexture: THREE.Texture | null = null

  private readonly exposureScale: number
  private readonly environmentIntensity: number
  private readonly whiteBalance: number
  private readonly shadowsEnabled: boolean
  private readonly shadowMapSize: number
  private readonly shadowExtent: number
  private readonly configureRenderer: boolean
  private readonly screenResponse: number
  private readonly backdropEnabled: boolean

  private scene: THREE.Scene | null = null
  private envRenderTarget: THREE.WebGLRenderTarget | null = null
  private backdrop: THREE.Mesh | null = null

  private currentExposure: number

  // --- screen-light state
  private readonly screenPhosphor: THREE.Color
  private readonly screenCold = new THREE.Color(SCREEN_COLD)
  private readonly screenTargetColour: THREE.Color
  private readonly screenColourScratch = new THREE.Color()
  private screenTargetIntensity = 0
  private screenIntensity = 0

  public constructor(options: LightingOptions = {}) {
    this.exposureScale = options.exposureScale ?? 1
    this.currentExposure = this.exposureScale
    this.environmentIntensity = options.environmentIntensity ?? 0.11
    this.whiteBalance = options.whiteBalanceKelvin ?? DEFAULT_WHITE_BALANCE
    this.shadowsEnabled = options.shadows ?? true
    this.shadowMapSize = options.shadowMapSize ?? 2048
    this.shadowExtent = options.shadowExtent ?? DEFAULT_SHADOW_EXTENT
    this.configureRenderer = options.configureRenderer ?? true
    this.screenResponse = Math.max(1e-3, options.screenResponse ?? 0.09)
    this.backdropEnabled = options.backdrop ?? true

    this.screenPhosphor = new THREE.Color(options.screenColour ?? SCREEN_PHOSPHOR)
    this.screenTargetColour = this.screenPhosphor.clone()
  }

  // -------------------------------------------------------------------------

  public build(ctx: ModuleContext): THREE.Group {
    // Rebuilding is legal (hot reload, renderer swap); never leak the old rig.
    if (this.group !== null) this.dispose()

    // The linearly-transformed-cosine LUTs RectAreaLight needs. Idempotent.
    RectAreaLightUniformsLib.init()

    this.scene = ctx.scene
    this.applyRendererDefaults(ctx.renderer)

    const group = new THREE.Group()
    group.name = 'studio-lighting'
    this.group = group

    // --- IBL base -----------------------------------------------------------
    this.environmentTexture = this.generateEnvironment(ctx.renderer)
    ctx.scene.environment = this.environmentTexture
    ctx.scene.environmentIntensity = this.environmentIntensity

    const e = this.exposureScale
    this.currentExposure = e

    // --- Backdrop -----------------------------------------------------------
    // The key throws roughly opposite to where it sits; that is where the seamless
    // catches its spill pool.
    voidUniforms.uVoidSpillDir.value.set(-KEY_DIR.x, 0, -KEY_DIR.z).normalize()
    if (this.backdropEnabled) group.add(this.buildBackdrop())

    // --- Key ----------------------------------------------------------------
    const key = new THREE.RectAreaLight(this.colourAt(KELVIN.key), BASE.key * e, 0.8, 0.4)
    key.name = 'key'
    key.position.copy(KEY_POS)
    key.lookAt(KEY_AIM)
    group.add(key)

    // RectAreaLight cannot cast shadows, so a directional stands in from the same
    // direction. It carries a minority of the key energy — enough that the contact
    // shadow reads as a real occlusion, little enough that its hard terminator does not.
    const keyShadow = new THREE.DirectionalLight(this.colourAt(KELVIN.key), BASE.keyShadow * e)
    keyShadow.name = 'key-shadow'
    keyShadow.position.copy(KEY_DIR).multiplyScalar(KEY_SHADOW_DISTANCE).add(AIM)
    keyShadow.target.position.copy(AIM)
    group.add(keyShadow)
    group.add(keyShadow.target)
    this.configureKeyShadow(keyShadow)

    // --- Fill ---------------------------------------------------------------
    // Cooler and weaker, opening the opposite flank without flattening the key.
    const fill = new THREE.RectAreaLight(this.colourAt(KELVIN.fill), BASE.fill * e, 1.3, 0.9)
    fill.name = 'fill'
    fill.position.copy(FILL_POS)
    fill.lookAt(AIM.x, AIM.y, AIM.z)
    group.add(fill)

    // --- Rim ----------------------------------------------------------------
    // A narrow strip keeps the rear edge legible without lifting the whole lid.
    const rim = new THREE.RectAreaLight(this.colourAt(KELVIN.rim), BASE.rim * e, 2.0, 0.032)
    rim.name = 'rim'
    rim.position.copy(RIM_POS)
    rim.lookAt(AIM.x, 0.045, AIM.z)
    group.add(rim)

    // --- Kicker -------------------------------------------------------------
    // Low front-left. Serves the reverse views as their rim, and doubles as the bounce
    // card that keeps the recessed fascia from crushing under the shell overhang.
    const kicker = new THREE.RectAreaLight(this.colourAt(KELVIN.kicker), BASE.kicker * e, 0.85, 0.05)
    kicker.name = 'kicker'
    kicker.position.copy(KICKER_POS)
    kicker.lookAt(AIM.x, 0.04, AIM.z)
    group.add(kicker)

    // --- Screen -------------------------------------------------------------
    // Starts fully off; the power-on sequence ramps it. Default placement assumes a
    // ~14" CRT sitting behind the main unit — the CRT module should call
    // setScreenLightTransform()/setScreenLightSize() with the real face.
    const screen = new THREE.RectAreaLight(this.screenPhosphor.clone(), 0, 0.26, 0.196)
    screen.name = 'screen'
    screen.position.set(0, 0.3, -0.24)
    screen.lookAt(0, 0.02, 0.34)
    group.add(screen)

    this.lights = { key, keyShadow, fill, rim, kicker, screen }
    return group
  }

  // -------------------------------------------------------------------------

  public update(dt: number): boolean {
    const lights = this.lights
    if (lights === null) return false

    // Exponential approach, framerate-independent. Even a hard step becomes a ramp,
    // which is what a CRT actually does — the cathode does not switch.
    const k = 1 - Math.exp(-Math.max(0, dt) / this.screenResponse)
    this.screenIntensity += (this.screenTargetIntensity - this.screenIntensity) * k
    // Snap: the exponential never formally lands, and an eternally-approaching light
    // would keep the render-on-demand loop awake chasing sub-visible deltas.
    if (Math.abs(this.screenTargetIntensity - this.screenIntensity) < 1e-4) {
      this.screenIntensity = this.screenTargetIntensity
    }

    const level = this.screenIntensity
    lights.screen.intensity = BASE.screen * level * this.currentExposure

    // A cold cathode reads slightly duller and greener than a settled raster, so the
    // spill drifts toward the phosphor colour as the tube comes up.
    const warmth = Math.min(1, Math.max(0, level))
    this.screenColourScratch.copy(this.screenCold).lerp(this.screenTargetColour, warmth)
    lights.screen.color.copy(this.screenColourScratch)

    return this.screenIntensity !== this.screenTargetIntensity
  }

  // -------------------------------------------------------------------------

  public setScreenLight(intensity: number, colour?: THREE.ColorRepresentation): void {
    this.screenTargetIntensity = Math.max(0, intensity)
    if (colour !== undefined) this.screenTargetColour.set(colour)
  }

  public applyPowerState(state: PowerState): void {
    const warmth = state.on ? Math.min(1, Math.max(0, state.warmth)) : 0
    // A CRT's light output rises faster than linearly once the beam is up, then
    // settles. warmth^1.6 with a small floor reproduces that shoulder-less ramp.
    this.setScreenLight(warmth <= 0 ? 0 : Math.pow(warmth, 1.6))
  }

  public setScreenLightTransform(position: Point3, target: Point3): void {
    const screen = this.lights?.screen
    if (screen === undefined) return
    screen.position.set(position.x, position.y, position.z)
    screen.lookAt(target.x, target.y, target.z)
  }

  public setScreenLightSize(width: number, height: number): void {
    const screen = this.lights?.screen
    if (screen === undefined) return
    screen.width = Math.max(1e-4, width)
    screen.height = Math.max(1e-4, height)
  }

  public setEnvironmentIntensity(value: number): void {
    if (this.scene !== null) this.scene.environmentIntensity = Math.max(0, value)
  }

  public setExposureScale(scale: number): void {
    const lights = this.lights
    if (lights === null) return
    const s = Math.max(0, scale)
    this.currentExposure = s
    lights.key.intensity = BASE.key * s
    lights.keyShadow.intensity = BASE.keyShadow * s
    lights.fill.intensity = BASE.fill * s
    lights.rim.intensity = BASE.rim * s
    lights.kicker.intensity = BASE.kicker * s
    lights.screen.intensity = BASE.screen * this.screenIntensity * s
  }

  // -------------------------------------------------------------------------

  public dispose(): void {
    const lights = this.lights
    if (lights !== null) {
      lights.keyShadow.shadow.dispose()
      lights.key.dispose()
      lights.fill.dispose()
      lights.rim.dispose()
      lights.kicker.dispose()
      lights.screen.dispose()
      lights.keyShadow.dispose()
    }

    const backdrop = this.backdrop
    if (backdrop !== null) {
      backdrop.geometry.dispose()
      const material = backdrop.material
      if (Array.isArray(material)) for (const m of material) m.dispose()
      else material.dispose()
    }
    this.backdrop = null

    this.group?.clear()

    if (this.scene !== null && this.scene.environment === this.environmentTexture) {
      this.scene.environment = null
    }
    this.envRenderTarget?.dispose()

    this.envRenderTarget = null
    this.environmentTexture = null
    this.lights = null
    this.group = null
    this.scene = null
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** White-balanced colour for a source at `kelvin`. */
  private colourAt(kelvin: number): THREE.Color {
    return balancedLightColour(kelvin, this.whiteBalance)
  }

  /**
   * The seamless the set floats against. It exists purely so the blacks have a *toe*:
   * a flat clear colour puts a quarter of a reverse-angle frame on one clipped value,
   * and clipped black is as unphotographic as clipped white.
   */
  private buildBackdrop(): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(24, 32, 16)
    const material = new THREE.ShaderMaterial({
      name: 'studio-void',
      uniforms: voidUniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader: BACKDROP_VERT,
      fragmentShader: BACKDROP_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'studio-void'
    mesh.renderOrder = -1000
    mesh.frustumCulled = false
    mesh.receiveShadow = false
    mesh.castShadow = false
    // Never a raycast target: it wraps the whole set and would swallow every click.
    mesh.raycast = (): void => {}
    this.backdrop = mesh
    return mesh
  }

  /**
   * Renders the procedural studio into a cube render target and PMREM-convolves it,
   * so image-based lighting is real pre-filtered radiance rather than a flat ambient.
   */
  private generateEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
    const env = buildEnvironmentScene(this.whiteBalance)
    const pmrem = new THREE.PMREMGenerator(renderer)
    // A whisker of pre-blur kills the cube-face aliasing on the softbox edges before
    // the roughness convolution runs.
    const target = pmrem.fromScene(env.scene, 0.02, 0.1, 60)
    pmrem.dispose()
    env.dispose()
    this.envRenderTarget = target
    target.texture.name = 'studio-env'
    return target.texture
  }

  /**
   * Tight ortho frustum + normal-offset bias. The frustum is deliberately small so
   * one texel is well under a millimetre: the shell/fascia step is a 2 mm feature and
   * a loose frustum turns it into mush or, worse, acne.
   *
   * The PCF kernel is deliberately *tighter* than a "big soft key" would suggest. A
   * 1.2 m softbox at 1 m does throw a wide penumbra — but the penumbra of a contact
   * shadow is set by the gap, not by the source, and a uniformly blurred shadow with no
   * dark core under the object is the single loudest "nothing is touching the table"
   * cue. The wide part of the falloff is supplied by the desk's contact term and SSAO.
   */
  private configureKeyShadow(light: THREE.DirectionalLight): void {
    light.castShadow = this.shadowsEnabled
    if (!this.shadowsEnabled) return

    const shadow = light.shadow
    shadow.mapSize.set(this.shadowMapSize, this.shadowMapSize)

    const half = this.shadowExtent
    const cam = shadow.camera
    cam.left = -half
    cam.right = half
    cam.top = half
    cam.bottom = -half
    // Bracket the scene sphere tightly around the light distance for depth precision.
    cam.near = Math.max(0.05, KEY_SHADOW_DISTANCE - half)
    cam.far = KEY_SHADOW_DISTANCE + half
    cam.updateProjectionMatrix()

    // Constant bias stays tiny (~0.25 mm of the 1.7 m depth range) so nothing detaches
    // from its contact point; the heavy lifting is done by the normal offset, which is
    // what actually cures acne on grazing surfaces without peter-panning.
    shadow.bias = -0.00012
    shadow.normalBias = 0.0005
    // A 1.2 m softbox at 1 m genuinely throws a wide penumbra, so this stays soft; the
    // dark core at the contact line is supplied by the desk's analytic contact term and
    // by SSAO, which is where a contact core physically comes from anyway.
    shadow.radius = 8
    shadow.blurSamples = 20
    shadow.intensity = 1.0
  }

  /**
   * Touch the renderer only where it is still at three.js defaults. If the Engine has
   * already picked a tone mapper or shadow type, that choice stands.
   */
  private applyRendererDefaults(renderer: THREE.WebGLRenderer): void {
    if (!this.configureRenderer) return

    if (this.shadowsEnabled) {
      renderer.shadowMap.enabled = true
      // r185 deprecated PCFSoftShadowMap: plain PCF now does a radius-scaled 5-tap
      // Vogel disk on top of hardware 2x2 comparison filtering, so softness comes from
      // `shadow.radius` instead of the map type. Only lift the unfiltered default.
      if (renderer.shadowMap.type === THREE.BasicShadowMap) {
        renderer.shadowMap.type = THREE.PCFShadowMap
      }
    }

    if (renderer.toneMapping === THREE.NoToneMapping) {
      // SPEC §6: AgX or ACES. AgX holds highlight hue far better on the CRT bloom.
      renderer.toneMapping = THREE.AgXToneMapping
      renderer.toneMappingExposure = 1.0
    }
    if (renderer.outputColorSpace !== THREE.SRGBColorSpace) {
      renderer.outputColorSpace = THREE.SRGBColorSpace
    }
  }
}

/**
 * Create the studio rig. Returns a {@link SceneModule} the Engine can compose plus the
 * runtime handle the power sequence needs.
 */
export function createLighting(options: LightingOptions = {}): LightingRig {
  return new StudioLighting(options)
}

/**
 * Ready-made default rig, for an Engine that just wants to drop a module in.
 * Constructing it is free — no GPU work happens until `build()`.
 */
export const lightingModule: LightingRig = createLighting()

export default createLighting
