/**
 * Joystick de microchave para MSX — periférico do Gradiente Expert XP-800.
 *
 * Base chata e pesada de ABS preto com friso vermelho, manche alto de bola,
 * dois botões de disparo redondos, sanfona de borracha que *deforma* junto com
 * o manche, quatro ventosas embaixo e um cabo espiralado com catenária até a
 * máquina (SPEC §8: "cable catenary sag").
 *
 * Tudo é procedural: nenhuma malha ou textura vem de arquivo. As texturas de
 * superfície vêm da biblioteca compartilhada (`MaterialLibrary`), então o
 * plástico responde à luz exatamente como o do gabinete principal.
 *
 * Sistema de coordenadas local: y = 0 é o tampo da mesa, +z é a frente
 * (lado do jogador), o manche fica atrás e os botões na frente.
 */

import * as THREE from 'three'
import type { InteractiveUserData, ModuleContext, SceneModule } from '../core/types'
import { silkscreenDecalAsync } from '../textures/procedural'

// ─── Dimensões (metros) ──────────────────────────────────────────────────────────

/** Corpo da base. Comparável a um Competition Pro: 146 × 180 × 43 mm. */
const BASE_W = 0.146
const BASE_D = 0.18
const BASE_BOTTOM = 0.0052
const BASE_TOP = 0.05
const BASE_CORNER_R = 0.019
const BASE_BEVEL = 0.0026

/** Painel superior rebaixado 1,8 mm — é ele que cria a linha de sombra do topo. */
const DECK_INSET = 0.0085
const DECK_TOP = 0.0482
const DECK_THICK = 0.004
const DECK_W = BASE_W - 2 * DECK_INSET
const DECK_D = BASE_D - 2 * DECK_INSET
/** Boca do rebaixo no casco — o bevel do extrude a alarga ~2 mm no topo. */
const OPENING_W = DECK_W - 0.0015
const OPENING_D = DECK_D - 0.0015
/** Chapa do painel: maior que a boca, para nunca abrir fresta sob o lábio. */
const PLATE_W = DECK_W + 0.004
const PLATE_D = DECK_D + 0.004
/** Plano do decalque: um pouco menor que a boca, para não brigar com o lábio. */
const DECAL_W = DECK_W - 0.003
const DECAL_D = DECK_D - 0.003

/** Manche. Pivô fica *dentro* da base, 6,7 mm abaixo do painel. */
const STICK_Z = -0.036
const PIVOT_Y = 0.0415
const GAITER_H = 0.036
const SHAFT_LEN = 0.056
const BALL_R = 0.0185
const MAX_TILT = THREE.MathUtils.degToRad(24)

/** Botões de disparo. */
const BUTTON_Z = 0.044
const BUTTON_X = 0.0345
const BUTTON_R = 0.0118
const BUTTON_HOLE_R = 0.013
const BUTTON_TRAVEL = 0.0028
const BUTTON_H = 0.0062

/** Ventosas: ⌀21 mm, pé estreito e saia flangeada — silhueta de ventosa mesmo. */
const CUP_R = 0.0105
const CUP_H = BASE_BOTTOM

/** Cabo. */
const CABLE_R = 0.00215
const COIL_R = 0.009
const COIL_PITCH = 0.0049

/**
 * Densidade do grão de ABS. A unidade principal usa ~15 repetições/m sobre um
 * gabinete de 40 cm; num periférico de 15 cm o mesmo valor vira couro grosso —
 * 36/m devolve o "orange peel" de ~0,7 mm que a peça real tem.
 */
const GRAIN_PER_M = 36

/**
 * Pose padrão: à direita da unidade principal, levemente virado para o jogador.
 *
 * O `z` importa: a plataforma de luz do estúdio tem um "bounce" frontal baixo
 * (z ≈ +0,76) e um fill à direita. Adiantar o joystick para z ≈ +0,15 o coloca
 * dentro desse hot spot e o ABS preto lava para cinza claro — verificado
 * trocando o material pelo da unidade principal, que lava igual ali. Em
 * z ≈ +0,05 a peça volta a ler como grafite escuro.
 */
const DEFAULT_POSITION = { x: 0.325, y: 0, z: 0.05 } as const
const DEFAULT_ROTATION_Y = -0.16
const deflectionAxis = new THREE.Vector3()
const deflectionQuaternion = new THREE.Quaternion()
const deflectionPoint = new THREE.Vector3()

// ─── Cores ───────────────────────────────────────────────────────────────────────

/** Preto de ABS de periférico: mais quente e menos "buraco" que o painel fosco. */
const SHELL_BLACK = 0x232120
const DECK_BLACK = 0x1b1a19
/** Vermelho do friso e dos botões — mesmo da tecla STOP (SPEC §3.2). */
const ACCENT_RED = 0xc4342a
const BALL_RED = 0xbe3128

// ─── Utilidades numéricas ────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Acesso indexado seguro (`noUncheckedIndexedAccess`), com clamp nas pontas. */
function at<T>(list: readonly T[], index: number): T {
  const item = list[clamp(index, 0, list.length - 1)]
  if (item === undefined) throw new Error('Joystick: lista vazia onde se esperava pontos.')
  return item
}

/**
 * Mola amortecida (Euler semi-implícito com subpassos). `zeta < 1` dá o leve
 * overshoot de uma mola de retorno real; `zeta = 1` para o curso de botão.
 */
interface Spring {
  value: number
  velocity: number
}

function stepSpring(spring: Spring, target: number, omega: number, zeta: number, dt: number): void {
  const steps = Math.min(6, Math.max(1, Math.ceil(dt / (1 / 240))))
  const h = dt / steps
  const k = omega * omega
  const c = 2 * zeta * omega
  for (let i = 0; i < steps; i++) {
    const accel = -k * (spring.value - target) - c * spring.velocity
    spring.velocity += accel * h
    spring.value += spring.velocity * h
  }
}

/**
 * Repouso com snap: `true` só quando a mola está EXATAMENTE no alvo (nada a fazer).
 * Dentro do epsilon ela é assentada no alvo e ainda devolve `false` — o quadro do
 * snap escreve a pose final; sem o snap, a exponencial orbita o alvo para sempre e o
 * módulo nunca declara idle. O epsilon (1e-4 de deflexão normalizada ≈ centésimos de
 * milímetro) fica muito abaixo do overshoot real da mola ζ = 0.72 — o rebote inteiro
 * sobrevive.
 */
function settleSpring(spring: Spring, target: number): boolean {
  if (spring.value === target && spring.velocity === 0) return true
  if (Math.abs(spring.value - target) < 1e-4 && Math.abs(spring.velocity) < 1e-3) {
    spring.value = target
    spring.velocity = 0
  }
  return false
}

// ─── Geometria auxiliar ──────────────────────────────────────────────────────────

