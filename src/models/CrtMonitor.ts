/**
 * Monitor CRT de época (~14", vídeo composto) — o display que o Gradiente Expert
 * XP-800 aciona.
 *
 * O que faz um tubo parecer um tubo, e por que cada peça existe aqui:
 *
 *  1. **A curvatura está na GEOMETRIA, não num shader.** A face é uma superfície
 *     abaulada real (sagita de ~24 mm do centro ao canto). É a silhueta que
 *     denuncia um "CRT falso": um plano com barril no fragment shader lê como
 *     adesivo assim que a câmera sai da normal.
 *  2. **Fósforo e vidro são malhas separadas**, 13 mm de paralaxe entre elas. Esse
 *     deslocamento é o que dá profundidade ao raster quando a câmera orbita — o
 *     efeito mais barato e mais convincente do conjunto.
 *  3. **O vidro reflete o ambiente** (SPEC §5.8, inegociável): `crtGlass()` com
 *     clearcoat + transmissão, sobre a IBL procedural do estúdio.
 *  4. **A moldura afunila até o vidro.** O anel interno do bezel segue a sagita da
 *     face ponto a ponto, então o funil é fundo nos cantos (~21 mm) e raso no topo
 *     (~7 mm) — exatamente como uma moldura injetada em cima de um tubo real.
 *  5. **A tela emite luz de verdade** na cena, via `LightingRig.setScreenLight()`,
 *     com rampa de aquecimento (SPEC §8: nunca liga instantaneamente).
 *
 * Geometria e texturas 100 % procedurais (AGENTS.md §2). Nada é baixado.
 *
 * Contrato para os outros módulos: importe `crtMonitorModule` (a mesma instância
 * que o `main.ts` registra) e use `screenMesh` / `setScreenTexture()` para plugar
 * o framebuffer do emulador, e `setPower()` para a sequência de energia.
 */

import * as THREE from 'three'

import { yieldToMain } from '../core/cooperative'
import type {
  InteractiveUserData,
  MaterialLibrary,
  ModuleContext,
  PowerState,
  SceneModule,
} from '../core/types'
import { lightingModule } from '../core/Lighting'
import { catenary } from '../interaction/Physics'
import { dustAccumulationAsync, silkscreenDecalAsync } from '../textures/procedural'

// ---------------------------------------------------------------------------
// Dimensões (m). SPEC §1: 1 unidade = 1 m, Y para cima, mesa em y = 0.
// ---------------------------------------------------------------------------

/**
 * Todas as medidas do gabinete vivem no **referencial H**: origem no centro da
 * face frontal do bezel, +Z para o observador, +Y para cima. O grupo `tilt`
 * leva esse referencial para a mesa.
 */
const DIM = {
  /** Frente do gabinete = contorno externo do bezel. */
  front: { halfW: 0.186, halfH: 0.15, corner: 0.02 },
  /** Profundidade da carcaça, da face frontal até a tampa traseira. */
  depth: 0.365,
  /** Quanto o traseiro encolhe em relação à frente. Traseira ≈ 63 % da frente. */
  taper: { width: 0.068, top: 0.042, bottom: 0.022, cornerGain: 0.018, knee: 0.1 },
  /** Abertura do bezel — o buraco por onde se vê o tubo. */
  aperture: { halfW: 0.143, halfH: 0.108, corner: 0.03, offsetY: 0.018 },
  /** Raster visível (4:3, ~13,2" na diagonal). É o que recebe a textura. */
  raster: { halfW: 0.134, halfH: 0.1005 },
  /** Faceplate: o vidro extrapola a abertura e some atrás do bezel. */
  glass: { halfW: 0.152, halfH: 0.117, corner: 0.038, apexZ: 0.002, thickness: 0.013 },
  /**
   * Curvatura da face. Raios em m; `rim` acelera a queda junto à borda (um
   * faceplate real não é esfera pura). Calibrado para ~24 mm de sagita do centro
   * ao canto da abertura, ~15 mm no meio da lateral e ~9 mm no topo — a barriga
   * de um tubo de 14" de 1985.
   *
   * Os dois raios são **iguais** e isso não é preguiça: a face de um TRC é
   * esférica, e com 0,70 × 0,95 a sagita horizontal ficava 2,4× a vertical. Como
   * a barriga da malha é o que curva a borda projetada do raster, o resultado
   * media 7 % de arqueamento vertical contra 1,9 % de horizontal e o tubo lia
   * como um cilindro dobrado no eixo horizontal, não como um bulbo.
   */
  face: { radiusX: 0.77, radiusY: 0.77, rim: 0.1 },
  /**
   * Pedestal giratório. `top` = altura da base do gabinete acima da mesa;
   * dimensionada para o queixo (e os botões) passarem por cima da unidade
   * principal, que tem 0,092 m — senão os controles somem numa vista frontal.
   */
  base: { halfW: 0.148, halfD: 0.142, corner: 0.018, slab: 0.026, footH: 0.004, top: 0.07 },
  /** Bacia de ventilação no tampo. */
  vent: { zFront: -0.135, zBack: -0.29, halfW: 0.128, depth: 0.0062, ribs: 15 },
  /**
   * Junção moldura/casca. `z` é onde a fresta corre (bem atrás da face, onde a
   * concha frontal termina), `width` a largura da ranhura e `depth` o recuo.
   */
  seam: { z: -0.062, width: 0.0009, depth: 0.00045 },
  /** Inclinação para cima do conjunto, em graus (base tilt-swivel). */
  tiltDeg: 3,
  /** Pivô da inclinação, no referencial do módulo (mesa em y = 0). */
  pivot: { y: 0.048, z: -0.145 },
  /**
   * Posição na cena: atrás da unidade principal, na mesa.
   *
   * A unidade principal termina em z = −0.2275 (0,305 m de profundidade nominal
   * a partir de z = +0.0775), e o cabo de força sai por trás dela até −0.297.
   * A −0.30 o vidro do monitor ficava a 5 cm da traseira do console — o cabo
   * passava rente ao gabinete e não sobrava vão nenhum para olhar o painel
   * traseiro. A −0.44 o vão livre é de ~19 cm: o cabo tem por onde sair, a
   * câmera cabe entre as duas peças e a mesa lê como uma mesa de verdade.
   */
  place: { x: 0, y: 0, z: -0.465 },
  /**
   * Escala global do conjunto (pedido do usuário: monitor maior e mais presente).
   * 1,16 leva o tubo de ~13,2" para ~15,3" e a frente de 0,372 m para ~0,43 m —
   * proporção típica de um monitor de vídeo-composto de 1985 sobre um console de
   * 0,40 m. O recuo extra de `place.z` (−0,44 → −0,465) devolve o vão traseiro
   * que o crescimento em profundidade consome.
   */
  scale: 1.16,
} as const

/** Segmentos ao redor do perímetro. Governa o facetamento dos cantos arredondados. */
const PERIM_SEGMENTS = 288
/** Resolução da grade da face curva (vidro e fósforo). */
const FACE_GRID = { x: 80, y: 60 } as const
/** Ladrilhos de textura por metro — calibrado com `Materials.ts` (repeat 6 em 0,40 m). */
const TILES_PER_METRE = 15

/** Superexploração do raster: um CRT sempre corta um pouco da borda do quadro. */
const OVERSCAN = { u: 0.988, v: 0.982 } as const

/** Constantes de tempo da sequência de energia (s). */
const WARMUP = { rise: 1.45, fall: 0.16 } as const

/**
 * Ganho do derramamento da tela sobre o que o rig de iluminação chama de "1".
 *
 * `BASE.screen` do rig vale 4,5 nits sobre 0,027 m² de raster, contra 10,6 nits
 * sobre 0,96 m² da luz principal: 1,2 % do fluxo. Um tubo de 14" de verdade
 * marca 80–150 cd/m², e num set escuro ele é uma fonte de primeira grandeza —
 * daí a medição da revisão de que "o TRC não é uma fonte de luz". Este ganho
 * recoloca a proporção física sem mexer no rig, que é de outro módulo.
 */
const SCREEN_LIGHT_GAIN = 6.0

/** Inclinação do emissor da tela, em radianos. Ver `parkScreenLight`. */
const SCREEN_LIGHT_TILT = 0.28

interface FrameAverage {
  r: number
  g: number
  b: number
}

/** Média de quadro nula — devolvida quando ainda não há leitura da GPU. */
const ZERO_AVERAGE: Readonly<FrameAverage> = Object.freeze({ r: 0, g: 0, b: 0 })

// ---------------------------------------------------------------------------
// Utilidades numéricas
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * Rampa suave, **com suporte a arestas invertidas**: `smoothstep(a, b, x)` com
 * `a > b` devolve uma rampa descendente (1 antes de `b`, 0 depois de `a`).
 *
 * A versão do GLSL deixa esse caso indefinido, e a primeira implementação aqui
 * o transformava num degrau invertido — o que apagou silenciosamente a bacia de
 * ventilação e as estrias dos botões. Rampa invertida é legítima e frequente;
 * o helper suporta explicitamente.
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  if (edge1 < edge0) return 1 - smoothstep(edge1, edge0, x)
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function at(array: Float32Array, index: number): number {
  return array[index] ?? 0
}

// ---------------------------------------------------------------------------
// Contornos e superfícies
// ---------------------------------------------------------------------------

interface Segment {
  readonly len: number
  point(u: number): readonly [number, number]
}

/**
 * Amostra o contorno de um retângulo arredondado **em comprimento de arco
 * constante**, começando no meio da aresta direita e girando no sentido
 * anti-horário. Amostrar por ângulo deixaria os cantos facetados; por arco, a
 * densidade é uniforme e o canto fica liso com poucos segmentos.
 *
 * O último ponto repete o primeiro: a costura de UV precisa de duas colunas.
 */
function roundedRectRing(
  halfW: number,
  halfH: number,
  radius: number,
  segments: number,
  centreY = 0,
): Float32Array {
  const r = Math.max(0, Math.min(radius, Math.min(halfW, halfH) - 1e-5))
  const ax = halfW - r
  const ay = halfH - r
  const quarter = (Math.PI * r) / 2
  const arc = (from: number): Segment => ({
    len: quarter,
    point: (u: number) => {
      const a = from + (u * Math.PI) / 2
      const cx = Math.cos(from + Math.PI / 4) >= 0 ? ax : -ax
      const cy = Math.sin(from + Math.PI / 4) >= 0 ? ay : -ay
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
    },
  })

  const segs: readonly Segment[] = [
    { len: ay, point: (u) => [halfW, u * ay] },
    arc(0),
    { len: 2 * ax, point: (u) => [ax - u * 2 * ax, halfH] },
    arc(Math.PI / 2),
    { len: 2 * ay, point: (u) => [-halfW, ay - u * 2 * ay] },
    arc(Math.PI),
    { len: 2 * ax, point: (u) => [-ax + u * 2 * ax, -halfH] },
    arc(1.5 * Math.PI),
    { len: ay, point: (u) => [halfW, -ay + u * ay] },
  ]

  let total = 0
  for (const s of segs) total += s.len

  const out = new Float32Array((segments + 1) * 2)
  let index = 0
  let base = 0
  for (let i = 0; i <= segments; i++) {
    const d = (i / segments) * total
    while (index < segs.length - 1) {
      const seg = segs[index]
      if (seg === undefined) break
      if (base + seg.len >= d - 1e-9) break
      base += seg.len
      index++
    }
    const seg = segs[index] ?? segs[segs.length - 1]
    if (seg === undefined) break
    const u = seg.len > 1e-9 ? clamp01((d - base) / seg.len) : 0
    const [x, y] = seg.point(u)
    out[i * 2] = x
    out[i * 2 + 1] = y + centreY
  }
  return out
}

/** Interpola dois anéis com a mesma contagem de colunas. */
function lerpRing(a: Float32Array, b: Float32Array, t: number): Float32Array {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = at(a, i) + (at(b, i) - at(a, i)) * t
  return out
}

/**
 * Sagita da face do tubo: quanto a superfície **recua** em relação ao ápice.
 * Aproximação paraxial de dois raios + um termo de 4ª ordem que acelera a queda
 * junto à borda, como num faceplate real (a curvatura não é esférica pura).
 */
function faceSag(x: number, y: number): number {
  const base = (x * x) / (2 * DIM.face.radiusX) + (y * y) / (2 * DIM.face.radiusY)
  const nx = x / DIM.glass.halfW
  const ny = y / DIM.glass.halfH
  const rim = DIM.face.rim * (nx * nx * nx * nx + ny * ny * ny * ny)
  return base * (1 + rim)
}

/** Z da superfície externa do vidro (`y` já relativo ao centro da abertura). */
function glassZ(x: number, yLocal: number): number {
  return DIM.glass.apexZ - faceSag(x, yLocal)
}

/** Z da superfície interna (plano do fósforo). O paralaxe que vende o tubo. */
function phosphorZ(x: number, yLocal: number): number {
  return glassZ(x, yLocal) - DIM.glass.thickness
}

// ---------------------------------------------------------------------------
// Construtores de malha
// ---------------------------------------------------------------------------

/**
 * Costura uma pilha de anéis (mesma contagem de colunas) numa casca.
 *
 * UVs são **métricos** — u = comprimento de arco, v = distância percorrida entre
 * anéis, ambos em metros. Isso mantém a densidade do grão constante em peças de
 * tamanhos muito diferentes; os materiais compensam com `retile()`.
 */
function loft(rings: readonly Float32Array[]): THREE.BufferGeometry {
  const rows = rings.length
  const first = rings[0]
  if (first === undefined || rows < 2) return new THREE.BufferGeometry()
  const cols = first.length / 3

  const position = new Float32Array(rows * cols * 3)
  const uv = new Float32Array(rows * cols * 2)
  const vAcc = new Float32Array(cols)

  for (let r = 0; r < rows; r++) {
    const ring = rings[r]
    if (ring === undefined) continue
    const prev = r > 0 ? rings[r - 1] : undefined
    let arc = 0
    for (let c = 0; c < cols; c++) {
      const x = at(ring, c * 3)
      const y = at(ring, c * 3 + 1)
      const z = at(ring, c * 3 + 2)
      if (c > 0) {
        const dx = x - at(ring, (c - 1) * 3)
        const dy = y - at(ring, (c - 1) * 3 + 1)
        const dz = z - at(ring, (c - 1) * 3 + 2)
        arc += Math.sqrt(dx * dx + dy * dy + dz * dz)
      }
      if (prev !== undefined) {
        const dx = x - at(prev, c * 3)
        const dy = y - at(prev, c * 3 + 1)
        const dz = z - at(prev, c * 3 + 2)
        vAcc[c] = at(vAcc, c) + Math.sqrt(dx * dx + dy * dy + dz * dz)
      }
      const i = r * cols + c
      position[i * 3] = x
      position[i * 3 + 1] = y
      position[i * 3 + 2] = z
      uv[i * 2] = arc
      uv[i * 2 + 1] = at(vAcc, c)
    }
  }

  const index: number[] = []
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c
      const b = a + 1
      const d = a + cols
      const e = d + 1
      index.push(a, d, b, b, d, e)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

/** Eleva um anel 2D (xy) para 3D aplicando uma função de profundidade. */
function raise(ring2d: Float32Array, z: (x: number, y: number) => number): Float32Array {
  const cols = ring2d.length / 2
  const out = new Float32Array(cols * 3)
  for (let c = 0; c < cols; c++) {
    const x = at(ring2d, c * 2)
    const y = at(ring2d, c * 2 + 1)
    out[c * 3] = x
    out[c * 3 + 1] = y
    out[c * 3 + 2] = z(x, y)
  }
  return out
}

/**
 * Grade retangular abaulada — a face do tubo. `zAt` recebe coordenadas locais
 * relativas ao centro da abertura.
 */
function bulgedGrid(
  halfW: number,
  halfH: number,
  segX: number,
  segY: number,
  zAt: (x: number, y: number) => number,
  uvOverscan: { readonly u: number; readonly v: number } | null,
): THREE.BufferGeometry {
  const cols = segX + 1
  const rows = segY + 1
  const position = new Float32Array(cols * rows * 3)
  const uv = new Float32Array(cols * rows * 2)

  for (let j = 0; j < rows; j++) {
    const sy = j / segY
    const y = (sy - 0.5) * 2 * halfH
    for (let i = 0; i < cols; i++) {
      const sx = i / segX
      const x = (sx - 0.5) * 2 * halfW
      const k = j * cols + i
      position[k * 3] = x
      position[k * 3 + 1] = y
      position[k * 3 + 2] = zAt(x, y)
      if (uvOverscan !== null) {
        uv[k * 2] = 0.5 + (sx - 0.5) * uvOverscan.u
        uv[k * 2 + 1] = 0.5 + (sy - 0.5) * uvOverscan.v
      } else {
        uv[k * 2] = sx
        uv[k * 2 + 1] = sy
      }
    }
  }

  // Enrolamento anti-horário visto de +Z: a face olha para o observador.
  const index: number[] = []
  for (let j = 0; j < segY; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * cols + i
      const b = a + 1
      const c = a + cols
      const d = c + 1
      index.push(a, b, c, b, d, c)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * Tampa um anel com um leque de triângulos até o centro informado.
 * `flip` inverte o enrolamento — a tampa traseira olha para −Z, ao contrário do
 * anel, que é gerado no sentido anti-horário visto de +Z.
 */
function capRing(
  ring3d: Float32Array,
  cx: number,
  cy: number,
  cz: number,
  flip: boolean,
): THREE.BufferGeometry {
  const cols = ring3d.length / 3
  const position = new Float32Array((cols + 1) * 3)
  const uv = new Float32Array((cols + 1) * 2)
  position[0] = cx
  position[1] = cy
  position[2] = cz
  uv[0] = 0
  uv[1] = 0
  for (let c = 0; c < cols; c++) {
    const x = at(ring3d, c * 3)
    const y = at(ring3d, c * 3 + 1)
    position[(c + 1) * 3] = x
    position[(c + 1) * 3 + 1] = y
    position[(c + 1) * 3 + 2] = at(ring3d, c * 3 + 2)
    uv[(c + 1) * 2] = x - cx
    uv[(c + 1) * 2 + 1] = y - cy
  }
  const index: number[] = []
  for (let c = 0; c < cols - 1; c++) {
    if (flip) index.push(0, c + 2, c + 1)
    else index.push(0, c + 1, c + 2)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

/** `Shape` de retângulo arredondado, para peças extrudadas (base, molduras). */
function roundedShape(halfW: number, halfH: number, radius: number): THREE.Shape {
  const r = Math.max(0, Math.min(radius, Math.min(halfW, halfH) - 1e-5))
  const shape = new THREE.Shape()
  shape.moveTo(-halfW + r, -halfH)
  shape.lineTo(halfW - r, -halfH)
  shape.quadraticCurveTo(halfW, -halfH, halfW, -halfH + r)
  shape.lineTo(halfW, halfH - r)
  shape.quadraticCurveTo(halfW, halfH, halfW - r, halfH)
  shape.lineTo(-halfW + r, halfH)
  shape.quadraticCurveTo(-halfW, halfH, -halfW, halfH - r)
  shape.lineTo(-halfW, -halfH + r)
  shape.quadraticCurveTo(-halfW, -halfH, -halfW + r, -halfH)
  return shape
}

/**
 * Placa de cantos arredondados e arestas chanfradas, deitada no plano XZ
 * (espessura em Y, base em y = 0).
 */
function roundedSlab(
  halfW: number,
  halfD: number,
  height: number,
  corner: number,
  bevel: number,
): THREE.BufferGeometry {
  const b = Math.min(bevel, height / 2 - 1e-4)
  const geometry = new THREE.ExtrudeGeometry(roundedShape(halfW - b, halfD - b, corner), {
    depth: height - 2 * b,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 3,
    curveSegments: 16,
    steps: 1,
  })
  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, b, 0)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * Botão estriado de época: cilindro com ondulação radial (as estrias que o dedo
 * pega), topo levemente rebaixado e um flange na base.
 */
function knobGeometry(radius: number, height: number, flutes: number): THREE.BufferGeometry {
  const segments = flutes * 4
  const profile: Array<readonly [number, number]> = [
    [radius * 0.62, 0],
    [radius * 1.0, 0.0012],
    [radius * 1.0, height * 0.16],
    [radius * 0.94, height * 0.22],
    [radius * 0.94, height * 0.86],
    [radius * 0.9, height * 0.95],
    [radius * 0.74, height],
    [radius * 0.66, height * 0.965],
    [0, height * 0.955],
  ]

  const rings: Float32Array[] = []
  for (const step of profile) {
    const [pr, py] = step
    const ring = new Float32Array((segments + 1) * 3)
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2
      // Estrias só na saia do botão; o topo permanece liso.
      const fluteMix = smoothstep(height * 0.9, height * 0.2, py)
      const ripple = 1 + 0.055 * fluteMix * Math.cos(a * flutes)
      ring[s * 3] = Math.cos(a) * pr * ripple
      ring[s * 3 + 1] = py
      ring[s * 3 + 2] = Math.sin(a) * pr * ripple
    }
    rings.push(ring)
  }
  const geometry = loft(rings)
  geometry.computeVertexNormals()
  return geometry
}

// ---------------------------------------------------------------------------
// Perfil da carcaça
// ---------------------------------------------------------------------------

/** 0 na frente, 1 no fundo. */
function taperEase(t: number): number {
  return smoothstep(DIM.taper.knee, 1, t)
}

function shellTop(t: number): number {
  return DIM.front.halfH - DIM.taper.top * taperEase(t)
}

function shellBottom(t: number): number {
  return -DIM.front.halfH + DIM.taper.bottom * taperEase(t)
}

function shellHalfW(t: number): number {
  return DIM.front.halfW - DIM.taper.width * taperEase(t)
}

function shellCorner(t: number): number {
  return DIM.front.corner + DIM.taper.cornerGain * taperEase(t)
}

/** Meia-largura útil da bacia de ventilação naquela profundidade. */
function ventHalfW(t: number): number {
  return Math.min(DIM.vent.halfW, shellHalfW(t) - 0.02)
}

/**
 * Recuo radial da **linha de junção** entre a moldura frontal e a casca
 * traseira, em metros.
 *
 * Nenhum gabinete de TRC injetado em 1985 era uma peça só: eram duas conchas
 * atarraxadas, e a fresta entre elas corre em volta de todo o perímetro. Sem ela
 * o monitor lê como um bloco fresado — foi o que a revisão chamou de "nada aqui
 * tem 41 anos". A fresta é geometria de verdade (0,7 mm de largura, 0,45 mm de
 * fundo), então recebe AO e sombra em vez de ser uma linha pintada.
 */
function partingSeamInset(z: number): number {
  const half = DIM.seam.width / 2
  const d = Math.abs(z - DIM.seam.z)
  if (d >= half) return 0
  // Perfil em V com fundo chato: é o que uma fresta de duas conchas mostra.
  return DIM.seam.depth * smoothstep(half, half * 0.35, d)
}

/** Inclinação do tampo (dy/dz) — usada para assentar as aletas rentes à casca. */
function deckSlope(z: number): number {
  const h = 0.002
  const t0 = clamp01(-(z + h) / DIM.depth)
  const t1 = clamp01(-(z - h) / DIM.depth)
  return (shellTop(t1) - shellTop(t0)) / (2 * h)
}

/**
 * Rebaixo do tampo onde ficam as fendas de ventilação. Em vez de furar a casca
 * (caro e frágil), afundamos a aresta superior numa bacia rasa: as aletas
 * atravessam por cima e as frestas mostram o fundo escuro 6 mm abaixo. Do lado
 * de fora é indistinguível de fendas usinadas — e ninguém enxerga o interior de
 * um monitor mesmo.
 */
function ventBasinDrop(x: number, y: number, z: number, t: number): number {
  const top = shellTop(t)
  const topness = smoothstep(top - 0.013, top - 0.002, y)
  if (topness <= 0) return 0
  const half = ventHalfW(t)
  const acrossX = smoothstep(half, half - 0.008, Math.abs(x))
  const alongZ =
    smoothstep(DIM.vent.zFront, DIM.vent.zFront - 0.006, z) *
    smoothstep(DIM.vent.zBack, DIM.vent.zBack + 0.006, z)
  return DIM.vent.depth * topness * acrossX * alongZ
}

// ---------------------------------------------------------------------------
// Shader da tela
// ---------------------------------------------------------------------------

interface ScreenUniforms {
  readonly uBrightness: { value: number }
  readonly uContrast: { value: number }
  readonly uWarmth: { value: number }
  readonly uVignette: { value: number }
  /** Profundidade da máscara de sombra, 0..1. */
  readonly uMask: { value: number }
  /** Tríades RGB ao longo da largura do raster (passo físico da máscara). */
  readonly uMaskTriads: { value: number }
  /** Profundidade das linhas de varredura, 0..1. */
  readonly uScan: { value: number }
  /** Linhas do campo ao longo da altura do raster. */
  readonly uScanLines: { value: number }
  /** Granulação do fósforo, 0..1. */
  readonly uGrain: { value: number }
  /** Pincushion do jugo — o **mesmo** valor do passe de tubo, ver `uWarp`. */
  readonly uWarp: { value: number }
  /** `renderer.toneMappingExposure`, lido a cada frame. */
  readonly uExposure: { value: number }
  /** Compensação da transmitância do faceplate (>1). Calibrada por medição. */
  readonly uThroughGlass: { value: number }
  /** Meia-extensão física (m) que o UV 0..1 cobre — para o SDF de canto. */
  readonly uRasterHalf: { value: THREE.Vector2 }
  /** Raio do canto do raster, em metros. */
  readonly uRasterCorner: { value: number }
  /** Nível de preto do fósforo apagado, em espaço de exibição (sRGB 0..1). */
  readonly uDeadFloor: { value: THREE.Color }
}

/**
 * Estrutura do fósforo — a parte do pipeline (SPEC §5.3–5.4) que **precisa**
 * morar aqui e não no alvo fora de tela: máscara e varredura são grades finas,
 * e uma grade só pode ser desenhada sem moiré se o shader souber quantos pixels
 * de tela sobram para cada período dela. Isso é `fwidth( vMapUv )`, que existe
 * na superfície e não existe num passe fullscreen cujo resultado ainda vai ser
 * reduzido para a área do monitor.
 *
 * O critério de desenho é o mesmo que a física impõe: abaixo de ~1,3 px por
 * tríade a máscara vira ruído, então ela some — que é exatamente o que
 * acontece quando você se afasta de um tubo de verdade. Os dois padrões são
 * normalizados pela própria média, então acender a estrutura não escurece a
 * imagem: redistribui a mesma luz em picos e vales, e os picos passam de 1.0
 * para alimentar o bloom.
 */
const SCREEN_UNIFORMS = /* glsl */ `
uniform float uBrightness;
uniform float uContrast;
uniform float uWarmth;
uniform float uVignette;
uniform float uMask;
uniform float uMaskTriads;
uniform float uScan;
uniform float uScanLines;
uniform float uGrain;
uniform float uWarp;
uniform float uExposure;
uniform float uThroughGlass;
uniform vec2 uRasterHalf;
uniform float uRasterCorner;
uniform vec3 uDeadFloor;

/** Proporção da face (4:3). O raio do pincushion é medido em unidades físicas. */
const float CRT_ASPECT = 1.3333333;
const float CRT_SQRT_TAU = 2.5066283;

/**
 * Pincushion do jugo — **idêntico** ao de "CrtShader.ts".
 *
 * Existe duplicado de propósito: a grade de varredura é solidária ao *raster*
 * (é o feixe que a desenha) enquanto a máscara de sombra é solidária ao
 * *vidro* (é uma chapa colada na face). Se as duas usassem a mesma coordenada,
 * uma das duas estaria fisicamente errada — e a que erra é a que produz o
 * batimento visível de meio período nas bordas.
 */
vec2 crtWarpUv( vec2 uv, float k ) {
  vec2 p = ( uv - 0.5 ) * vec2( CRT_ASPECT, 1.0 );
  float r2 = dot( p, p );
  float ref = 0.25 * CRT_ASPECT * CRT_ASPECT;
  float f = ( 1.0 + k * ( r2 + 0.32 * r2 * r2 ) ) / ( 1.0 + k * ( ref + 0.32 * ref * ref ) );
  return 0.5 + p * f / vec2( CRT_ASPECT, 1.0 );
}

// ---------------------------------------------------------------------------
// Resposta fotográfica do tubo, e o desfazimento da AgX
// ---------------------------------------------------------------------------
//
// O pós-processamento aplica AgX na cena inteira (SPEC §7). AgX é uma curva de
// 16,5 EV de latitude: ela comprime tudo o que passa de ~2 em linear e mistura
// canais nas matrizes de inset/outset. Duas consequências medidas na revisão:
// (1) nada na tela chegava a estourar — o branco parava em 207 — e sem recorte
// não existe halação; (2) o azul do TMS9918 saía com verde acima de vermelho,
// porque a linha do verde da matriz de inset carrega 0,101 de azul contra 0,048
// da linha do vermelho. Nenhum dos dois se resolve mexendo em brilho.
//
// A solução é fechar a cadeia aqui: a tela define explicitamente **como quer
// ser fotografada** (transferência sRGB com ombro, que faz um campo de paleta
// cair exatamente no seu hex) e depois inverte a AgX analiticamente, de modo
// que a AgX do pós devolva justo aquilo. As matrizes abaixo são as inversas
// exatas das de "three/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment".
// Se a three trocar a implementação da AgX, estas constantes têm de mudar com
// ela — é o preço de inverter uma curva de terceiros, e é um preço barato
// comparado a não ter recorte nenhum na imagem.

const mat3 CRT_SRGB_TO_R2020 = mat3(
  vec3( 0.6274, 0.0691, 0.0164 ),
  vec3( 0.3293, 0.9195, 0.0880 ),
  vec3( 0.0433, 0.0113, 0.8956 ) );
const mat3 CRT_R2020_TO_SRGB = mat3(
  vec3( 1.6605, -0.1246, -0.0182 ),
  vec3( -0.5876, 1.1329, -0.1006 ),
  vec3( -0.0728, -0.0083, 1.1187 ) );
const mat3 CRT_AGX_OUTSET_INV = mat3(
  vec3( 0.89979695591161, 0.11142098895748, 0.11142098895748 ),
  vec3( 0.08719961920284, 0.87557558615697, 0.08719961920284 ),
  vec3( 0.01300342488556, 0.01300342488555, 0.80137939183969 ) );
const mat3 CRT_AGX_INSET_INV = mat3(
  vec3( 1.19744107688770, -0.19647462632135, -0.14655741710660 ),
  vec3( -0.14426151269800, 1.35409513146973, -0.10828405878847 ),
  vec3( -0.05317956418970, -0.15762050514838, 1.25484147589507 ) );
const float CRT_AGX_MIN_EV = -12.47393;
const float CRT_AGX_EV_RANGE = 16.499999;

vec3 crtAgxSigmoid( vec3 x ) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
    + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

/**
 * Inverso do sigmoide da AgX por bisseção. 14 passos dão 6e-5 em x, o que vale
 * menos de 0,1 nível de exibição — e bisseção é monótona por construção, ao
 * contrário de Newton num polinômio de 6º grau perto das pontas, onde a
 * derivada cai para 0,12 e o passo explode.
 */
vec3 crtAgxSigmoidInverse( vec3 y ) {
  vec3 lo = vec3( 0.0 );
  vec3 hi = vec3( 1.0 );
  for ( int i = 0; i < 14; i++ ) {
    vec3 mid = 0.5 * ( lo + hi );
    vec3 under = step( crtAgxSigmoid( mid ), y );
    lo = mix( lo, mid, under );
    hi = mix( mid, hi, under );
  }
  return 0.5 * ( lo + hi );
}

/** Radiância que, passada pela AgX do pós, devolve exatamente "display". */
vec3 crtUndoAgX( vec3 display ) {
  vec3 c = CRT_SRGB_TO_R2020 * clamp( display, 0.0, 1.0 );
  c = pow( max( c, 0.0 ), vec3( 1.0 / 2.2 ) );
  c = clamp( CRT_AGX_OUTSET_INV * c, 0.0, 1.0 );
  c = crtAgxSigmoidInverse( c );
  c = exp2( c * CRT_AGX_EV_RANGE + CRT_AGX_MIN_EV );
  c = CRT_R2020_TO_SRGB * ( CRT_AGX_INSET_INV * c );
  // Cores muito saturadas exigem um canal levemente **negativo** — é assim que
  // se cancela o azul que a matriz de inset injeta no verde. O alvo é
  // half-float, então negativo é representável; o limite existe só para o caso
  // patológico (ciano puro pede −1,2) não virar franja em volta do raster.
  float top = max( max( c.r, c.g ), c.b );
  return max( c, vec3( -0.5 * max( top, 0.0 ) ) );
}

/**
 * Resposta fotográfica do tubo: identidade em luz linear, com ombro macio.
 *
 * "Identidade" é o ponto: o alvo é **linear**, porque quem codifica em sRGB é o
 * passe de saída do compositor. Um campo de paleta cujo sinal é
 * "srgbToLinear(hex)" atravessa isto sem mudar e sai da imagem valendo "hex" —
 * é o que a SPEC §5 exige. (Aplicar a transferência sRGB aqui, alimentando um
 * inverso que espera linear, foi o que fez o campo azul virar violeta: o
 * encode levanta 0,098 para 0,345 e destrói a razão entre os canais.)
 *
 * O ombro é o que dá headroom: o perfil do feixe multiplica o núcleo de um glifo
 * branco por ~1,2 e a máscara por mais 1,9, então o miolo passa de 2,0 e
 * **estoura** — que é a condição para existir halação.
 */
vec3 crtDisplay( vec3 signal ) {
  const float knee = 0.78;
  vec3 s = max( signal, 0.0 );
  vec3 over = max( s - knee, 0.0 );
  return min( s, vec3( knee ) ) + ( 1.0 - knee ) * ( 1.0 - exp( -over / ( 1.0 - knee ) ) );
}
`

const SCREEN_PATCH = /* glsl */ `
#ifdef USE_MAP
  {
    // "crt" é o **sinal**, linear, 0..~1,2. Tudo até "crtDisplay" acontece nesse
    // espaço: o feixe multiplica, a máscara multiplica, e nenhum dos dois soma
    // constante — subtrair era o que fazia a scanline desaparecer no canal azul
    // de um campo de 218 níveis e sobrar só nos canais escuros.
    vec3 crt = diffuseColor.rgb;
    // Os dois botões de um monitor de vídeo, com a função que eles têm no
    // circuito: CONTRASTE é ganho do sinal de vídeo, BRILHO é deslocamento do
    // nível de preto (corte do catodo). Não é detalhe de nomenclatura — a versão
    // anterior fazia contraste em torno de 0,5 *linear*, um pivô muito acima do
    // meio-tom real da imagem, então subir o contraste esmagava a tela inteira
    // para preto em vez de separar o texto branco do campo azul.
    crt = max( crt * uContrast + uBrightness, 0.0 ) * uWarmth;
    // Vinheta do tubo: o feixe perde eficiência longe do centro (SPEC §5.9).
    vec2 vc = vMapUv - 0.5;
    float rr = dot( vc, vc );
    crt *= 1.0 - uVignette * rr * ( 0.9 + 0.75 * rr );

    // --- Estrutura do fósforo -------------------------------------------------
    // Quantos pixels de quadro cabem numa unidade de UV, aqui, neste fragmento.
    float pxPerU = 1.0 / max( fwidth( vMapUv.x ), 1e-7 );
    float pxPerV = 1.0 / max( fwidth( vMapUv.y ), 1e-7 );
    float lumBeam = clamp( dot( crt, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.0, 1.0 );

    // Varredura: o feixe é uma gaussiana ao longo da vertical, normalizada para
    // integral 1 dentro de uma linha — o que a torna estritamente
    // multiplicativa e conservativa em energia. Sigma cresce com a corrente
    // (*beam blooming*): uma linha branca engorda e quase fecha o intervalo, uma
    // linha escura fica fina. É esse acoplamento, e não um seno fixo, que faz
    // texto claro parecer derretido no vídeo e o fundo continuar listrado.
    //
    // A coordenada é a **do raster** (com o pincushion do jugo aplicado), não a
    // do vidro: é o feixe que desenha a linha.
    float lineCoord = crtWarpUv( vMapUv, uWarp ).y * uScanLines;
    float linePx = pxPerV / uScanLines;
    float scanFade = smoothstep( 1.2, 2.6, linePx ) * uScan;
    if ( scanFade > 0.001 ) {
      // Sigma em unidades de passo de linha. Os números são pequenos por um
      // motivo aritmético: com passo 1, uma gaussiana de sigma 0,36 já está
      // praticamente uniforme (as caudas das linhas vizinhas preenchem o vale e
      // a modulação cai para 30 %). 0,19 dá ~180 % de oscilação bruta, que é o
      // necessário para **medir** 45–65 % depois da amostragem em ~4 px por linha.
      float sigma = mix( 0.19, 0.33, pow( lumBeam, 0.6 ) );
      // Pegada do pixel somada em quadratura: é a filtragem correta de um padrão
      // procedural: sem ela, um passo de 2,5 px bate contra a grade do monitor
      // do usuário e vira moiré em anéis.
      float sg = sqrt( sigma * sigma + 0.25 * fwidth( lineCoord ) * fwidth( lineCoord ) );
      float f = fract( lineCoord ) - 0.5;
      // Gaussiana **enrolada** no período (3 imagens): mantém a média em 1
      // mesmo quando sigma cresce e as caudas passam para a linha vizinha.
      float beam = exp( -0.5 * ( f * f ) / ( sg * sg ) )
        + exp( -0.5 * ( ( f + 1.0 ) * ( f + 1.0 ) ) / ( sg * sg ) )
        + exp( -0.5 * ( ( f - 1.0 ) * ( f - 1.0 ) ) / ( sg * sg ) );
      beam /= sg * CRT_SQRT_TAU;
      crt *= mix( 1.0, beam, scanFade );
    }

    // Grade de abertura: três faixas de fósforo por tríade, defasadas de 1/3 do
    // passo, cada canal com ganho próprio. O passo é **físico** — 0,60 mm numa
    // face de 270 mm dá ~450 tríades na largura do raster — e vive no espaço do
    // *vidro*, porque a chapa é colada na face e não acompanha a distorção do
    // raster. Normalizada para média 1 no período: acender a máscara redistribui
    // a luz em picos e vales sem mudar o brilho médio, e os picos passam de 1,0
    // e alimentam a halação.
    float triadPx = pxPerU / uMaskTriads;
    float maskFade = smoothstep( 1.5, 3.0, triadPx ) * uMask;
    if ( maskFade > 0.001 ) {
      float phase = fract( vMapUv.x * uMaskTriads );
      float phasePx = fwidth( vMapUv.x * uMaskTriads );
      vec3 d = abs( vec3( phase ) - vec3( 0.16666667, 0.5, 0.83333333 ) );
      d = min( d, 1.0 - d );
      // 0,165 faz o ganho oscilar de 0,26 a 2,42 depois da normalização. A grade
      // física oscila 0,54–1,92; o excedente paga a amostragem em ~3 px por
      // tríade, que é o que sobra do padrão no quadro final.
      float ms = sqrt( 0.165 * 0.165 + 0.25 * phasePx * phasePx );
      vec3 stripe = exp( -0.5 * ( d * d ) / ( ms * ms ) );
      vec3 gain = stripe / ( ms * CRT_SQRT_TAU );
      crt *= mix( vec3( 1.0 ), gain, maskFade );
    }

    // Granulação do grão de fósforo. Fixa ao tubo (espaço UV), não à tela, senão
    // "nada" quando a câmera anda. Some junto com a máscara, pelo mesmo motivo.
    float grainPx = pxPerU / ( uMaskTriads * 1.7 );
    float grainFade = smoothstep( 1.0, 2.4, grainPx ) * uGrain;
    if ( grainFade > 0.001 ) {
      vec2 cell = floor( vMapUv * uMaskTriads * vec2( 1.7, 1.7 ) );
      float h = fract( sin( dot( cell, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
      crt *= 1.0 + ( h - 0.5 ) * grainFade * sqrt( lumBeam + 0.04 );
    }

    // Cantos arredondados: nenhum tubo acende um retângulo de cantos vivos. O
    // SDF é medido em **metros** (por isso "uRasterHalf"): em UV normalizado o
    // mesmo raio produz um canto oval, e a área apagada não casava com a máscara
    // de fósforo apagado desenhada por trás — era daí que saía o preto 4,4,4 na
    // quina do tubo.
    vec2 pm = ( vMapUv - 0.5 ) * uRasterHalf * 2.0;
    vec2 qm = abs( pm ) - ( uRasterHalf - uRasterCorner );
    float sd = length( max( qm, 0.0 ) ) + min( max( qm.x, qm.y ), 0.0 ) - uRasterCorner;
    crt *= 1.0 - smoothstep( -0.0007, 0.0007, sd );

    // --- Saída: resposta fotográfica, depois desfaz a AgX do pós --------------
    // O piso é o fósforo apagado devolvendo a luz da sala: um TRC fotografado
    // nunca tem preto digital dentro do raster, tem um cinza-esverdeado de ~15
    // níveis. Sem ele, toda área preta da imagem lê como buraco.
    vec3 disp = max( crtDisplay( crt ), uDeadFloor );
    diffuseColor.rgb = crtUndoAgX( disp ) * uThroughGlass / max( uExposure, 1e-3 );
  }
#endif
`

/**
 * Pluga brilho / contraste / rampa de aquecimento no material da tela.
 * Idempotente: chamar de novo no mesmo material não empilha patches.
 */
function attachScreenShader(material: THREE.MeshBasicMaterial, uniforms: ScreenUniforms): void {
  const tagged = material as THREE.MeshBasicMaterial & { userData: Record<string, unknown> }
  if (tagged.userData['crtPatched'] === true) return
  tagged.userData['crtPatched'] = true
  // Publicado no material para quem precisar inspecionar ou dirigir o tubo sem
  // passar pelo módulo (ferramenta de captura, camada de pós-processamento).
  tagged.userData['crtUniforms'] = uniforms
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uBrightness'] = uniforms.uBrightness
    shader.uniforms['uContrast'] = uniforms.uContrast
    shader.uniforms['uWarmth'] = uniforms.uWarmth
    shader.uniforms['uVignette'] = uniforms.uVignette
    shader.uniforms['uMask'] = uniforms.uMask
    shader.uniforms['uMaskTriads'] = uniforms.uMaskTriads
    shader.uniforms['uScan'] = uniforms.uScan
    shader.uniforms['uScanLines'] = uniforms.uScanLines
    shader.uniforms['uGrain'] = uniforms.uGrain
    shader.uniforms['uWarp'] = uniforms.uWarp
    shader.uniforms['uExposure'] = uniforms.uExposure
    shader.uniforms['uThroughGlass'] = uniforms.uThroughGlass
    shader.uniforms['uRasterHalf'] = uniforms.uRasterHalf
    shader.uniforms['uRasterCorner'] = uniforms.uRasterCorner
    shader.uniforms['uDeadFloor'] = uniforms.uDeadFloor
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${SCREEN_UNIFORMS}\nvoid main() {`)
      .replace('#include <map_fragment>', `#include <map_fragment>${SCREEN_PATCH}`)
  }
  material.customProgramCacheKey = () => 'crt-screen-v3'
  material.needsUpdate = true
}

/** Fósforo apagado: cinza-esverdeado muito escuro, com leve variação. */
function darkPhosphorTexture(): THREE.DataTexture {
  const size = 16
  const data = new Uint8Array(size * size * 4)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = (j * size + i) * 4
      const radial = 1 - 0.35 * ((i / size - 0.5) ** 2 + (j / size - 0.5) ** 2) * 4
      const v = 9 * radial
      data[k] = Math.round(v * 0.82)
      data[k + 1] = Math.round(v)
      data[k + 2] = Math.round(v * 0.9)
      data[k + 3] = 255
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  texture.name = 'crt-fosforo-apagado'
  return texture
}

// ---------------------------------------------------------------------------
// Materiais
// ---------------------------------------------------------------------------

interface Retiler {
  retile(
    material: THREE.MeshPhysicalMaterial,
    repeatU: number,
    repeatV: number,
  ): THREE.MeshPhysicalMaterial
}

/**
 * Nossas UVs são métricas; os materiais compartilhados são calibrados para UVs
 * 0..1 de face. `retile()` reconcilia os dois. Se a biblioteca não expuser o
 * utilitário (fallback do `main.ts`), seguimos com o material original.
 */
function metricTiling(
  materials: MaterialLibrary,
  material: THREE.MeshPhysicalMaterial,
  owned: THREE.Material[],
): THREE.MeshPhysicalMaterial {
  const lib = materials as unknown as Partial<Retiler>
  if (typeof lib.retile !== 'function') return material
  try {
    const tiled = lib.retile(material, TILES_PER_METRE, TILES_PER_METRE)
    owned.push(tiled)
    return tiled
  } catch {
    return material
  }
}

// ---------------------------------------------------------------------------
// Módulo
// ---------------------------------------------------------------------------

/** Rótulos pt-BR das peças interativas. */
const LABELS = {
  screen: 'Tela do monitor — clique para focar',
  brightness: 'Brilho — arraste na horizontal',
  contrast: 'Contraste — arraste na horizontal',
} as const

export interface CrtMonitorControls {
  /** 0..1 — posição do botão de brilho. */
  readonly brightness: number
  /** 0..1 — posição do botão de contraste. */
  readonly contrast: number
}

export interface CrtMonitorModule extends SceneModule {
  /** Raiz do monitor. Null antes de `build()`. */
  readonly group: THREE.Group | null
  /**
   * Superfície do fósforo. É aqui que o framebuffer do emulador entra —
   * prefira {@link CrtMonitorModule.setScreenTexture} a trocar o material.
   */
  readonly screenMesh: THREE.Mesh | null
  /** Faceplate transmissivo, à frente do fósforo. */
  readonly glassMesh: THREE.Mesh | null
  /** Estado de energia + rampa de aquecimento (0..1). */
  readonly power: PowerState
  readonly controls: CrtMonitorControls

  /** Liga/desliga. O tubo aquece e esfria — nunca salta (SPEC §8). */
  setPower(on: boolean): void
  /** Alterna e devolve o novo estado. */
  togglePower(): boolean
  /** Aponta a tela para outra textura (emulador real ou fallback procedural). */
  setScreenTexture(texture: THREE.Texture): void
  /** 0..1. Gira o botão e muda o ganho do fósforo e a luz derramada na cena. */
  setBrightness(value: number): void
  /** 0..1. Gira o botão e muda o contraste do fósforo. */
  setContrast(value: number): void
}

class CrtMonitor implements CrtMonitorModule {
  public readonly name = 'CrtMonitor'

  public group: THREE.Group | null = null
  public screenMesh: THREE.Mesh | null = null
  public glassMesh: THREE.Mesh | null = null

  private powerOn = false
  private warmth = 0
  // Ponto de partida dos botões. Um monitor de vídeo de época é regulado para
  // que o branco **estoure** e o preto continue preto: brilho contido, contraste
  // alto. Com brilho alto e contraste baixo o azul de fundo do MSX chega perto
  // do branco do texto, e a tela perde a hierarquia que uma foto real tem.
  private brightness = 0.5
  private contrast = 0.5

  private screenMaterial: THREE.MeshBasicMaterial | null = null
  private readonly screenUniforms: ScreenUniforms = {
    uBrightness: { value: 1 },
    uContrast: { value: 1 },
    uWarmth: { value: 0 },
    uVignette: { value: 0.3 },
    // Máscara e varredura entram **as duas** com peso alto. A revisão mediu
    // 1,4 % de modulação horizontal (ruído de dithering, não fósforo) e cobrou
    // tríades contáveis no macro: com 0,9 o ganho por canal oscila de 0,54 a
    // 1,92, que é a modulação de uma grade de abertura de verdade.
    uMask: { value: 0.9 },
    // Passo de máscara de 0,60 mm — o valor de um tubo de consumo de 14" da
    // época — sobre a largura do raster (0,268 m / 0,988 de UV) dá ~450 tríades.
    uMaskTriads: { value: 450 },
    uScan: { value: 1 },
    // 240 linhas: o campo NTSC visível, que é exatamente a altura do
    // framebuffer do WebMSX. Casar os dois números é o que impede batimento
    // entre a linha de varredura desenhada aqui e a linha de pixels da fonte.
    uScanLines: { value: 240 },
    uGrain: { value: 0.05 },
    uWarp: { value: 0.046 },
    uExposure: { value: 1 },
    // Recíproco da transmitância do faceplate, medido na captura. Entra como
    // ganho de **radiância** (e não de exibição) porque é assim que o vidro age:
    // `final = agx(emissivo · T)`, logo o emissivo tem de ser `undo(alvo)/T`.
    // Consequência importante: canais negativos ficam mais negativos, então um
    // valor errado aqui não escurece a imagem — ele torce a matiz. Foi o que
    // aconteceu com 1,36 sobre um vidro quase neutro: o campo azul virou violeta.
    uThroughGlass: { value: 1.0 },
    uRasterHalf: {
      value: new THREE.Vector2(DIM.raster.halfW / OVERSCAN.u, DIM.raster.halfH / OVERSCAN.v),
    },
    uRasterCorner: { value: 0.019 },
    // Fósforo P22 apagado devolvendo a luz da sala: ~15 níveis sRGB, com o viés
    // verde-acinzentado do alumínio por trás do fósforo.
    uDeadFloor: {
      value: new THREE.Color().setRGB(0.052, 0.062, 0.057, THREE.LinearSRGBColorSpace),
    },
  }

  private shellMaterial: THREE.MeshPhysicalMaterial | null = null
  private knobBrightness: THREE.Object3D | null = null
  private knobContrast: THREE.Object3D | null = null
  private rocker: THREE.Object3D | null = null
  private ledMaterial: THREE.MeshPhysicalMaterial | null = null
  private ledLight: THREE.PointLight | null = null
  private renderer: THREE.WebGLRenderer | null = null
  private readonly screenTint = new THREE.Color(1, 1, 1)
  private readonly frameAverageScratch: FrameAverage = { r: 0, g: 0, b: 0 }

  private readonly ownedGeometries: THREE.BufferGeometry[] = []
  private readonly ownedMaterials: THREE.Material[] = []
  private readonly ownedTextures: THREE.Texture[] = []

  private lightParked = false
  private readonly scratchPosition = new THREE.Vector3()
  private readonly scratchTarget = new THREE.Vector3()

  // -------------------------------------------------------------------------

  public get power(): PowerState {
    return { on: this.powerOn, warmth: this.warmth }
  }

  public get controls(): CrtMonitorControls {
    return { brightness: this.brightness, contrast: this.contrast }
  }

  // -------------------------------------------------------------------------

  public async build(ctx: ModuleContext): Promise<THREE.Group> {
    const root = new THREE.Group()
    root.name = 'monitor-crt'
    root.position.set(DIM.place.x, DIM.place.y, DIM.place.z)
    // Origem do grupo está no nível da mesa: a escala uniforme cresce o gabinete
    // para cima e para os lados sem descolar os pés do tampo.
    root.scale.setScalar(DIM.scale)

    const materials = ctx.materials
    const owned = this.ownedMaterials
    this.renderer = ctx.renderer

    const shellMat = metricTiling(materials, materials.caseGraphite(), owned)
    this.shellMaterial = shellMat
    const bezelMat = metricTiling(materials, materials.caseFascia(), owned)
    const darkMat = metricTiling(materials, materials.panelBlack(), owned)

    // Pedestal fica na mesa; o gabinete inclina sobre ele.
    root.add(this.buildBase(shellMat, darkMat, materials))

    const tilt = new THREE.Group()
    tilt.name = 'monitor-inclinacao'
    tilt.position.set(0, DIM.pivot.y, DIM.pivot.z)
    tilt.rotation.x = THREE.MathUtils.degToRad(DIM.tiltDeg)
    root.add(tilt)

    const shell = new THREE.Group()
    shell.name = 'monitor-gabinete'
    // Leva o referencial H (origem no centro da face frontal) para cima do pivô.
    shell.position.set(0, DIM.base.top + DIM.front.halfH - DIM.pivot.y, -DIM.pivot.z)
    tilt.add(shell)

    shell.add(this.buildShell(shellMat))
    await yieldToMain()
    shell.add(this.buildBezel(bezelMat))
    shell.add(this.buildScreen(materials))
    // Depois da tela: a máscara de fósforo apagado fica 0,3 mm **à frente** do
    // plano do fósforo e tapa a área que o SDF de canto apaga. Antes ficava
    // atrás, e a quina do raster caía para preto digital porque a malha da tela
    // é opaca — era o 4,4,4 que a revisão mediu na borda morta do tubo.
    shell.add(this.buildShroud())
    shell.add(await this.buildGlass())
    await yieldToMain()
    shell.add(this.buildVentRibs(shellMat))
    shell.add(await this.buildControls(bezelMat, darkMat, materials))
    shell.add(this.buildRearPanel(darkMat, materials))
    // O cabo vive no referencial da mesa, não no gabinete inclinado: assim
    // encosta no tampo de verdade em vez de mergulhar 3° dentro dele.
    root.add(this.buildPowerCord(materials))

    this.group = root
    this.applyControlValues()
    this.parkScreenLight()
    return root
  }

  // -------------------------------------------------------------------------
  // Carcaça traseira
  // -------------------------------------------------------------------------

  private shellRing(z: number): Float32Array {
    const t = clamp01(-z / DIM.depth)
    const seam = partingSeamInset(z)
    const top = shellTop(t) - seam
    const bottom = shellBottom(t) + seam
    const halfH = (top - bottom) / 2
    const centreY = (top + bottom) / 2
    const ring2d = roundedRectRing(
      shellHalfW(t) - seam,
      halfH,
      shellCorner(t),
      PERIM_SEGMENTS,
      centreY,
    )

    const cols = ring2d.length / 2
    const out = new Float32Array(cols * 3)
    for (let c = 0; c < cols; c++) {
      const x = at(ring2d, c * 2)
      const y = at(ring2d, c * 2 + 1)
      out[c * 3] = x
      out[c * 3 + 1] = y - ventBasinDrop(x, y, z, t)
      out[c * 3 + 2] = z
    }
    return out
  }

  private buildShell(material: THREE.Material): THREE.Group {
    const group = new THREE.Group()
    group.name = 'monitor-carcaca'

    // Amostragem em z: uniforme, com refino nas bordas da bacia de ventilação
    // (é ali que a casca muda de direção depressa).
    const depths = new Set<number>()
    const steps = 26
    for (let i = 0; i <= steps; i++) depths.add(-(i / steps) * DIM.depth)
    for (const edge of [DIM.vent.zFront, DIM.vent.zBack]) {
      for (const d of [-0.009, -0.004, 0, 0.004, 0.009]) {
        const z = edge + d
        if (z <= 0 && z >= -DIM.depth) depths.add(z)
      }
    }
    // A fresta de junção precisa dos seus próprios anéis: 0,9 mm de largura não
    // sobrevive a uma amostragem de 14 mm em z.
    for (const d of [-0.0011, -0.00055, -0.0002, 0, 0.0002, 0.00055, 0.0011]) {
      const z = DIM.seam.z + d
      if (z <= 0 && z >= -DIM.depth) depths.add(z)
    }
    const zList = [...depths].sort((a, b) => b - a)
    const rings = zList.map((z) => this.shellRing(z))

    const geometry = loft(rings)
    this.ownedGeometries.push(geometry)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'monitor-carcaca-casca'
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)

    const last = rings[rings.length - 1]
    if (last !== undefined) {
      const tBack = 1
      const centreY = (shellTop(tBack) + shellBottom(tBack)) / 2
      const cap = capRing(last, 0, centreY, -DIM.depth, true)
      this.ownedGeometries.push(cap)
      const capMesh = new THREE.Mesh(cap, material)
      capMesh.name = 'monitor-carcaca-tampa'
      capMesh.castShadow = true
      capMesh.receiveShadow = true
      group.add(capMesh)
    }
    return group
  }

  // -------------------------------------------------------------------------
  // Moldura frontal
  // -------------------------------------------------------------------------

  private buildBezel(material: THREE.Material): THREE.Mesh {
    const inner = roundedRectRing(
      DIM.aperture.halfW,
      DIM.aperture.halfH,
      DIM.aperture.corner,
      PERIM_SEGMENTS,
      DIM.aperture.offsetY,
    )
    const outer = roundedRectRing(
      DIM.front.halfW,
      DIM.front.halfH,
      DIM.front.corner,
      PERIM_SEGMENTS,
      0,
    )

    // O funil sobe rápido junto ao vidro e achata nos 20 % externos, com um
    // pequeno lábio plano rente à abertura — é o desenho de uma moldura injetada.
    // O funil ocupa a metade interna da faixa e chega à face plana com
    // derivada zero; a metade externa é a aba lisa da moldura. Repartir assim é
    // o que dá o degrau nítido de uma peça injetada em vez de um travesseiro.
    const ts = [0, 0.025, 0.05, 0.09, 0.14, 0.2, 0.27, 0.35, 0.44, 0.54, 0.7, 0.85, 1]
    const rings = ts.map((t) => {
      const ring2d = lerpRing(inner, outer, t)
      const cols = ring2d.length / 2
      const out = new Float32Array(cols * 3)
      const lip = t <= 0.05 ? 0 : t >= 0.54 ? 1 : 1 - Math.pow(1 - (t - 0.05) / 0.49, 1.9)
      for (let c = 0; c < cols; c++) {
        const x = at(ring2d, c * 2)
        const y = at(ring2d, c * 2 + 1)
        // Profundidade do vidro medida na borda da abertura, não no ponto atual:
        // a moldura acompanha a curvatura do tubo mesmo depois de sair dele.
        const ax = at(inner, c * 2)
        const ay = at(inner, c * 2 + 1) - DIM.aperture.offsetY
        const zInner = glassZ(ax, ay) + 0.0009
        // Leve abaulamento na aba externa: molduras de época não são réguas.
        const crown = 0.0007 * Math.sin(Math.PI * clamp01((t - 0.5) / 0.5))
        out[c * 3] = x
        out[c * 3 + 1] = y
        out[c * 3 + 2] = zInner * (1 - lip) + crown * lip
      }
      return out
    })

    const geometry = loft(rings)
    this.ownedGeometries.push(geometry)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'monitor-moldura'
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }

  /**
   * Máscara interna do tubo: a faixa preta entre o raster e a borda da abertura,
   * desenhada **na superfície do fósforo**, 13 mm atrás do vidro. É ela que
   * aparece deslocada quando a câmera orbita — o paralaxe do faceplate.
   */
  private buildShroud(): THREE.Mesh {
    const innerRing = roundedRectRing(
      DIM.raster.halfW - 0.0008,
      DIM.raster.halfH - 0.0008,
      // Casa com `uRasterCorner` do shader da tela: é a mesma quina.
      0.019,
      PERIM_SEGMENTS,
      0,
    )
    const outerRing = roundedRectRing(
      DIM.glass.halfW,
      DIM.glass.halfH,
      DIM.glass.corner,
      PERIM_SEGMENTS,
      0,
    )
    const ts = [0, 0.18, 0.4, 0.68, 1]
    const rings = ts.map((t) =>
      raise(lerpRing(innerRing, outerRing, t), (x, y) => phosphorZ(x, y) + 0.0003),
    )

    const geometry = loft(rings)
    geometry.translate(0, DIM.aperture.offsetY, 0)
    this.ownedGeometries.push(geometry)
    const mesh = new THREE.Mesh(geometry, this.deadPhosphorMaterial())
    mesh.name = 'monitor-mascara-tubo'
    mesh.receiveShadow = true
    return mesh
  }

  /**
   * Fósforo P22 **apagado**, aluminizado.
   *
   * A borda morta do tubo é, numa foto de TRC, a região onde a sala aparece mais
   * claramente: não há emissão para abafar o reflexo. Renderizá-la com o preto
   * fosco do painel (rugosidade 0,80) dava 4,4,4 — "a tela é uma textura e
   * acaba aqui". O material real é escuro mas **liso**: albedo 0,06–0,08 com viés
   * verde-acinzentado e rugosidade 0,12, então ele espelha o softbox e a moldura
   * e assenta em 22–40 níveis sRGB, que é o que se mede numa fotografia.
   */
  private deadPhosphorMaterial(): THREE.MeshPhysicalMaterial {
    const material = new THREE.MeshPhysicalMaterial({
      name: 'crt-fosforo-apagado',
      color: new THREE.Color().setRGB(0.032, 0.041, 0.036, THREE.LinearSRGBColorSpace),
      roughness: 0.11,
      metalness: 0,
      envMapIntensity: 1.25,
      specularIntensity: 1,
      side: THREE.FrontSide,
    })
    this.ownedMaterials.push(material)
    return material
  }

  // -------------------------------------------------------------------------
  // Tela e vidro
  // -------------------------------------------------------------------------

  private buildScreen(materials: MaterialLibrary): THREE.Mesh {
    const geometry = bulgedGrid(
      DIM.raster.halfW,
      DIM.raster.halfH,
      FACE_GRID.x,
      FACE_GRID.y,
      phosphorZ,
      OVERSCAN,
    )
    geometry.translate(0, DIM.aperture.offsetY, 0)
    this.ownedGeometries.push(geometry)

    const texture = darkPhosphorTexture()
    this.ownedTextures.push(texture)
    const material = materials.screenEmissive(texture)
    // A tela **já entrega** a radiância que a AgX do pós transforma na cor de
    // exibição pretendida (ver `SCREEN_UNIFORMS`). Se o renderer também estiver
    // com tone mapping ligado, a curva rodaria duas vezes e a inversão viraria
    // lixo. Desligar aqui é o que torna a cadeia à prova da ordem de montagem.
    material.toneMapped = false
    attachScreenShader(material, this.screenUniforms)
    this.screenMaterial = material

    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'crt-screen'
    const userData: InteractiveUserData = {
      partId: 'crt-screen',
      label: LABELS.screen,
      cursor: 'pointer',
    }
    mesh.userData = { ...userData }
    this.screenMesh = mesh
    return mesh
  }

  private async buildGlass(): Promise<THREE.Group> {
    const group = new THREE.Group()
    group.name = 'monitor-vidro'

    const geometry = bulgedGrid(
      DIM.glass.halfW,
      DIM.glass.halfH,
      FACE_GRID.x,
      FACE_GRID.y,
      glassZ,
      null,
    )
    geometry.translate(0, DIM.aperture.offsetY, 0)
    this.ownedGeometries.push(geometry)

    // Poeira e gordura da superfície do faceplate.
    const dust = await dustAccumulationAsync(512, { coverage: 0.42, range: [0.42, 1], seed: 0x5c17ab })

    const glass = this.buildGlassReflection(geometry, dust)
    this.glassMesh = glass
    group.add(glass)
    group.add(this.buildGlassEdge(dust))

    return group
  }

  /**
   * O faceplate — uma folha **puramente refletiva** sobre o tubo, e aqui moram
   * duas correções medidas.
   *
   * 1. *Nada de `transmission`.* Um faceplate transmissivo faz o three amostrar o
   *    backbuffer com `textureBicubic` num LOD derivado da rugosidade, e essa
   *    reamostragem é um filtro passa-baixa: medido nesta cena, ela come 2,4× da
   *    modulação da tríade e 2× da varredura. Ou seja, o vidro estava apagando
   *    justamente o fósforo que a revisão cobrou. Sem transmissão, o raster é
   *    visto direto e a estrutura sobrevive; o que se perde é o deslocamento
   *    refrativo de ~3 mm, um efeito de segunda ordem, enquanto o paralaxe que
   *    realmente se lê continua ali — as normais e o reflexo estão na superfície
   *    do vidro, 13 mm à frente do plano do fósforo.
   *
   * 2. *Rugosidade própria, alta o bastante para haver penumbra.* Em
   *    `RE_Direct_RectArea_Physical` a three escolhe o LTC por `material.roughness`.
   *    Com 0,02 o softbox reflete como um retângulo de aresta viva a 30° — o tell
   *    mais rápido do quadro. Aqui a rugosidade vai a 0,10–0,23 modulada por um
   *    mapa de dedadas, e não há transmissão para ela borrar.
   *
   * A malha usa as normais reais da face abaulada, o que dá de graça a resposta
   * que o crítico exigiu: a reflexão espelhada **dobra** o desvio da normal, então
   * o reflexo comprime mais que a imagem por trás do vidro — não menos.
   */
  private buildGlassReflection(
    geometry: THREE.BufferGeometry,
    dust: THREE.DataTexture,
  ): THREE.Mesh {
    const smudge = dust.clone()
    smudge.wrapS = THREE.RepeatWrapping
    smudge.wrapT = THREE.RepeatWrapping
    smudge.repeat.set(2.1, 1.7)
    smudge.needsUpdate = true
    this.ownedTextures.push(smudge)

    const material = new THREE.MeshPhysicalMaterial({
      name: 'crt-glass-reflexo',
      // Sem difuso: só o lobo especular é somado. Um albedo qualquer aqui
      // devolveria o véu leitoso de um vidro mal modelado.
      color: new THREE.Color(0x000000),
      roughness: 0.23,
      roughnessMap: smudge,
      metalness: 0,
      // Vidro de TRC não é incolor: o reflexo puxa levemente para verde.
      specularColor: new THREE.Color().setRGB(0.94, 1.0, 0.96, THREE.LinearSRGBColorSpace),
      specularIntensity: 1.05,
      envMapIntensity: 1.35,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide,
    })
    this.ownedMaterials.push(material)

    // Compartilha a geometria da face: zero memória extra, um draw call.
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'monitor-faceplate'
    mesh.position.z = 0.0005
    mesh.renderOrder = 2
    mesh.castShadow = false
    mesh.receiveShadow = false
    return mesh
  }

  /**
   * Aresta do faceplate onde ele entra na moldura.
   *
   * Um faceplate de 8 mm visto por dentro da abertura mostra duas coisas que a
   * revisão cobrou e que um degrau de 1 px não tem: uma faixa escura de 3 mm (o
   * vidro visto quase de perfil, onde o caminho óptico é longo e o alumínio do
   * fósforo já acabou) e, do lado da luz principal, uma lasca clara de cáustica
   * onde o softbox rasa a curvatura. Nada disso é pintado: a faixa é uma malha
   * com material escuro e liso, e a cáustica é o especular que ela devolve.
   */
  private buildGlassEdge(dust: THREE.DataTexture): THREE.Mesh {
    const outer = roundedRectRing(
      DIM.aperture.halfW - 0.0004,
      DIM.aperture.halfH - 0.0004,
      DIM.aperture.corner,
      PERIM_SEGMENTS,
      0,
    )
    const inner = roundedRectRing(
      DIM.aperture.halfW - 0.0034,
      DIM.aperture.halfH - 0.0034,
      DIM.aperture.corner - 0.003,
      PERIM_SEGMENTS,
      0,
    )
    const ts = [0, 0.35, 0.7, 1]
    const rings = ts.map((t) =>
      raise(lerpRing(inner, outer, t), (x, y) => glassZ(x, y) + 0.0004 + 0.0006 * t),
    )
    const geometry = loft(rings)
    geometry.translate(0, DIM.aperture.offsetY, 0)
    this.ownedGeometries.push(geometry)

    // Poeira na costura moldura/vidro: 41 anos de sala depositam uma linha de pó
    // exatamente nesse ângulo interno, e é a coisa mais barata que separa "objeto
    // usado" de "peça recém-modelada". Entra como mapa de rugosidade — o pó não
    // muda o albedo do vidro, ele espalha o especular.
    const grime = dust.clone()
    grime.wrapS = THREE.RepeatWrapping
    grime.wrapT = THREE.RepeatWrapping
    grime.repeat.set(9, 1)
    grime.needsUpdate = true
    this.ownedTextures.push(grime)

    const material = new THREE.MeshPhysicalMaterial({
      name: 'crt-aresta-vidro',
      color: new THREE.Color().setRGB(0.012, 0.014, 0.013, THREE.LinearSRGBColorSpace),
      roughness: 0.34,
      roughnessMap: grime,
      metalness: 0,
      envMapIntensity: 1.1,
      specularIntensity: 1,
      side: THREE.FrontSide,
    })
    this.ownedMaterials.push(material)

    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'monitor-aresta-vidro'
    mesh.renderOrder = 3
    mesh.receiveShadow = true
    return mesh
  }

  // -------------------------------------------------------------------------
  // Ventilação
  // -------------------------------------------------------------------------

  private buildVentRibs(material: THREE.Material): THREE.InstancedMesh {
    const count = DIM.vent.ribs
    const span = DIM.vent.zBack - DIM.vent.zFront
    const pitch = span / count
    const geometry = new THREE.BoxGeometry(1, 0.008, Math.abs(pitch) * 0.54)
    this.ownedGeometries.push(geometry)

    const mesh = new THREE.InstancedMesh(geometry, material, count)
    mesh.name = 'monitor-aletas-ventilacao'
    mesh.castShadow = true
    mesh.receiveShadow = true

    const matrix = new THREE.Matrix4()
    const quaternion = new THREE.Quaternion()
    const position = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const axis = new THREE.Vector3(1, 0, 0)

    for (let i = 0; i < count; i++) {
      const z = DIM.vent.zFront + (i + 0.5) * pitch
      const t = clamp01(-z / DIM.depth)
      const top = shellTop(t)
      const length = 2 * (ventHalfW(t) + 0.004)
      position.set(0, top - 0.004, z)
      quaternion.setFromAxisAngle(axis, Math.atan(deckSlope(z)))
      scale.set(length, 1, 1)
      matrix.compose(position, quaternion, scale)
      mesh.setMatrixAt(i, matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    // Sem isto o culling usa a caixa da geometria unitária (1 m de largura),
    // não a das instâncias já escaladas.
    mesh.computeBoundingBox()
    mesh.computeBoundingSphere()
    return mesh
  }

  // -------------------------------------------------------------------------
  // Pedestal
  // -------------------------------------------------------------------------

  private buildBase(
    shellMat: THREE.Material,
    darkMat: THREE.Material,
    materials: MaterialLibrary,
  ): THREE.Group {
    const group = new THREE.Group()
    group.name = 'monitor-pedestal'

    const slab = roundedSlab(DIM.base.halfW, DIM.base.halfD, DIM.base.slab, DIM.base.corner, 0.0035)
    this.ownedGeometries.push(slab)
    const slabMesh = new THREE.Mesh(slab, shellMat)
    slabMesh.name = 'monitor-base'
    slabMesh.position.set(0, DIM.base.footH, DIM.pivot.z - 0.005)
    slabMesh.castShadow = true
    slabMesh.receiveShadow = true
    group.add(slabMesh)

    // Prato giratório entre a base e o gabinete — some na sombra, mas é o que
    // explica a fresta escura sob o monitor.
    const puckHeight = DIM.base.top - DIM.base.footH - DIM.base.slab
    const puck = new THREE.CylinderGeometry(0.072, 0.082, puckHeight, 44, 1)
    this.ownedGeometries.push(puck)
    const puckMesh = new THREE.Mesh(puck, darkMat)
    puckMesh.name = 'monitor-prato-giratorio'
    puckMesh.position.set(0, DIM.base.footH + DIM.base.slab + puckHeight / 2, DIM.pivot.z)
    puckMesh.castShadow = true
    puckMesh.receiveShadow = true
    group.add(puckMesh)

    const footGeometry = new THREE.CylinderGeometry(0.0105, 0.0115, DIM.base.footH, 20, 1)
    this.ownedGeometries.push(footGeometry)
    const feet = new THREE.InstancedMesh(footGeometry, materials.rubber(), 4)
    feet.name = 'monitor-pes'
    feet.castShadow = true
    const matrix = new THREE.Matrix4()
    const inset = 0.026
    const corners: ReadonlyArray<readonly [number, number]> = [
      [DIM.base.halfW - inset, DIM.base.halfD - inset],
      [-(DIM.base.halfW - inset), DIM.base.halfD - inset],
      [DIM.base.halfW - inset, -(DIM.base.halfD - inset)],
      [-(DIM.base.halfW - inset), -(DIM.base.halfD - inset)],
    ]
    corners.forEach((corner, i) => {
      const [x, dz] = corner
      matrix.makeTranslation(x, DIM.base.footH / 2, DIM.pivot.z - 0.005 + dz)
      feet.setMatrixAt(i, matrix)
    })
    feet.instanceMatrix.needsUpdate = true
    feet.computeBoundingBox()
    feet.computeBoundingSphere()
    group.add(feet)

    return group
  }

  // -------------------------------------------------------------------------
  // Controles do queixo
  // -------------------------------------------------------------------------

  private async buildControls(
    bezelMat: THREE.Material,
    darkMat: THREE.Material,
    materials: MaterialLibrary,
  ): Promise<THREE.Group> {
    const group = new THREE.Group()
    group.name = 'monitor-controles'

    const chinTop = DIM.aperture.offsetY - DIM.aperture.halfH
    const chinBottom = -DIM.front.halfH
    // Mesma fração usada pela serigrafia — os dois têm de casar.
    const knobY = chinBottom + (chinTop - chinBottom) * 0.52

    // ── Serigrafia do queixo ────────────────────────────────────────────────
    group.add(await this.buildChinDecal(chinTop, chinBottom))

    // ── Botões giratórios ───────────────────────────────────────────────────
    const knobGeo = knobGeometry(0.0072, 0.0092, 22)
    this.ownedGeometries.push(knobGeo)
    const pointerGeo = new THREE.BoxGeometry(0.0011, 0.0009, 0.0052)
    this.ownedGeometries.push(pointerGeo)
    const pointerMat = materials.keycap(0xd8d5cc, true)
    const knobMat = materials.keycap(0x2a2825)
    const collarGeo = new THREE.CylinderGeometry(0.0098, 0.0098, 0.0016, 28, 1)
    this.ownedGeometries.push(collarGeo)

    const makeKnob = (
      x: number,
      partId: 'crt-knob-brightness' | 'crt-knob-contrast',
      label: string,
      nodeName: string,
    ): THREE.Object3D => {
      const pivot = new THREE.Group()
      pivot.name = nodeName
      pivot.position.set(x, knobY, 0.0004)
      pivot.rotation.x = Math.PI / 2

      const body = new THREE.Mesh(knobGeo, knobMat)
      body.name = `${nodeName}-corpo`
      body.castShadow = true
      body.receiveShadow = true
      const userData: InteractiveUserData = { partId, label, cursor: 'ew-resize' }
      body.userData = { ...userData }
      pivot.add(body)

      const pointer = new THREE.Mesh(pointerGeo, pointerMat)
      pointer.name = `${nodeName}-indicador`
      // A marca fica no topo da saia, apontando para fora do eixo do botão.
      pointer.position.set(0, 0.0088, -0.0046)
      pointer.userData = { ...userData }
      pivot.add(pointer)

      const collar = new THREE.Mesh(collarGeo, darkMat)
      collar.name = `${nodeName}-colar`
      collar.position.y = 0.0008
      collar.receiveShadow = true
      pivot.add(collar)

      return pivot
    }

    this.knobBrightness = makeKnob(0.108, 'crt-knob-brightness', LABELS.brightness, 'crt-botao-brilho')
    this.knobContrast = makeKnob(0.148, 'crt-knob-contrast', LABELS.contrast, 'crt-botao-contraste')
    group.add(this.knobBrightness, this.knobContrast)

    // ── Tecla de energia ────────────────────────────────────────────────────
    const frameGeo = new THREE.ExtrudeGeometry(roundedShape(0.0125, 0.0085, 0.0015), {
      depth: 0.0022,
      bevelEnabled: true,
      bevelThickness: 0.0006,
      bevelSize: 0.0006,
      bevelSegments: 2,
      curveSegments: 8,
      steps: 1,
    })
    frameGeo.computeVertexNormals()
    this.ownedGeometries.push(frameGeo)
    const frame = new THREE.Mesh(frameGeo, bezelMat)
    frame.name = 'crt-moldura-energia'
    frame.position.set(-0.146, knobY, -0.0004)
    frame.castShadow = true
    frame.receiveShadow = true
    group.add(frame)

    const wellGeo = new THREE.BoxGeometry(0.0206, 0.0126, 0.0018)
    this.ownedGeometries.push(wellGeo)
    const well = new THREE.Mesh(wellGeo, darkMat)
    well.name = 'crt-poco-energia'
    well.position.set(-0.146, knobY, 0.0002)
    group.add(well)

    const rockerGeo = new THREE.BoxGeometry(0.0186, 0.0108, 0.0042)
    this.ownedGeometries.push(rockerGeo)
    const rocker = new THREE.Mesh(rockerGeo, materials.keycap(0x36332f))
    rocker.name = 'crt-tecla-energia'
    rocker.position.set(-0.146, knobY, 0.0018)
    rocker.castShadow = true
    rocker.receiveShadow = true
    this.rocker = rocker
    group.add(rocker)

    // ── LED de energia ──────────────────────────────────────────────────────
    const ledGeo = new THREE.SphereGeometry(0.0022, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62)
    this.ownedGeometries.push(ledGeo)
    const ledMaterial = new THREE.MeshPhysicalMaterial({
      name: 'crt-led',
      color: new THREE.Color(0x123a1a),
      // Verde de LED de 1985 (GaP), saturado: um núcleo que **estoura** dentro de
      // um halo verde. `emissiveIntensity` sobe a 16 justamente para o miolo
      // passar de 1,0 em linear, recortar em 250+ e alimentar o bloom — um disco
      // verde-menta chapado é o que denuncia um LED de mentira.
      emissive: new THREE.Color().setRGB(0.15, 1.0, 0.25, THREE.LinearSRGBColorSpace),
      emissiveIntensity: 0,
      roughness: 0.14,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      ior: 1.55,
    })
    this.ownedMaterials.push(ledMaterial)
    this.ledMaterial = ledMaterial
    const led = new THREE.Mesh(ledGeo, ledMaterial)
    led.name = 'crt-led-energia'
    led.position.set(-0.121, knobY, 0.0008)
    led.rotation.x = Math.PI / 2
    group.add(led)

    // Lambida verde no plástico em volta: 6–10 mm de alcance. Sem ela o LED
    // acende sem contaminar nada, que é impossível num plástico claro a 3 mm.
    const ledLight = new THREE.PointLight(0x4dff7a, 0, 0.05, 2)
    ledLight.name = 'crt-luz-led'
    ledLight.position.set(-0.121, knobY, 0.004)
    this.ledLight = ledLight
    group.add(ledLight)

    return group
  }

  /**
   * Serigrafia do queixo. Um decalque plano a 0,4 mm da moldura, com relevo de
   * tinta próprio — serigrafia real é levemente saliente e um pouco mais
   * brilhante que o ABS embaixo (SPEC §4).
   */
  private async buildChinDecal(chinTop: number, chinBottom: number): Promise<THREE.Mesh> {
    const width = DIM.front.halfW * 2
    const height = chinTop - chinBottom
    // 3584 px em 0,372 m dá ~9,6 px por milímetro: a letra de 2,3 mm do
    // `MONITOR` recebe 22 px de altura no atlas, que é o mínimo para ela sair
    // legível a 100 % na foto de conjunto (a marca é legível em
    // `Gradiente_Logo_Detail.jpg` num enquadramento equivalente).
    const canvasW = 3584
    const canvasH = Math.round((canvasW * height) / width)
    const knobY = chinBottom + height * 0.52

    // Tudo em metros e convertido no fim: serigrafia de época tem ~2,5 mm de
    // altura de letra. Dimensionar por fração de canvas foi o que produziu, na
    // primeira volta, um logo de 2 cm — grande demais para ser levado a sério.
    const px = (metres: number): number => (metres / width) * canvasW
    const toU = (x: number): number => px(x + DIM.front.halfW)
    const toV = (y: number): number => px(chinTop - y)
    const face = (size: number, weight = 600): string =>
      `${weight} ${px(size).toFixed(1)}px "Helvetica Neue", Helvetica, Arial, sans-serif`

    const decal = await silkscreenDecalAsync(
      (c) => {
        c.textAlign = 'center'
        c.font = face(0.0026)
        c.fillText('BRILHO', toU(0.108), toV(knobY - 0.0126))
        c.fillText('CONTRASTE', toU(0.148), toV(knobY - 0.0126))
        c.fillText('LIGA', toU(-0.146), toV(knobY - 0.0126))

        // Marca da casa: anel concêntrico + wordmark (ver Gradiente_Logo_Detail).
        const ringR = px(0.0026)
        const ringX = toU(-0.072)
        const ringY = toV(knobY + 0.0012)
        c.lineWidth = px(0.0007)
        c.beginPath()
        c.arc(ringX, ringY, ringR, 0, Math.PI * 2)
        c.stroke()
        c.beginPath()
        c.arc(ringX, ringY, ringR * 0.4, 0, Math.PI * 2)
        c.fill()

        c.textAlign = 'left'
        c.font = face(0.0052, 700)
        c.fillText('gradiente', ringX + ringR * 1.5, toV(knobY - 0.0006))
        c.font = face(0.0026, 500)
        // Entreletra larga, como na placa original: é o que torna a sublinha
        // legível num corpo de 2,6 mm em vez de virar um borrão cinza.
        c.letterSpacing = `${px(0.00055).toFixed(2)}px`
        c.fillText('MONITOR', ringX + ringR * 1.6, toV(knobY - 0.0058))
        c.letterSpacing = '0px'

        // Margem transparente: garante que nenhuma tinta (nem o ruído de desgaste
        // que `silkscreenDecal` aplica em cima) chegue à aresta do atlas.
        const pad = Math.round(canvasW * 0.006)
        c.clearRect(0, 0, canvasW, pad)
        c.clearRect(0, canvasH - pad, canvasW, pad)
        c.clearRect(0, 0, pad, canvasH)
        c.clearRect(canvasW - pad, 0, pad, canvasH)
      },
      {
        width: canvasW,
        height: canvasH,
        ink: '#dcd9d0',
        wear: 0.26,
        relief: 2.4,
        gloss: 0.5,
        cacheKey: 'crt-chin-v2',
      },
    )

    // Amostragem fixada nas bordas, para o caso de o mapa nascer com repetição:
    // a linha âmbar fina na aresta inferior esquerda da fascia era sangramento de
    // borda do atlas. A outra metade da correção está no `clearRect` da margem,
    // dentro do próprio desenho.
    for (const map of [decal.map, decal.normalMap, decal.roughnessMap]) {
      map.wrapS = THREE.ClampToEdgeWrapping
      map.wrapT = THREE.ClampToEdgeWrapping
      map.needsUpdate = true
    }

    const geometry = new THREE.PlaneGeometry(width * 0.995, height * 0.98)
    this.ownedGeometries.push(geometry)

    const material = new THREE.MeshPhysicalMaterial({
      name: 'crt-serigrafia-queixo',
      map: decal.map,
      normalMap: decal.normalMap,
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughnessMap: decal.roughnessMap,
      roughness: 0.62,
      metalness: 0,
      transparent: true,
      alphaTest: 0.02,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    this.ownedMaterials.push(material)

    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'crt-serigrafia-queixo'
    mesh.position.set(0, (chinTop + chinBottom) / 2, 0.0006)
    mesh.receiveShadow = true
    return mesh
  }

  // -------------------------------------------------------------------------
  // Traseira
  // -------------------------------------------------------------------------

  private buildRearPanel(darkMat: THREE.Material, materials: MaterialLibrary): THREE.Group {
    const group = new THREE.Group()
    group.name = 'monitor-painel-traseiro'
    const zBack = -DIM.depth
    const tBack = 1
    const centreY = (shellTop(tBack) + shellBottom(tBack)) / 2

    // Placa de conectores dentro de um friso moldado. Sem o friso a placa lê
    // como adesivo colado; com ele, como rebaixo — e não é preciso furar a casca.
    const plateGeo = new THREE.BoxGeometry(0.118, 0.052, 0.0016)
    this.ownedGeometries.push(plateGeo)
    const plate = new THREE.Mesh(plateGeo, darkMat)
    plate.name = 'monitor-placa-conectores'
    plate.position.set(-0.02, centreY - 0.01, zBack - 0.0008)
    plate.receiveShadow = true
    group.add(plate)

    const frameShape = roundedShape(0.066, 0.033, 0.004)
    frameShape.holes.push(roundedShape(0.059, 0.026, 0.003))
    const frameGeo = new THREE.ExtrudeGeometry(frameShape, {
      depth: 0.0042,
      bevelEnabled: true,
      bevelThickness: 0.0008,
      bevelSize: 0.0008,
      bevelSegments: 2,
      curveSegments: 10,
      steps: 1,
    })
    frameGeo.computeVertexNormals()
    this.ownedGeometries.push(frameGeo)
    const frame = new THREE.Mesh(frameGeo, this.shellMaterial ?? darkMat)
    frame.name = 'monitor-friso-conectores'
    frame.position.set(-0.02, centreY - 0.01, zBack - 0.0042)
    frame.castShadow = true
    frame.receiveShadow = true
    group.add(frame)

    // Jacks RCA: casquilho metálico + miolo colorido (amarelo vídeo, branco áudio).
    const shellGeo = new THREE.CylinderGeometry(0.0046, 0.0046, 0.007, 20, 1)
    this.ownedGeometries.push(shellGeo)
    const shells = new THREE.InstancedMesh(shellGeo, materials.metal(0x8f9295, 0.34), 2)
    shells.name = 'monitor-jacks'
    shells.castShadow = true
    const coreGeoYellow = new THREE.CylinderGeometry(0.0031, 0.0031, 0.0076, 16, 1)
    this.ownedGeometries.push(coreGeoYellow)

    const matrix = new THREE.Matrix4()
    const jackX = [-0.052, -0.03]
    const jackY = centreY - 0.008
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
    const one = new THREE.Vector3(1, 1, 1)
    jackX.forEach((x, i) => {
      matrix.compose(new THREE.Vector3(x, jackY, zBack - 0.0035), rot, one)
      shells.setMatrixAt(i, matrix)
    })
    shells.instanceMatrix.needsUpdate = true
    shells.computeBoundingBox()
    shells.computeBoundingSphere()
    group.add(shells)

    const yellow = new THREE.Mesh(coreGeoYellow, materials.keycap(0xd9b52c))
    yellow.name = 'monitor-jack-video'
    yellow.position.set(jackX[0] ?? -0.052, jackY, zBack - 0.0035)
    yellow.rotation.x = Math.PI / 2
    group.add(yellow)

    const white = new THREE.Mesh(coreGeoYellow, materials.keycap(0xd6d2c8))
    white.name = 'monitor-jack-audio'
    white.position.set(jackX[1] ?? -0.03, jackY, zBack - 0.0035)
    white.rotation.x = Math.PI / 2
    group.add(white)

    // Volume traseiro, como nos monitores compostos da época.
    const volumeGeo = knobGeometry(0.0058, 0.0072, 18)
    this.ownedGeometries.push(volumeGeo)
    const volume = new THREE.Mesh(volumeGeo, materials.keycap(0x2a2825))
    volume.name = 'monitor-volume'
    volume.position.set(0.006, jackY, zBack - 0.0016)
    volume.rotation.x = -Math.PI / 2
    volume.castShadow = true
    group.add(volume)

    const inletGeo = new THREE.BoxGeometry(0.024, 0.017, 0.009)
    this.ownedGeometries.push(inletGeo)
    const inlet = new THREE.Mesh(inletGeo, darkMat)
    inlet.name = 'monitor-entrada-ac'
    inlet.position.set(0.078, centreY - 0.02, zBack - 0.004)
    inlet.castShadow = true
    group.add(inlet)

    return group
  }

  /**
   * Cabo de força, em coordenadas do módulo (mesa em y = 0). Desce por trás,
   * encosta no tampo e some **sob o pedestal** — nunca termina no ar e nunca
   * invade o espaço dos outros módulos, que ficam todos à frente do monitor.
   */
  private buildPowerCord(materials: MaterialLibrary): THREE.Mesh {
    const start = this.shellToModule(0.078, this.rearCentreY() - 0.02, -DIM.depth - 0.008)
    const deskTouch = new THREE.Vector3(0.03, 0.0035, -0.276)
    const hanging = catenary(start, deskTouch, 0.06, 32)
    const curve = new THREE.CatmullRomCurve3([
      ...hanging,
      new THREE.Vector3(0.018, 0.003, -0.215),
    ], false, 'centripetal')
    const geometry = new THREE.TubeGeometry(curve, 40, 0.0024, 10, false)
    this.ownedGeometries.push(geometry)
    const cord = new THREE.Mesh(geometry, materials.rubber())
    cord.name = 'monitor-cabo-ac'
    cord.castShadow = true
    cord.receiveShadow = true
    return cord
  }

  /** Y central da traseira, no referencial H. */
  private rearCentreY(): number {
    return (shellTop(1) + shellBottom(1)) / 2
  }

  /** Converte um ponto do referencial H (gabinete inclinado) para o do módulo. */
  private shellToModule(x: number, y: number, z: number): THREE.Vector3 {
    const angle = THREE.MathUtils.degToRad(DIM.tiltDeg)
    const qy = y + DIM.base.top + DIM.front.halfH - DIM.pivot.y
    const qz = z - DIM.pivot.z
    return new THREE.Vector3(
      x,
      DIM.pivot.y + qy * Math.cos(angle) - qz * Math.sin(angle),
      DIM.pivot.z + qy * Math.sin(angle) + qz * Math.cos(angle),
    )
  }

  // -------------------------------------------------------------------------
  // Runtime
  // -------------------------------------------------------------------------

  public update(dt: number): boolean {
    const step = Math.max(0, Math.min(dt, 0.1))

    // Rampa de aquecimento: sobe devagar (o catodo leva ~1,5 s), cai rápido.
    const tau = this.powerOn ? WARMUP.rise : WARMUP.fall
    const target = this.powerOn ? 1 : 0
    const k = 1 - Math.exp(-step / tau)
    this.warmth += (target - this.warmth) * k
    if (!this.powerOn && this.warmth < 0.0015) this.warmth = 0

    this.syncScreenMaterial()
    this.syncScanlineCount()
    this.syncExposure()

    this.screenUniforms.uWarmth.value = Math.pow(clamp01(this.warmth), 1.35)

    if (this.ledMaterial !== null) {
      this.ledMaterial.emissiveIntensity = 16 * clamp01(this.warmth * 1.6)
    }
    if (this.ledLight !== null) {
      this.ledLight.intensity = 0.02 * clamp01(this.warmth * 1.6)
    }
    let rockerMoving = false
    if (this.rocker !== null) {
      // Basculante: a metade de cima afunda quando ligado.
      const goal = this.powerOn ? -0.16 : 0.16
      this.rocker.rotation.x += (goal - this.rocker.rotation.x) * (1 - Math.exp(-step / 0.05))
      // Snap: a exponencial nunca chega; 1e-4 rad é sub-pixel em qualquer pose.
      if (Math.abs(goal - this.rocker.rotation.x) < 1e-4) this.rocker.rotation.x = goal
      else rockerMoving = true
    }

    if (!this.lightParked) this.parkScreenLight()
    this.driveScreenLight()

    // Ligado (ou drenando fósforo), a tela é um vídeo — dirty por contrato. Só
    // desligado, frio e com o basculante assentado o módulo deixa o quadro dormir.
    return this.powerOn || this.warmth > 0 || rockerMoving
  }

  /**
   * A tela como fonte de luz de verdade (SPEC §6).
   *
   * A cor **e** a potência saem da média do quadro, que o `CrtProcessor` publica
   * na `userData` da textura. Isso é o que a revisão cobrou: com uma cor de
   * fósforo fixa, o queixo da moldura media vermelho acima de azul debaixo de um
   * raster azul — o contrário do que qualquer foto mostra.
   *
   * O emissor é apontado **para baixo** (ver `parkScreenLight`), e isso também é
   * física, não ajuste: a face é convexa, então o terço inferior do bulbo tem a
   * normal inclinada para baixo e é ele quem ilumina o queixo, o lábio interno da
   * moldura e a mesa logo à frente. Um emissor plano e estritamente frontal não
   * entrega irradiância nenhuma numa superfície coplanar com ele — daí a medição
   * da revisão de que o queixo estava mais vermelho que azul.
   */
  private driveScreenLight(): void {
    const average = this.readFrameAverage()
    const warm = clamp01(this.warmth)
    const power = Math.pow(warm, 1.6) * (0.55 + 0.75 * this.brightness)
    // Normaliza pelo **canal máximo**, não pela luminância. Normalizar por
    // luminância é o que um fotômetro faria, mas num campo azul do MSX a
    // luminância é 0,15 contra 0,8 de azul: a cor sairia com o canal azul em 5,3
    // e a moldura inteira lavava de azul-branco, mais clara que a luz principal.
    // Com o máximo em 1 a matiz continua exata e o nível fica limitado.
    const peak = Math.max(average.r, average.g, average.b)
    if (peak > 1e-4) {
      this.screenTint.setRGB(
        average.r / peak,
        average.g / peak,
        average.b / peak,
        THREE.LinearSRGBColorSpace,
      )
    } else {
      this.screenTint.setRGB(0.42, 0.62, 1.0, THREE.LinearSRGBColorSpace)
    }
    const emission = power * Math.min(1.25, peak * 1.35 + 0.05) * SCREEN_LIGHT_GAIN

    try {
      lightingModule.setScreenLight(emission, this.screenTint)
    } catch {
      // Sem rig de iluminação: a cena ainda funciona, só não há luz derramada.
    }
  }

  /** Média do quadro publicada pelo `CrtProcessor`, ou preto se não houver. */
  private readFrameAverage(): Readonly<FrameAverage> {
    const map = this.screenMaterial?.map
    if (map === null || map === undefined) return ZERO_AVERAGE
    const stamped: unknown = (map.userData as Record<string, unknown>)['crtFrameAverage']
    if (typeof stamped !== 'object' || stamped === null) return ZERO_AVERAGE
    const c = stamped as { r?: unknown; g?: unknown; b?: unknown }
    if (typeof c.r !== 'number' || typeof c.g !== 'number' || typeof c.b !== 'number') {
      return ZERO_AVERAGE
    }
    if (!Number.isFinite(c.r) || !Number.isFinite(c.g) || !Number.isFinite(c.b)) {
      return ZERO_AVERAGE
    }
    // `driveScreenLight()` consumes this immediately and never retains it; reusing one
    // private record removes a per-frame allocation without exposing mutable state.
    this.frameAverageScratch.r = c.r
    this.frameAverageScratch.g = c.g
    this.frameAverageScratch.b = c.b
    return this.frameAverageScratch
  }

  /**
   * A inversão da AgX depende da exposição fotométrica da cena: AgX multiplica
   * por `toneMappingExposure` antes de tudo, então o shader precisa dividir pelo
   * mesmo número. Ler do renderer a cada frame mantém a tela correta se a
   * exposição da cena mudar em tempo de execução.
   */
  private syncExposure(): void {
    const renderer = this.renderer
    if (renderer === null) return
    const exposure = renderer.toneMappingExposure
    if (Number.isFinite(exposure) && exposure > 0) {
      this.screenUniforms.uExposure.value = exposure
    }
  }

  /**
   * O material da tela pode ter sido trocado por outro módulo (emulador).
   * Reanexa o patch de brilho/contraste ao que estiver montado.
   */
  private syncScreenMaterial(): void {
    const mesh = this.screenMesh
    if (mesh === null) return
    const material = mesh.material
    if (Array.isArray(material) || !(material instanceof THREE.MeshBasicMaterial)) return
    if (material === this.screenMaterial) return
    this.screenMaterial = material
    attachScreenShader(material, this.screenUniforms)
  }

  /**
   * Casa a grade de varredura com a resolução do sinal.
   *
   * O `CrtProcessor` carimba a altura da fonte em `texture.userData`; se o
   * WebMSX (240 linhas) entrar no lugar do renderer procedural (192) no meio da
   * sessão, a contagem tem de acompanhar, senão a linha desenhada aqui bate
   * contra a linha de pixel da fonte e vira moiré. Sem o carimbo, mantemos as
   * 240 do campo NTSC — o padrão de um monitor de época.
   */
  private syncScanlineCount(): void {
    const map = this.screenMaterial?.map
    if (map === null || map === undefined) return
    const stamped: unknown = (map.userData as Record<string, unknown>)['crtSourceHeight']
    if (typeof stamped !== 'number' || !Number.isFinite(stamped)) return
    const lines = Math.min(400, Math.max(96, Math.round(stamped)))
    if (this.screenUniforms.uScanLines.value !== lines) {
      this.screenUniforms.uScanLines.value = lines
    }
  }

  /** Ancora o emissor de área da `LightingRig` na face real do tubo. */
  private parkScreenLight(): void {
    const mesh = this.screenMesh
    const group = this.group
    if (mesh === null || group === null) return
    group.updateMatrixWorld(true)

    // A malha da tela tem origem no referencial H, não no centro do raster:
    // a geometria foi transladada. O centro real é o ápice do fósforo.
    const cx = 0
    const cy = DIM.aperture.offsetY
    const cz = phosphorZ(0, 0)
    this.scratchPosition.set(cx, cy, cz + 0.02)
    mesh.localToWorld(this.scratchPosition)
    // Mira **abaixo** do eixo. A face do tubo é convexa: a metade de baixo do
    // bulbo tem a normal virada para baixo, e é ela que ilumina o queixo, o
    // lábio interno da moldura e a mesa à frente. Um emissor plano apontado no
    // eixo não entrega irradiância a nada coplanar com ele, e o resultado
    // medido era um queixo mais vermelho que azul debaixo de um raster azul.
    const reach = 0.4
    this.scratchTarget.set(cx, cy - reach * Math.tan(SCREEN_LIGHT_TILT), cz + reach)
    mesh.localToWorld(this.scratchTarget)

    try {
      lightingModule.setScreenLightSize(DIM.raster.halfW * 2, DIM.raster.halfH * 2)
      lightingModule.setScreenLightTransform(
        { x: this.scratchPosition.x, y: this.scratchPosition.y, z: this.scratchPosition.z },
        { x: this.scratchTarget.x, y: this.scratchTarget.y, z: this.scratchTarget.z },
      )
      // Os setters do rig são no-op silencioso enquanto ele não tiver construído
      // as luzes — só damos o emissor por ancorado quando ele existe de fato,
      // senão um rig que chega atrasado ficaria com a luz na origem para sempre.
      this.lightParked = lightingModule.lights !== null
    } catch {
      this.lightParked = false
    }
  }

  // -------------------------------------------------------------------------
  // API pública
  // -------------------------------------------------------------------------

  public setPower(on: boolean): void {
    this.powerOn = on
  }

  public togglePower(): boolean {
    this.powerOn = !this.powerOn
    return this.powerOn
  }

  public setScreenTexture(texture: THREE.Texture): void {
    if (texture.colorSpace === THREE.NoColorSpace) texture.colorSpace = THREE.SRGBColorSpace
    const material = this.screenMaterial
    if (material === null) return
    material.map = texture
    material.needsUpdate = true
  }

  public setBrightness(value: number): void {
    this.brightness = clamp01(value)
    this.applyControlValues()
  }

  public setContrast(value: number): void {
    this.contrast = clamp01(value)
    this.applyControlValues()
  }

  /** Traduz as posições dos botões em rotação de malha e ganho de fósforo. */
  private applyControlValues(): void {
    const sweep = THREE.MathUtils.degToRad(280)
    if (this.knobBrightness !== null) {
      this.knobBrightness.rotation.y = (this.brightness - 0.5) * sweep
    }
    if (this.knobContrast !== null) {
      this.knobContrast.rotation.y = (this.contrast - 0.5) * sweep
    }
    // CONTRASTE = ganho de vídeo, em espaço de **sinal**. O ponto de repouso é
    // 1,0 e não é arbitrário: com ganho 1 um campo de paleta sai da tela valendo
    // exatamente o seu hex sRGB (ver `crtDisplay`), que é o que a SPEC §5 pede.
    // A faixa vai de meio ganho a três vezes, que é o alcance de um botão de
    // contraste de época.
    this.screenUniforms.uContrast.value = 0.55 + 1.9 * (this.contrast * this.contrast)
    // BRILHO = nível de preto. Faixa pequena e centrada em zero, porque é isso
    // que o botão faz: no mínimo o preto some no vidro, no máximo o raster
    // inteiro ganha aquele véu cinza de monitor mal ajustado.
    this.screenUniforms.uBrightness.value = (this.brightness - 0.42) * 0.05
  }

  // -------------------------------------------------------------------------

  public dispose(): void {
    for (const geometry of this.ownedGeometries) geometry.dispose()
    this.ownedGeometries.length = 0
    for (const material of this.ownedMaterials) material.dispose()
    this.ownedMaterials.length = 0
    for (const texture of this.ownedTextures) texture.dispose()
    this.ownedTextures.length = 0

    this.ledLight?.dispose()

    this.group = null
    this.screenMesh = null
    this.glassMesh = null
    this.screenMaterial = null
    this.knobBrightness = null
    this.knobContrast = null
    this.rocker = null
    this.ledMaterial = null
    this.ledLight = null
    this.renderer = null
    this.lightParked = false
  }
}

// ---------------------------------------------------------------------------

/** Cria um monitor CRT novo. */
export function createCrtMonitor(): CrtMonitorModule {
  return new CrtMonitor()
}

/**
 * Instância padrão — é esta que o `main.ts` descobre e registra. Outros módulos
 * devem importar **esta** referência para falar com a tela.
 */
export const crtMonitorModule: CrtMonitorModule = createCrtMonitor()

export default createCrtMonitor