/** Retângulo de cantos arredondados no plano XY, centrado na origem. */
function roundedRect(width: number, depth: number, radius: number): THREE.Shape {
  const w = width / 2
  const d = depth / 2
  const r = Math.min(radius, w, d)
  const shape = new THREE.Shape()
  shape.moveTo(-w + r, -d)
  shape.lineTo(w - r, -d)
  shape.absarc(w - r, -d + r, r, -Math.PI / 2, 0, false)
  shape.lineTo(w, d - r)
  shape.absarc(w - r, d - r, r, 0, Math.PI / 2, false)
  shape.lineTo(-w + r, d)
  shape.absarc(-w + r, d - r, r, Math.PI / 2, Math.PI, false)
  shape.lineTo(-w, -d + r)
  shape.absarc(-w + r, -d + r, r, Math.PI, Math.PI * 1.5, false)
  return shape
}

/** Razão `bevelSize / bevelThickness` usada em todos os extrudes daqui. */
const BEVEL_SIZE = 0.8

/**
 * Retângulo arredondado **já compensado pelo bevel**.
 *
 * A `ExtrudeGeometry` do three não recolhe as tampas: ela infla a seção do meio
 * em `bevelSize` para fora do contorno. Sem compensar, uma base pedida com
 * 146 mm sai com 150 mm — e qualquer peça apoiada na face (o friso vermelho)
 * fica enterrada dentro do casco. Encolhemos a shape na mesma medida.
 */
function roundedRectForBevel(width: number, depth: number, radius: number, bevel: number): THREE.Shape {
  const bs = bevel * BEVEL_SIZE
  return roundedRect(width - 2 * bs, depth - 2 * bs, Math.max(0.0004, radius - bs))
}

/** Furo circular, em sentido horário — oposto ao contorno externo, como o three exige. */
function circleHole(cx: number, cy: number, radius: number): THREE.Path {
  const path = new THREE.Path()
  path.absarc(cx, cy, radius, 0, Math.PI * 2, true)
  return path
}

/**
 * Extruda uma `Shape` no eixo Y (a `ExtrudeGeometry` extruda em +Z; giramos).
 * O bevel dá o filete de 2 mm das arestas superiores/inferiores; os cantos
 * verticais já vêm arredondados da própria `Shape`.
 *
 * As UVs saem em **metros** (gerador padrão do three), por isso os materiais
 * derivados usam `repeat = GRAIN_PER_M`.
 */
function extrudeY(shape: THREE.Shape, height: number, bevel: number, bevelSegments = 3): THREE.BufferGeometry {
  const depth = Math.max(0.0002, height - 2 * bevel)
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * BEVEL_SIZE,
    bevelOffset: 0,
    bevelSegments,
    curveSegments: 10,
  })
  geometry.rotateX(-Math.PI / 2)
  // Após o giro a peça ocupa y ∈ [-bevel, height - bevel]; sobe para y ∈ [0, height].
  geometry.translate(0, bevel, 0)
  return geometry
}

// ─── Cabo: catenária, hélice e tubo ──────────────────────────────────────────────

/**
 * Catenária real entre duas âncoras. `sag` é a flecha (queda máxima abaixo da
 * reta) em metros; `k` controla o quanto o perfil parece corda pesada.
 */
function catenary(a: THREE.Vector3, b: THREE.Vector3, sag: number, samples: number, minY: number): THREE.Vector3[] {
  const k = 1.7
  const denom = 1 - Math.cosh(k)
  const points: THREE.Vector3[] = []
  for (let i = 0; i <= samples; i++) {
    const u = i / samples
    const shape = (Math.cosh(k * (2 * u - 1)) - Math.cosh(k)) / denom
    const p = a.clone().lerp(b, u)
    p.y = Math.max(minY, p.y - sag * shape)
    points.push(p)
  }
  return points
}

/** Amostra uniforme (em comprimento de arco) de uma Catmull-Rom pelos pontos dados. */
function sampleSpline(controls: readonly THREE.Vector3[], samples: number): THREE.Vector3[] {
  const curve = new THREE.CatmullRomCurve3(controls.map((p) => p.clone()), false, 'centripetal', 0.5)
  return curve.getSpacedPoints(samples)
}

/**
 * Suaviza a polilinha (Laplaciano com pontas fixas). Só tem efeito perceptível
 * nas emendas entre os trechos do cabo — sem isso a catenária encontra a
 * espiral num cotovelo, e cabo de borracha não faz quina.
 */
function relax(points: THREE.Vector3[], iterations: number, lambda: number): void {
  const mid = new THREE.Vector3()
  for (let it = 0; it < iterations; it++) {
    const snapshot = points.map((p) => p.clone())
    for (let i = 1; i < points.length - 1; i++) {
      mid.copy(at(snapshot, i - 1)).add(at(snapshot, i + 1)).multiplyScalar(0.5)
      at(points, i).lerp(mid, lambda)
    }
  }
}

interface Frames {
  readonly tangents: THREE.Vector3[]
  readonly normals: THREE.Vector3[]
  readonly binormals: THREE.Vector3[]
}

/**
 * Referenciais por transporte paralelo. Mais estáveis que Frenet em trechos
 * quase retos — sem isso a hélice do cabo dá um "flip" no meio da mesa.
 */
function parallelTransport(points: readonly THREE.Vector3[]): Frames {
  const n = points.length
  const tangents: THREE.Vector3[] = []
  for (let i = 0; i < n; i++) {
    const t = at(points, i + 1).clone().sub(at(points, i - 1))
    if (t.lengthSq() < 1e-12) t.set(0, 0, 1)
    tangents.push(t.normalize())
  }

  const normals: THREE.Vector3[] = []
  const binormals: THREE.Vector3[] = []
  const seed = new THREE.Vector3(0, 1, 0)
  if (Math.abs(at(tangents, 0).dot(seed)) > 0.9) seed.set(1, 0, 0)
  let normal = seed.clone().sub(at(tangents, 0).clone().multiplyScalar(seed.dot(at(tangents, 0)))).normalize()
  normals.push(normal.clone())
  binormals.push(at(tangents, 0).clone().cross(normal).normalize())

  const rotation = new THREE.Quaternion()
  for (let i = 1; i < n; i++) {
    const prev = at(tangents, i - 1)
    const curr = at(tangents, i)
    rotation.setFromUnitVectors(prev, curr)
    normal = normal.clone().applyQuaternion(rotation)
    // Reortogonaliza para não acumular deriva ao longo de ~450 amostras.
    normal.sub(curr.clone().multiplyScalar(normal.dot(curr))).normalize()
    normals.push(normal.clone())
    binormals.push(curr.clone().cross(normal).normalize())
  }
  return { tangents, normals, binormals }
}

/** Tubo varrido ao longo de uma polilinha com referenciais dados. */
function sweepTube(
  points: readonly THREE.Vector3[],
  frames: Frames,
  radius: number,
  radialSegments: number,
): THREE.BufferGeometry {
  const n = points.length
  const rings = radialSegments + 1
  const positions = new Float32Array(n * rings * 3)
  const normalsOut = new Float32Array(n * rings * 3)
  const uvs = new Float32Array(n * rings * 2)
  const indices: number[] = []

  let arc = 0
  const circumference = 2 * Math.PI * radius
  for (let i = 0; i < n; i++) {
    if (i > 0) arc += at(points, i).distanceTo(at(points, i - 1))
    const centre = at(points, i)
    const nrm = at(frames.normals, i)
    const bin = at(frames.binormals, i)
    for (let j = 0; j < rings; j++) {
      const theta = (j / radialSegments) * Math.PI * 2
      const cos = Math.cos(theta)
      const sin = Math.sin(theta)
      const nx = nrm.x * cos + bin.x * sin
      const ny = nrm.y * cos + bin.y * sin
      const nz = nrm.z * cos + bin.z * sin
      const k = (i * rings + j) * 3
      positions[k] = centre.x + nx * radius
      positions[k + 1] = centre.y + ny * radius
      positions[k + 2] = centre.z + nz * radius
      normalsOut[k] = nx
      normalsOut[k + 1] = ny
      normalsOut[k + 2] = nz
      const u = (i * rings + j) * 2
      uvs[u] = arc / circumference
      uvs[u + 1] = j / radialSegments
    }
  }

  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * rings + j
      const b = a + rings
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normalsOut, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

interface CoilRange {
  /** Índices (inclusive) do trecho espiralado dentro da polilinha da alma. */
  readonly from: number
  readonly to: number
}

/** Enrola a alma do cabo: hélice de raio `COIL_R` no trecho indicado, com rampa nas pontas. */
function coilAroundSpine(spine: readonly THREE.Vector3[], frames: Frames, range: CoilRange): THREE.Vector3[] {
  const lengths: number[] = [0]
  for (let i = 1; i < spine.length; i++) {
    lengths.push(at(lengths, i - 1) + at(spine, i).distanceTo(at(spine, i - 1)))
  }
  const startLen = at(lengths, range.from)
  const coilLen = at(lengths, range.to) - startLen
  const turns = Math.max(1, Math.round(coilLen / COIL_PITCH))

  const out: THREE.Vector3[] = []
  for (let i = 0; i < spine.length; i++) {
    const p = at(spine, i).clone()
    if (i >= range.from && i <= range.to && coilLen > 0) {
      const local = (at(lengths, i) - startLen) / coilLen
      // Rampa nas pontas: a espiral "nasce" e "morre" no cabo reto.
      const ramp = smoothstep(0, 0.07, local) * smoothstep(0, 0.07, 1 - local)
      const radius = COIL_R * ramp
      const angle = local * turns * Math.PI * 2
      const nrm = at(frames.normals, i)
      const bin = at(frames.binormals, i)
      p.addScaledVector(nrm, Math.cos(angle) * radius)
      p.addScaledVector(bin, Math.sin(angle) * radius)
    }
    out.push(p)
  }
  return out
}

// ─── Módulo ──────────────────────────────────────────────────────────────────────

export interface JoystickOptions {
  /** Posição do joystick na mesa (mundo). Padrão: à direita do teclado. */
  readonly position?: { x: number; y: number; z: number }
  /** Giro em torno de Y, em radianos. Padrão: levemente virado para o jogador. */
  readonly rotationY?: number
  /** Deflexão máxima do manche, em graus. Padrão 24°. */
  readonly maxTiltDeg?: number
  /** Desliga o cabo (útil para closes só do manche). */
  readonly cable?: boolean
}

type ButtonId = 'a' | 'b'

interface ButtonRig {
  readonly mesh: THREE.Mesh
  readonly restY: number
  readonly spring: Spring
  pressed: boolean
}

export class Joystick implements SceneModule {
  readonly name = 'Joystick'

  private readonly options: JoystickOptions
  private readonly maxTilt: number

  private group: THREE.Group | null = null
  private stickPivot: THREE.Object3D | null = null
  private gaiterGeometry: THREE.BufferGeometry | null = null
  private gaiterRest: Float32Array | null = null
  private readonly buttons = new Map<ButtonId, ButtonRig>()

  /** Alvo e estado suavizado da deflexão, ambos em [-1, 1]. */
  private targetX = 0
  private targetY = 0
  private readonly tiltX: Spring = { value: 0, velocity: 0 }
  private readonly tiltY: Spring = { value: 0, velocity: 0 }
  /** Última deflexão aplicada à malha — evita redeformar a sanfona parada. */
  private appliedX = Number.NaN
  private appliedY = Number.NaN

  private readonly disposables: Array<{ dispose(): void }> = []
  private readonly timers = new Set<number>()
  private disposed = false
  /** Para levantar `shadowMap.needsUpdate` nos quadros em que o manche se move. */
  private renderer: THREE.WebGLRenderer | null = null

  constructor(options: JoystickOptions = {}) {
    this.options = options
    this.maxTilt =
      options.maxTiltDeg === undefined ? MAX_TILT : THREE.MathUtils.degToRad(clamp(options.maxTiltDeg, 2, 45))
  }

  // ── API pública ────────────────────────────────────────────────────────────────

  /**
   * Deflete o manche. `x` positivo = direita, `y` positivo = para frente
   * (para longe do jogador, −z local). Vetores maiores que 1 são normalizados,
   * como um gate octogonal real. O movimento é amortecido por mola.
   */
  setDirection(x: number, y: number): void {
    if (this.disposed) return
    const cx = clamp(x, -1, 1)
    const cy = clamp(y, -1, 1)
    const magnitude = Math.hypot(cx, cy)
    if (magnitude > 1) {
      this.targetX = cx / magnitude
      this.targetY = cy / magnitude
    } else {
      this.targetX = cx
      this.targetY = cy
    }
  }

  /** Deflexão alvo corrente. */
  getDirection(): { x: number; y: number } {
    return { x: this.targetX, y: this.targetY }
  }

  /** Deflexão realmente exibida (com atraso da mola) — útil para HUD/depuração. */
  getVisualDirection(): { x: number; y: number } {
    return { x: this.tiltX.value, y: this.tiltY.value }
  }

  /** Pressiona/solta um botão de disparo. O curso é animado. */
  setButton(id: ButtonId, pressed: boolean): void {
    if (this.disposed) return
    const rig = this.buttons.get(id)
    if (rig) rig.pressed = pressed
  }

  isButtonPressed(id: ButtonId): boolean {
    return this.buttons.get(id)?.pressed ?? false
  }

  /** Toque momentâneo para chamadas programáticas; o ponteiro usa `setButton()`. */
  pressButton(id: ButtonId, holdMs = 110): void {
    this.setButton(id, true)
    this.later(() => this.setButton(id, false), holdMs)
  }

  /** Grupo raiz já construído, ou `null` antes do `build()`. */
  getObject(): THREE.Group | null {
    return this.group
  }

  // ── Construção ─────────────────────────────────────────────────────────────────

  async build(ctx: ModuleContext): Promise<THREE.Group> {
    // Reconstruir é legítimo (hot reload, troca de renderer) e é o contrato que
    // `Lighting.build()` já segue. Sem isto o `disposed` de um descarte anterior
    // continuaria de pé e o joystick voltaria à cena inteiro porém morto: sem
    // deflexão, sem botões, sem erro nenhum no console.
    if (this.group !== null) this.dispose()
    this.disposed = false
    this.renderer = ctx.renderer

    const group = new THREE.Group()
    group.name = 'joystick'
    // Alça load-bearing para a camada de interação: o joystick é descoberto a
    // partir da instância que realmente vive na cena, sem acoplar os módulos.
    group.userData = { joystick: this }
    const pos = this.options.position ?? DEFAULT_POSITION
    group.position.set(pos.x, pos.y, pos.z)
    group.rotation.y = this.options.rotationY ?? DEFAULT_ROTATION_Y

    const mats = this.materials(ctx)

    group.add(this.buildBody(mats))
    group.add(this.buildDeck(mats))
    group.add(this.buildAccentStripe(mats))
    group.add(await this.buildDeckDecal())
    group.add(this.buildButtonWells(mats))
    for (const id of ['a', 'b'] as const) group.add(this.buildButton(id, mats))
    group.add(this.buildSuctionCups(mats))
    group.add(this.buildGaiter(mats))
    group.add(this.buildStick(mats))
    group.add(this.buildStrainRelief(mats))

    if (this.options.cable !== false) {
      group.updateMatrixWorld(true)
      group.add(this.buildCable(group, mats))
    }

    this.group = group
    this.applyDeflection(true)
    return group
  }

  update(dt: number): boolean {
    if (this.disposed) return false
    const step = clamp(dt, 0, 1 / 15)

    // Sem curto-circuito: cada mola precisa da chance de fazer o snap de repouso.
    const xAtRest = settleSpring(this.tiltX, this.targetX)
    const yAtRest = settleSpring(this.tiltY, this.targetY)
    let busy = !(xAtRest && yAtRest)
    if (busy) {
      stepSpring(this.tiltX, this.targetX, 26, 0.72, step)
      stepSpring(this.tiltY, this.targetY, 26, 0.72, step)
      this.applyDeflection(false)
    }

    for (const rig of this.buttons.values()) {
      const target = rig.pressed ? 1 : 0
      if (settleSpring(rig.spring, target)) continue
      busy = true
      stepSpring(rig.spring, target, 62, 1, step)
      rig.mesh.position.y = rig.restY - clamp(rig.spring.value, -0.2, 1.15) * BUTTON_TRAVEL
    }

    // Manche e sanfona projetam sombra: quadros com movimento redesenham o atlas
    // congelado (contrato em types.ts).
    if (busy && this.renderer !== null) this.renderer.shadowMap.needsUpdate = true
    return busy
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers) window.clearTimeout(timer)
    this.timers.clear()
    for (const item of this.disposables) item.dispose()
    this.disposables.length = 0
    this.buttons.clear()
    this.group = null
    this.stickPivot = null
    this.gaiterGeometry = null
    this.gaiterRest = null
  }

  private later(callback: () => void, delayMs: number): void {
    if (this.disposed) return
    const timer = window.setTimeout(() => {
      this.timers.delete(timer)
      if (!this.disposed) callback()
    }, delayMs)
    this.timers.add(timer)
  }

  // ── Materiais derivados ────────────────────────────────────────────────────────

  /**
   * Clona os materiais compartilhados e re-tila as texturas. Clonar é
   * obrigatório: mexer no `repeat` de uma textura da biblioteca afetaria o
   * gabinete inteiro. O clone compartilha a mesma `Source`, então não custa
   * memória de GPU extra.
   */
  private derive(
    base: THREE.MeshPhysicalMaterial,
    name: string,
    color: number,
    roughness: number,
    repeat: number,
  ): THREE.MeshPhysicalMaterial {
    const material = base.clone()
    material.name = name
    material.color = new THREE.Color(color)
    material.roughness = roughness
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'aoMap'] as const) {
      const texture = material[slot]
      if (texture === null) continue
      const copy = texture.clone()
      copy.wrapS = THREE.RepeatWrapping
      copy.wrapT = THREE.RepeatWrapping
      copy.repeat.set(repeat, repeat)
      copy.needsUpdate = true
      material[slot] = copy
      this.disposables.push(copy)
    }
    material.needsUpdate = true
    this.disposables.push(material)
    return material
  }

  private materials(ctx: ModuleContext): JoystickMaterials {
    const graphite = ctx.materials.caseGraphite()
    const rubberBase = ctx.materials.rubber()

    // SPEC §4 manda 0,55–0,72 no plástico de gabinete. Abaixo disso a peça
    // "acende" em ângulo rasante sob a área de luz principal e vira cinza claro.
    const shell = this.derive(graphite, 'joy-shell', SHELL_BLACK, 0.66, GRAIN_PER_M)
    const deck = this.derive(graphite, 'joy-deck', DECK_BLACK, 0.74, GRAIN_PER_M * 1.3)
    // O poço é visto por dentro pela folga do botão — precisa das duas faces.
    const well = this.derive(graphite, 'joy-button-well', 0x0d0d0c, 0.85, GRAIN_PER_M * 2)
    well.side = THREE.DoubleSide

    // Bola e botões usam a família keycap (ABS injetado, rugosidade 0.42).
    const ball = this.derive(ctx.materials.keycap(BALL_RED), 'joy-balltop', BALL_RED, 0.4, 4.2)
    ball.envMapIntensity = 1.1
    const button = this.derive(ctx.materials.keycap(ACCENT_RED), 'joy-button', ACCENT_RED, 0.38, 1.6)
    button.envMapIntensity = 1.1
    const stripe = this.derive(ctx.materials.keycap(ACCENT_RED), 'joy-stripe', ACCENT_RED, 0.44, 60)

    // Borracha sanfonada: preta, mas não um buraco — o sheen é o que faz as
    // nervuras aparecerem em vez de virar uma mancha escura.
    const boot = this.derive(rubberBase, 'joy-gaiter', 0x1a1817, 0.84, 26)
    boot.side = THREE.DoubleSide
    boot.sheen = 0.5
    boot.sheenRoughness = 0.55
    boot.sheenColor = new THREE.Color(0x4a4440)

    const cup = this.derive(rubberBase, 'joy-suction-cup', 0x1a1917, 0.86, 40)
    cup.side = THREE.DoubleSide
    // Borracha macia translúcida: um resto de sheen dá o aspecto de PVC.
    cup.sheen = 0.35
    cup.sheenRoughness = 0.7
    cup.sheenColor = new THREE.Color(0x3a3430)

    const cable = this.derive(rubberBase, 'joy-cable', 0x151413, 0.58, 1)
    cable.envMapIntensity = 1.2

    // Haste: aço acetinado escurecido, não cromo de vitrine.
    const shaft = ctx.materials.metal(0x55585b, 0.52)
    const plugShell = this.derive(graphite, 'joy-plug', 0x1c1b1a, 0.6, GRAIN_PER_M * 3)

    return { shell, deck, well, ball, button, stripe, boot, cup, cable, shaft, plugShell }
  }

  // ── Peças ──────────────────────────────────────────────────────────────────────

  private track<T extends THREE.BufferGeometry>(geometry: T): T {
    this.disposables.push(geometry)
    return geometry
  }

  /**
   * Casco: retângulo arredondado com uma **abertura real** no topo. O bevel do
   * extrude arredonda também a boca do rebaixo, que é exatamente o lábio que
   * gera a linha de sombra do painel.
   */
  private buildBody(mats: JoystickMaterials): THREE.Group {
    const holder = new THREE.Group()
    holder.name = 'joystick-casco'

    const shape = roundedRectForBevel(BASE_W, BASE_D, BASE_CORNER_R, BASE_BEVEL)
    // A `ExtrudeGeometry` normaliza o sentido dos furos sozinha, então basta a
    // polilinha — não precisa inverter o enrolamento à mão.
    const opening = roundedRect(OPENING_W, OPENING_D, BASE_CORNER_R - DECK_INSET - 0.0008)
    shape.holes.push(new THREE.Path(opening.getPoints(56)))

    const geometry = this.track(extrudeY(shape, BASE_TOP - BASE_BOTTOM, BASE_BEVEL))
    const mesh = new THREE.Mesh(geometry, mats.shell)
    mesh.name = 'joystick-corpo'
    mesh.position.y = BASE_BOTTOM
    mesh.castShadow = true
    mesh.receiveShadow = true
    holder.add(mesh)

    // Meia-carcaça inferior, fechando a abertura por baixo.
    const floorGeom = this.track(
      extrudeY(roundedRectForBevel(PLATE_W, PLATE_D, 0.008, 0.0006), 0.0018, 0.0006, 1),
    )
    const floor = new THREE.Mesh(floorGeom, mats.deck)
    floor.name = 'joystick-fundo'
    floor.position.y = BASE_BOTTOM
    floor.receiveShadow = true
    holder.add(floor)

    return holder
  }

  /** Painel rebaixado, com os dois furos dos botões realmente vazados. */
  private buildDeck(mats: JoystickMaterials): THREE.Mesh {
    const shape = roundedRectForBevel(PLATE_W, PLATE_D, BASE_CORNER_R - DECK_INSET, 0.0008)
    shape.holes.push(circleHole(-BUTTON_X, -BUTTON_Z, BUTTON_HOLE_R))
    shape.holes.push(circleHole(BUTTON_X, -BUTTON_Z, BUTTON_HOLE_R))
    const geometry = this.track(extrudeY(shape, DECK_THICK, 0.0008, 2))
    const mesh = new THREE.Mesh(geometry, mats.deck)
    mesh.name = 'joystick-painel'
    mesh.position.y = DECK_TOP - DECK_THICK
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }

  private buildAccentStripe(mats: JoystickMaterials): THREE.Mesh {
    const shape = roundedRectForBevel(0.092, 0.0092, 0.004, 0.00035)
    const geometry = this.track(
      new THREE.ExtrudeGeometry(shape, {
        depth: 0.0013,
        bevelEnabled: true,
        bevelThickness: 0.00035,
        bevelSize: 0.00035 * BEVEL_SIZE,
        bevelOffset: 0,
        bevelSegments: 2,
        curveSegments: 6,
      }),
    )
    const mesh = new THREE.Mesh(geometry, mats.stripe)
    mesh.name = 'joystick-friso'
    // Face frontal do casco em z = BASE_D/2; a plaqueta fica 1,1 mm saliente.
    mesh.position.set(0, 0.0205, BASE_D / 2 - 0.0004)
    mesh.castShadow = false
    mesh.receiveShadow = true
    return mesh
  }

  /** Serigrafia do painel: `A`, `B` e o dizer `JOYSTICK`, já com desgaste. */
  private async buildDeckDecal(): Promise<THREE.Mesh> {
    const width = 512
    const height = 640
    const toX = (x: number): number => (x / DECAL_W + 0.5) * width
    const toY = (z: number): number => (z / DECAL_D + 0.5) * height

    const decal = await silkscreenDecalAsync(
      (ctx) => {
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.font = '700 27px "Helvetica Neue", Helvetica, Arial, sans-serif'
        ctx.fillText('A', toX(-BUTTON_X), toY(BUTTON_Z + 0.0175))
        ctx.fillText('B', toX(BUTTON_X), toY(BUTTON_Z + 0.0175))

        // Dizer discreto atrás da sanfona, com tracking largo — serigrafia de
        // painel dos anos 80. Fica na traseira para não disputar com os botões.
        ctx.font = '600 12px "Helvetica Neue", Helvetica, Arial, sans-serif'
        ctx.textAlign = 'left'
        const label = 'JOYSTICK'
        const tracking = 5
        const widths = [...label].map((ch) => ctx.measureText(ch).width)
        const total = widths.reduce((sum, w) => sum + w, 0) + tracking * (label.length - 1)
        let cursor = toX(0) - total / 2
        for (let i = 0; i < label.length; i++) {
          ctx.fillText(label[i] ?? '', cursor, toY(-0.066))
          cursor += (widths[i] ?? 0) + tracking
        }
      },
      // Tinta creme e bem gasta: pad print de 1985 não é branco de escritório.
      { width, height, ink: '#DCD7CB', wear: 0.44, relief: 2.4, gloss: 0.5, cacheKey: 'joystick-deck' },
    )
    // As texturas do decalque são memoizadas por `cacheKey` no cache procedural
    // compartilhado — quem libera é `disposeTextureCache()`. Descartá-las aqui
    // apagaria o decalque de uma segunda instância do joystick.

    const material = new THREE.MeshPhysicalMaterial({
      name: 'joy-silkscreen',
      map: decal.map,
      normalMap: decal.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughnessMap: decal.roughnessMap,
      roughness: 0.35,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.FrontSide,
    })
    this.disposables.push(material)

    const geometry = this.track(new THREE.PlaneGeometry(DECAL_W, DECAL_D))
    geometry.rotateX(-Math.PI / 2)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'joystick-serigrafia'
    mesh.position.y = DECK_TOP + 0.00012
    mesh.receiveShadow = true
    mesh.renderOrder = 1
    return mesh
  }

  /**
   * Poço de cada botão: parede cônica com fundo, aberta só em cima. É o que se
   * vê pela folga de 1,2 mm entre a capa do botão e o furo do painel.
   */
  private buildButtonWells(mats: JoystickMaterials): THREE.InstancedMesh {
    const depth = 0.0105
    const profile: THREE.Vector2[] = [
      new THREE.Vector2(0, -depth),
      new THREE.Vector2(BUTTON_HOLE_R * 0.88, -depth),
      new THREE.Vector2(BUTTON_HOLE_R * 0.93, -depth + 0.0022),
      new THREE.Vector2(BUTTON_HOLE_R * 0.985, -0.0018),
      new THREE.Vector2(BUTTON_HOLE_R, 0),
    ]
    const geometry = this.track(new THREE.LatheGeometry(profile, 28))
    geometry.computeVertexNormals()

    const mesh = new THREE.InstancedMesh(geometry, mats.well, 2)
    mesh.name = 'joystick-pocos'
    const matrix = new THREE.Matrix4()
    const xs = [-BUTTON_X, BUTTON_X]
    for (let i = 0; i < xs.length; i++) {
      matrix.makeTranslation(at(xs, i), DECK_TOP, BUTTON_Z)
      mesh.setMatrixAt(i, matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.receiveShadow = true
    return mesh
  }

  private buildButton(id: ButtonId, mats: JoystickMaterials): THREE.Group {
    const holder = new THREE.Group()
    holder.name = `joystick-botao-${id}`

    // Perfil de botão de arcade: saia reta, topo abaulado.
    const profile: THREE.Vector2[] = [
      new THREE.Vector2(0, -BUTTON_H),
      new THREE.Vector2(BUTTON_R, -BUTTON_H),
      new THREE.Vector2(BUTTON_R, -0.0012),
      new THREE.Vector2(BUTTON_R * 0.985, -0.0002),
      new THREE.Vector2(BUTTON_R * 0.93, 0.0009),
      new THREE.Vector2(BUTTON_R * 0.8, 0.0019),
      new THREE.Vector2(BUTTON_R * 0.58, 0.0026),
      new THREE.Vector2(BUTTON_R * 0.3, 0.003),
      new THREE.Vector2(0, 0.0031),
    ]
    const geometry = this.track(new THREE.LatheGeometry(profile, 32))
    geometry.computeVertexNormals()

    const mesh = new THREE.Mesh(geometry, mats.button)
    mesh.name = `joystick-botao-${id}-capa`
    mesh.castShadow = true
    mesh.receiveShadow = true

    const x = id === 'a' ? -BUTTON_X : BUTTON_X
    const restY = DECK_TOP + 0.0021
    mesh.position.set(x, restY, BUTTON_Z)

    const userData: InteractiveUserData = {
      partId: id === 'a' ? 'joystick-button-a' : 'joystick-button-b',
      label: id === 'a' ? 'Botão de disparo A' : 'Botão de disparo B',
      cursor: 'pointer',
    }
    mesh.userData = { ...userData }

    this.buttons.set(id, { mesh, restY, spring: { value: 0, velocity: 0 }, pressed: false })
    holder.add(mesh)
    return holder
  }

  /** Quatro ventosas de borracha macia — detalhe de época, some só se ninguém olhar embaixo. */
  private buildSuctionCups(mats: JoystickMaterials): THREE.InstancedMesh {
    const r = CUP_R
    const h = CUP_H
    const profile: THREE.Vector2[] = [
      new THREE.Vector2(0, h),
      new THREE.Vector2(r * 0.25, h),
      new THREE.Vector2(r * 0.26, h * 0.66),
      new THREE.Vector2(r * 0.32, h * 0.5),
      new THREE.Vector2(r * 0.48, h * 0.34),
      new THREE.Vector2(r * 0.7, h * 0.19),
      new THREE.Vector2(r * 0.9, h * 0.075),
      new THREE.Vector2(r, h * 0.015),
      new THREE.Vector2(r * 0.985, 0),
      new THREE.Vector2(r * 0.86, h * 0.075),
      new THREE.Vector2(r * 0.62, h * 0.22),
      new THREE.Vector2(r * 0.38, h * 0.42),
      new THREE.Vector2(r * 0.2, h * 0.6),
      new THREE.Vector2(0, h * 0.68),
    ]
    const geometry = this.track(new THREE.LatheGeometry(profile, 26))
    geometry.computeVertexNormals()

    const mesh = new THREE.InstancedMesh(geometry, mats.cup, 4)
    mesh.name = 'joystick-ventosas'
    const matrix = new THREE.Matrix4()
    const dx = BASE_W / 2 - 0.021
    const dz = BASE_D / 2 - 0.024
    const spots: Array<[number, number]> = [
      [-dx, -dz],
      [dx, -dz],
      [-dx, dz],
      [dx, dz],
    ]
    for (let i = 0; i < spots.length; i++) {
      const spot = at(spots, i)
      matrix.makeTranslation(spot[0], 0, spot[1])
      mesh.setMatrixAt(i, matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }

  /**
   * Sanfona de borracha. Fica *fora* do pivô: a malha é deformada à mão para
   * que a base continue colada ao painel e o topo acompanhe exatamente a haste.
   */
  private buildGaiter(mats: JoystickMaterials): THREE.Mesh {
    // Perfil gerado por seno: quatro nervuras de crista *arredondada*. Pontos
    // à mão davam cristas em aresta viva, que leem como arruelas empilhadas em
    // vez de borracha sanfonada.
    const profile: THREE.Vector2[] = [
      new THREE.Vector2(0.0192, 0),
      new THREE.Vector2(0.019, 0.0022),
    ]
    const RIBS = 4
    const STEPS = 40
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS
      const y = 0.0032 + t * (GAITER_H - 0.0032)
      // Cone de base: a sanfona afina rápido perto do topo.
      const cone = 0.0175 - 0.0127 * Math.pow(t, 0.82)
      // Ondulação com amplitude decrescente; começa num vale para casar o flange.
      const amp = 0.0026 * (1 - 0.72 * t)
      const r = cone + amp * Math.sin(RIBS * 2 * Math.PI * t - Math.PI / 2)
      profile.push(new THREE.Vector2(Math.max(0.0048, r), y))
    }
    // Boca justa na haste (⌀ 9,6 mm contra ⌀ ~10,0 mm dela): não abre fresta.
    profile.push(new THREE.Vector2(0.0048, GAITER_H))
    const geometry = this.track(new THREE.LatheGeometry(profile, 32))
    geometry.computeVertexNormals()

    const position = geometry.getAttribute('position')
    this.gaiterRest = new Float32Array(position.count * 3)
    for (let i = 0; i < position.count; i++) {
      this.gaiterRest[i * 3] = position.getX(i)
      this.gaiterRest[i * 3 + 1] = position.getY(i)
      this.gaiterRest[i * 3 + 2] = position.getZ(i)
    }
    this.gaiterGeometry = geometry

    const mesh = new THREE.Mesh(geometry, mats.boot)
    mesh.name = 'joystick-sanfona'
    mesh.position.set(0, DECK_TOP, STICK_Z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    // A sanfona é redeformada a cada quadro, então qualquer esfera de contorno
    // nasce desatualizada. Em vez de recomputá-la por quadro só para alimentar o
    // culling, desligamos o culling desta malha — é uma peça pequena, e assim
    // `applyDeflection()` não paga nada por frustum nenhum.
    mesh.frustumCulled = false
    return mesh
  }

  /** Haste + colar + bola. Tudo pendurado no pivô, que fica dentro da base. */
  private buildStick(mats: JoystickMaterials): THREE.Object3D {
    const pivot = new THREE.Object3D()
    pivot.name = 'joystick-pivo'
    pivot.position.set(0, PIVOT_Y, STICK_Z)

    const shaftGeom = this.track(new THREE.CylinderGeometry(0.0047, 0.0059, SHAFT_LEN, 18, 1, false))
    const shaft = new THREE.Mesh(shaftGeom, mats.shaft)
    shaft.name = 'joystick-haste'
    shaft.position.y = SHAFT_LEN / 2
    shaft.castShadow = true
    shaft.receiveShadow = true
    pivot.add(shaft)

    const collarGeom = this.track(new THREE.CylinderGeometry(0.0082, 0.0068, 0.0055, 24, 1, false))
    const collar = new THREE.Mesh(collarGeom, mats.ball)
    collar.name = 'joystick-colar'
    collar.position.y = SHAFT_LEN - 0.0022
    collar.castShadow = true
    collar.receiveShadow = true
    pivot.add(collar)

    const ballGeom = this.track(new THREE.SphereGeometry(BALL_R, 34, 24))
    // Bola injetada real é levemente achatada e tem o pescoço cortado embaixo.
    ballGeom.scale(1, 0.96, 1)
    const ball = new THREE.Mesh(ballGeom, mats.ball)
    ball.name = 'joystick-bola'
    ball.position.y = SHAFT_LEN + BALL_R * 0.86
    ball.castShadow = true
    ball.receiveShadow = true

    const userData: InteractiveUserData = {
      partId: 'joystick-stick',
      label: 'Manche — arraste para inclinar',
      cursor: 'grab',
    }
    ball.userData = { ...userData }
    pivot.add(ball)

    this.stickPivot = pivot
    return pivot
  }

  /** Passa-cabo de borracha na traseira, onde o cabo sai da base. */
  private buildStrainRelief(mats: JoystickMaterials): THREE.Mesh {
    const profile: THREE.Vector2[] = [
      new THREE.Vector2(0.0038, 0),
      new THREE.Vector2(0.007, 0),
      new THREE.Vector2(0.0071, 0.0035),
      new THREE.Vector2(0.0058, 0.0055),
      new THREE.Vector2(0.0057, 0.0085),
      new THREE.Vector2(0.0046, 0.0105),
      new THREE.Vector2(0.0045, 0.013),
      new THREE.Vector2(0.0036, 0.0145),
      new THREE.Vector2(0.0034, 0.0155),
      new THREE.Vector2(0.0022, 0.0155),
    ]
    const geometry = this.track(new THREE.LatheGeometry(profile, 20))
    geometry.computeVertexNormals()
    const mesh = new THREE.Mesh(geometry, mats.boot)
    mesh.name = 'joystick-passa-cabo'
    mesh.position.copy(this.cableExitLocal())
    // Eixo do lathe (+y) apontado para −z: o cabo sai pela traseira.
    mesh.rotation.x = -Math.PI / 2
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }

  private cableExitLocal(): THREE.Vector3 {
    return new THREE.Vector3(-0.036, 0.021, -BASE_D / 2 + 0.0008)
  }

  /**
   * Cabo: sai da traseira, cai em catenária até a mesa, vira espiral por
   * ~10 cm e termina num plugue DE-9 deitado, apontando para a lateral da
   * unidade principal. Tudo montado em coordenadas de mundo e convertido para
   * o espaço local do grupo, para que girar o joystick não torça o cabo.
   */
  private buildCable(group: THREE.Group, mats: JoystickMaterials): THREE.Group {
    const holder = new THREE.Group()
    holder.name = 'joystick-cabo'

    const world = (v: THREE.Vector3): THREE.Vector3 => group.localToWorld(v.clone())
    const local = (v: THREE.Vector3): THREE.Vector3 => group.worldToLocal(v.clone())

    // Sai exatamente na ponta do passa-cabo traseiro.
    const start = world(this.cableExitLocal().add(new THREE.Vector3(0, 0, -0.0157)))
    const deskTouch = new THREE.Vector3(0.296, CABLE_R + 0.0012, -0.096)

    // 1) Queda em catenária da saída até tocar a mesa.
    const drop = catenary(start, deskTouch, 0.009, 34, CABLE_R + 0.0009)

    // 2) Alma do trecho espiralado, deitada sobre a mesa (altura = raio da espiral).
    const coilY = COIL_R + CABLE_R + 0.0004
    const coilSpine = sampleSpline(
      [
        deskTouch,
        new THREE.Vector3(0.2935, coilY * 0.7, -0.114),
        new THREE.Vector3(0.2905, coilY, -0.136),
        new THREE.Vector3(0.2785, coilY, -0.178),
        new THREE.Vector3(0.2685, coilY, -0.212),
        new THREE.Vector3(0.2625, coilY * 0.8, -0.23),
      ],
      // ~26 voltas no trecho: precisa de ≥20 amostras por volta para a hélice
      // não facetar sob luz rasante.
      600,
    )

    // 3) Rabicho até o plugue, de novo rente à mesa. O plugue fica na direita
    //    da unidade principal (x ≥ 0,25, contra a borda dela em x = 0,20) —
    //    perto o bastante para ler como "indo para a máquina", longe o bastante
    //    para nunca invadir a geometria de outro módulo.
    const plugTail = new THREE.Vector3(0.2515, 0.0076, -0.1905)
    const tail = sampleSpline(
      [
        at(coilSpine, coilSpine.length - 1),
        new THREE.Vector3(0.2565, CABLE_R + 0.001, -0.2355),
        new THREE.Vector3(0.2545, CABLE_R + 0.0016, -0.2155),
        plugTail,
      ],
      56,
    )

    const spine: THREE.Vector3[] = []
    for (const p of drop) spine.push(p)
    for (let i = 1; i < coilSpine.length; i++) spine.push(at(coilSpine, i))
    for (let i = 1; i < tail.length; i++) spine.push(at(tail, i))

    relax(spine, 14, 0.4)

    // A espiral é varrida em volta da alma com raio COIL_R, então a volta de baixo
    // fica COIL_R + CABLE_R abaixo dela: onde a alma ainda está subindo do ponto de
    // toque para a altura de repouso, essa volta furava a mesa. Medido na malha
    // servida, o cabo descia a −3,5 mm com o tampo em −0,25 mm, na entrada e na saída
    // do trecho (os pontos de controle em `coilY * 0,7` e `coilY * 0,8`).
    //
    // O começo e o fim da espiral saem da geometria em vez de um deslocamento fixo:
    // ela só existe onde a alma está alta o bastante para acomodá-la. Assim o piso
    // vale como invariante — mexer nos pontos de controle depois não reabre o furo —
    // e nada precisa ser dobrado à força, que deixaria uma quina onde cabo de
    // borracha não faz quina.
    const coilFloor = COIL_R + CABLE_R + 0.0004
    const coilLast = drop.length + coilSpine.length - 14
    let coilFrom = drop.length + 10
    while (coilFrom < coilLast && at(spine, coilFrom).y < coilFloor - 1e-6) coilFrom++
    let coilTo = coilLast
    while (coilTo > coilFrom && at(spine, coilTo).y < coilFloor - 1e-6) coilTo--

    const frames = parallelTransport(spine)
    const coiled = coilAroundSpine(spine, frames, { from: coilFrom, to: coilTo })

    // Tudo foi montado no mundo; leva para o espaço do grupo. Como o grupo só
    // translada e gira em Y, a rotação inversa basta para os referenciais.
    const inverse = group.quaternion.clone().invert()
    const coiledFrames = parallelTransport(coiled)
    const localPoints = coiled.map(local)
    const localFrames: Frames = {
      tangents: coiledFrames.tangents.map((t) => t.clone().applyQuaternion(inverse)),
      normals: coiledFrames.normals.map((n) => n.clone().applyQuaternion(inverse)),
      binormals: coiledFrames.binormals.map((b) => b.clone().applyQuaternion(inverse)),
    }

    const tube = this.track(sweepTube(localPoints, localFrames, CABLE_R, 7))
    const cable = new THREE.Mesh(tube, mats.cable)
    cable.name = 'joystick-cabo-malha'
    cable.castShadow = true
    cable.receiveShadow = true
    cable.frustumCulled = false
    holder.add(cable)

    holder.add(this.buildPlug(mats, local(plugTail)))
    return holder
  }

  /**
   * Plugue DE-9 deitado na mesa, bico voltado para a lateral da unidade
   * principal. A origem do grupo é a **ponta do passa-cabo**, exatamente onde o
   * tubo do cabo termina; o corpo cresce para −x (rumo à máquina).
   */
  private buildPlug(mats: JoystickMaterials, tailLocal: THREE.Vector3): THREE.Group {
    const plug = new THREE.Group()
    plug.name = 'joystick-plugue'
    plug.position.copy(tailLocal)
    // Cancela o giro do grupo: o plugue aponta para −x no mundo.
    plug.rotation.y = -(this.options.rotationY ?? DEFAULT_ROTATION_Y)

    // Shape em XY extrudada em +Z; `rotateY(+90°)` põe a extrusão no eixo +x,
    // a largura da shape em z e a altura em y.
    const bodyShape = roundedRectForBevel(0.0215, 0.0138, 0.0028, 0.0012)
    const bodyGeom = this.track(
      new THREE.ExtrudeGeometry(bodyShape, {
        depth: 0.026,
        bevelEnabled: true,
        bevelThickness: 0.0012,
        bevelSize: 0.0011,
        bevelOffset: 0,
        bevelSegments: 2,
        curveSegments: 6,
      }),
    )
    bodyGeom.rotateY(Math.PI / 2)
    const body = new THREE.Mesh(bodyGeom, mats.plugShell)
    body.name = 'joystick-plugue-corpo'
    body.position.set(-0.0365, 0, 0)
    body.castShadow = true
    body.receiveShadow = true
    plug.add(body)

    // Capa metálica trapezoidal (o "D" do DE-9), no bico.
    const dShape = new THREE.Shape()
    dShape.moveTo(-0.0086, -0.0042)
    dShape.lineTo(0.0086, -0.0042)
    dShape.lineTo(0.0072, 0.0042)
    dShape.lineTo(-0.0072, 0.0042)
    dShape.closePath()
    const shroudGeom = this.track(
      new THREE.ExtrudeGeometry(dShape, {
        depth: 0.0074,
        bevelEnabled: true,
        bevelThickness: 0.0005,
        bevelSize: 0.0005,
        bevelOffset: 0,
        bevelSegments: 1,
        curveSegments: 1,
      }),
    )
    shroudGeom.rotateY(Math.PI / 2)
    const shroud = new THREE.Mesh(shroudGeom, mats.shaft)
    shroud.name = 'joystick-plugue-capa'
    shroud.position.set(-0.0437, 0, 0)
    shroud.castShadow = true
    shroud.receiveShadow = true
    plug.add(shroud)

    // Passa-cabo traseiro: eixo do lathe girado de +y para +x.
    const reliefProfile: THREE.Vector2[] = [
      new THREE.Vector2(0.0062, 0),
      new THREE.Vector2(0.006, 0.004),
      new THREE.Vector2(0.0045, 0.0074),
      new THREE.Vector2(0.0034, 0.0101),
      new THREE.Vector2(0.0022, 0.0105),
    ]
    const reliefGeom = this.track(new THREE.LatheGeometry(reliefProfile, 18))
    reliefGeom.computeVertexNormals()
    const relief = new THREE.Mesh(reliefGeom, mats.boot)
    relief.name = 'joystick-plugue-passa-cabo'
    relief.position.set(-0.0105, 0, 0)
    relief.rotation.z = -Math.PI / 2
    relief.castShadow = true
    relief.receiveShadow = true
    plug.add(relief)

    return plug
  }

  // ── Deflexão ───────────────────────────────────────────────────────────────────

  /**
   * Aplica a deflexão corrente: gira o pivô e redeforma a sanfona. A base da
   * sanfona fica presa ao painel, o topo acompanha a haste (s(1) = 1) e o lado
   * comprimido incha, como borracha sanfonada de verdade.
   */
  private applyDeflection(force: boolean): void {
    const x = this.tiltX.value
    const y = this.tiltY.value
    if (!force && Math.abs(x - this.appliedX) < 1e-5 && Math.abs(y - this.appliedY) < 1e-5) return
    this.appliedX = x
    this.appliedY = y

    const magnitude = Math.min(1, Math.hypot(x, y))
    const angle = magnitude * this.maxTilt

    // Direção horizontal da inclinação: +y do input empurra o manche para −z.
    const dirX = magnitude > 1e-6 ? x / magnitude : 0
    const dirZ = magnitude > 1e-6 ? -y / magnitude : 0
    const axis = deflectionAxis.set(dirZ, 0, -dirX)
    if (axis.lengthSq() < 1e-12) axis.set(1, 0, 0)
    else axis.normalize()

    const pivot = this.stickPivot
    if (pivot) pivot.quaternion.setFromAxisAngle(axis, angle)

    const geometry = this.gaiterGeometry
    const rest = this.gaiterRest
    if (!geometry || !rest) return

    const position = geometry.getAttribute('position')
    // Pivô em coordenadas da sanfona: ela nasce no painel, o pivô está abaixo.
    const pivotY = PIVOT_Y - DECK_TOP
    const quaternion = deflectionQuaternion
    const point = deflectionPoint

    for (let i = 0; i < position.count; i++) {
      const rx = rest[i * 3] ?? 0
      const ry = rest[i * 3 + 1] ?? 0
      const rz = rest[i * 3 + 2] ?? 0

      const t = clamp(ry / GAITER_H, 0, 1)
      // s(1) = 1 garante que o topo gire exatamente como a haste.
      const s = Math.pow(t, 1.4)

      let bx = rx
      let bz = rz
      const radius = Math.hypot(rx, rz)
      if (radius > 1e-6 && magnitude > 1e-4) {
        // Lado comprimido (para onde o manche pende) dobra a sanfona para fora.
        const side = (rx * dirX + rz * dirZ) / radius
        const bulge = 1 + 0.28 * Math.sin(Math.PI * t) * magnitude * side
        bx = rx * bulge
        bz = rz * bulge
      }

      quaternion.setFromAxisAngle(axis, angle * s)
      point.set(bx, ry - pivotY, bz).applyQuaternion(quaternion)
      position.setXYZ(i, point.x, point.y + pivotY, point.z)
    }
    position.needsUpdate = true
    geometry.computeVertexNormals()
  }
}

interface JoystickMaterials {
  readonly shell: THREE.MeshPhysicalMaterial
  readonly deck: THREE.MeshPhysicalMaterial
  readonly well: THREE.MeshPhysicalMaterial
  readonly ball: THREE.MeshPhysicalMaterial
  readonly button: THREE.MeshPhysicalMaterial
  readonly stripe: THREE.MeshPhysicalMaterial
  readonly boot: THREE.MeshPhysicalMaterial
  readonly cup: THREE.MeshPhysicalMaterial
  readonly cable: THREE.MeshPhysicalMaterial
  readonly shaft: THREE.MeshPhysicalMaterial
  readonly plugShell: THREE.MeshPhysicalMaterial
}

/** Instância única registrada pelo `main.ts`. */
export const joystick = new Joystick()

export default joystick
