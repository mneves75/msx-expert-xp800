/**
 * Geradores procedurais de textura — Gradiente Expert XP-800.
 *
 * Tudo aqui é gerado em código (ruído + canvas 2D). Nenhum arquivo binário é
 * baixado, o que mantém o orçamento de assets abaixo de 3 MB gzipado (SPEC §10).
 *
 * Convenções obrigatórias:
 *  - Mapas de cor / decalque (`map`)    → `SRGBColorSpace`
 *  - Normal / rugosidade / AO           → `NoColorSpace` (lineares)
 *  - Todo PRNG é semeado: a saída é determinística entre execuções.
 *
 * Os mapas de ruído são *tileáveis* (a treliça do ruído dá a volta), portanto
 * podem ser repetidos sem costura visível.
 */

import * as THREE from 'three'

import { drain, driveCooperatively } from '../core/cooperative'

// ---------------------------------------------------------------------------
// PRNG determinístico
// ---------------------------------------------------------------------------

/** mulberry32 — rápido, determinístico, uniforme em [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a — deriva sementes estáveis a partir de rótulos de texto. */
export function hashString(text: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// Sementes fixas: alterar um valor muda o visual de forma reproduzível.
const SEED_PEBBLE = 0x91f2a7
const SEED_ROUGH = 0x2c5be1
const SEED_SCRATCH = 0x7d31c9
const SEED_DUST = 0x4ab6f3
const SEED_WEAR = 0x1e9d44

// ---------------------------------------------------------------------------
// Campos escalares (height fields em ponto flutuante)
// ---------------------------------------------------------------------------

interface Field {
  readonly w: number
  readonly h: number
  readonly data: Float32Array
}

function makeField(w: number, h: number): Field {
  return { w, h, data: new Float32Array(w * h) }
}

function smoothT(t: number): number {
  return t * t * (3 - 2 * t)
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * Ruído de valor tileável, acumulado no campo com amplitude `amp`.
 *
 * Este e os demais construtores pesados são geradores: `yield` a cada linha
 * permite ao driver cooperativo (`driveCooperatively`) fatiar o trabalho em
 * tarefas curtas, enquanto `drain` reproduz o comportamento síncrono original.
 */
function* addValueNoise(f: Field, freq: number, amp: number, rng: () => number): Generator<void, void> {
  const lattice = new Float32Array(freq * freq)
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng()

  const { w, h, data } = f
  for (let y = 0; y < h; y++) {
    yield
    const fy = (y / h) * freq
    const fy0 = Math.floor(fy)
    const y0 = ((fy0 % freq) + freq) % freq
    const y1 = (y0 + 1) % freq
    const ty = smoothT(fy - fy0)
    for (let x = 0; x < w; x++) {
      const fx = (x / w) * freq
      const fx0 = Math.floor(fx)
      const x0 = ((fx0 % freq) + freq) % freq
      const x1 = (x0 + 1) % freq
      const tx = smoothT(fx - fx0)
      const a = lattice[y0 * freq + x0] ?? 0
      const b = lattice[y0 * freq + x1] ?? 0
      const c = lattice[y1 * freq + x0] ?? 0
      const d = lattice[y1 * freq + x1] ?? 0
      const top = a + (b - a) * tx
      const bottom = c + (d - c) * tx
      const i = y * w + x
      data[i] = (data[i] ?? 0) + (top + (bottom - top) * ty) * amp
    }
  }
}

/** fBm tileável, normalizado para ~[0, 1]. */
function* fbmField(
  w: number,
  h: number,
  baseFreq: number,
  octaves: number,
  gain: number,
  rng: () => number,
): Generator<void, Field> {
  const f = makeField(w, h)
  let freq = Math.max(2, Math.round(baseFreq))
  let amp = 1
  let total = 0
  for (let o = 0; o < octaves; o++) {
    if (freq > w) break
    yield* addValueNoise(f, freq, amp, rng)
    total += amp
    amp *= gain
    freq *= 2
  }
  if (total > 0) scaleField(f, 1 / total)
  return f
}

/**
 * Worley/celular tileável (distância F1 normalizada). Base do orange-peel:
 * células irregulares, não um padrão regular.
 */
function* worleyField(size: number, cells: number, rng: () => number, jitter = 1): Generator<void, Field> {
  const px = new Float32Array(cells * cells)
  const py = new Float32Array(cells * cells)
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const i = cy * cells + cx
      px[i] = (cx + 0.5 + (rng() - 0.5) * jitter) / cells
      py[i] = (cy + 0.5 + (rng() - 0.5) * jitter) / cells
    }
  }

  const f = makeField(size, size)
  const norm = cells / 1.15 // aproxima a distância máxima esperada
  for (let y = 0; y < size; y++) {
    yield
    const v = (y + 0.5) / size
    const cy = Math.min(cells - 1, Math.floor(v * cells))
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size
      const cx = Math.min(cells - 1, Math.floor(u * cells))
      let best = Number.POSITIVE_INFINITY
      for (let oy = -1; oy <= 1; oy++) {
        const gy = ((cy + oy) % cells + cells) % cells
        for (let ox = -1; ox <= 1; ox++) {
          const gx = ((cx + ox) % cells + cells) % cells
          const i = gy * cells + gx
          let dx = (px[i] ?? 0) - u
          let dy = (py[i] ?? 0) - v
          if (dx > 0.5) dx -= 1
          else if (dx < -0.5) dx += 1
          if (dy > 0.5) dy -= 1
          else if (dy < -0.5) dy += 1
          const d2 = dx * dx + dy * dy
          if (d2 < best) best = d2
        }
      }
      f.data[y * size + x] = clamp01(Math.sqrt(best) * norm)
    }
  }
  return f
}

function scaleField(f: Field, k: number): void {
  const { data } = f
  for (let i = 0; i < data.length; i++) data[i] = (data[i] ?? 0) * k
}

function normalize01(f: Field): void {
  const { data } = f
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (let i = 0; i < data.length; i++) {
    const v = data[i] ?? 0
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const span = hi - lo
  if (span <= 1e-8) return
  for (let i = 0; i < data.length; i++) data[i] = ((data[i] ?? 0) - lo) / span
}

/** Desfoque box separável com wrap — suaviza o campo antes do Sobel. */
function* blurField(f: Field, radius: number): Generator<void, void> {
  if (radius < 1) return
  const { w, h, data } = f
  const tmp = new Float32Array(data.length)
  const n = radius * 2 + 1
  for (let y = 0; y < h; y++) {
    yield
    const row = y * w
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let k = -radius; k <= radius; k++) s += data[row + ((x + k + w) % w)] ?? 0
      tmp[row + x] = s / n
    }
  }
  for (let y = 0; y < h; y++) {
    yield
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let k = -radius; k <= radius; k++) s += tmp[(((y + k + h) % h) * w) + x] ?? 0
      data[y * w + x] = s / n
    }
  }
}

// ---------------------------------------------------------------------------
// Emissores de textura
// ---------------------------------------------------------------------------

let defaultAnisotropy = 8

/**
 * Define a anisotropia aplicada a toda textura criada a partir daqui.
 * `Materials.ts` chama isto com o limite real do renderer.
 */
export function setDefaultAnisotropy(value: number): void {
  defaultAnisotropy = Math.max(1, Math.floor(value))
}

function finishTexture(
  tex: THREE.Texture,
  colorSpace: THREE.ColorSpace,
  wrap: THREE.Wrapping,
): void {
  tex.colorSpace = colorSpace
  tex.wrapS = wrap
  tex.wrapT = wrap
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = defaultAnisotropy
  tex.needsUpdate = true
}

function makeDataTexture(
  rgba: Uint8Array,
  w: number,
  h: number,
  wrap: THREE.Wrapping,
): THREE.DataTexture {
  const tex = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat, THREE.UnsignedByteType)
  // DataTexture nasce com flipY=false; as linhas já são escritas na ordem certa.
  finishTexture(tex, THREE.NoColorSpace, wrap)
  return tex
}

/**
 * Converte um height field em normal map tangente (convenção OpenGL, +Y para
 * cima). `flipRows` alinha o resultado a um CanvasTexture (que usa flipY=true).
 */
function* heightToNormalTexture(
  f: Field,
  strength: number,
  wrap: THREE.Wrapping,
  flipRows: boolean,
): Generator<void, THREE.DataTexture> {
  const { w, h, data } = f
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    yield
    const up = ((y - 1 + h) % h) * w
    const down = ((y + 1) % h) * w
    const row = y * w
    const outRow = (flipRows ? h - 1 - y : y) * w
    for (let x = 0; x < w; x++) {
      const xl = (x - 1 + w) % w
      const xr = (x + 1) % w
      const dx = ((data[row + xr] ?? 0) - (data[row + xl] ?? 0)) * 0.5 * strength
      const dy = ((data[down + x] ?? 0) - (data[up + x] ?? 0)) * 0.5 * strength
      // N = normalize(-dh/du, -dh/dv, 1); v cresce para cima, linha cresce para baixo.
      let nx = -dx
      let ny = dy
      const nz = 1
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1)
      nx *= inv
      ny *= inv
      const o = (outRow + x) * 4
      rgba[o] = Math.round((nx * 0.5 + 0.5) * 255)
      rgba[o + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      rgba[o + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255)
      rgba[o + 3] = 255
    }
  }
  return makeDataTexture(rgba, w, h, wrap)
}

/** Campo escalar → textura cinza (R=G=B=valor). Serve para roughness/AO/metal. */
function* grayTexture(f: Field, wrap: THREE.Wrapping, flipRows: boolean): Generator<void, THREE.DataTexture> {
  const { w, h, data } = f
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    yield
    const row = y * w
    const outRow = (flipRows ? h - 1 - y : y) * w
    for (let x = 0; x < w; x++) {
      const v = Math.round(clamp01(data[row + x] ?? 0) * 255)
      const o = (outRow + x) * 4
      rgba[o] = v
      rgba[o + 1] = v
      rgba[o + 2] = v
      rgba[o + 3] = 255
    }
  }
  return makeDataTexture(rgba, w, h, wrap)
}

// ---------------------------------------------------------------------------
// Cache — as texturas são caras de gerar e devem ser compartilhadas
// ---------------------------------------------------------------------------

const cache = new Map<string, unknown>()

function disposeValue(value: unknown): void {
  if (value instanceof THREE.Texture) {
    value.dispose()
    return
  }
  if (typeof value === 'object' && value !== null && !ArrayBuffer.isView(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) disposeValue(v)
  }
}

/**
 * Cache dos height fields intermediários. Vários geradores partem do mesmo
 * campo (o grão pebble custa ~200 ms a 1024²), então nunca recalculamos.
 */
const fieldCache = new Map<string, Field>()

function* memoField(key: string, build: () => Generator<void, Field>): Generator<void, Field> {
  const hit = fieldCache.get(key)
  if (hit !== undefined) return hit
  const made = yield* build()
  fieldCache.set(key, made)
  return made
}

/**
 * Variante em gerador do `memo`: o mesmo cache, a mesma chave, mas o corpo pode
 * ser percorrido tanto por `drain` (síncrono) quanto por `driveCooperatively`
 * (pré-aquecimento fatiado). Quem chegar depois encontra o resultado pronto.
 */
function* memoSteps<T>(key: string, build: () => Generator<void, T>): Generator<void, T> {
  const hit = cache.get(key)
  if (hit !== undefined) return hit as T
  const made = yield* build()
  cache.set(key, made)
  return made
}

/** Libera todas as texturas procedurais em cache. */
export function disposeTextureCache(): void {
  for (const value of cache.values()) disposeValue(value)
  cache.clear()
  fieldCache.clear()
}

// ---------------------------------------------------------------------------
// Grão de pele-de-laranja (ABS injetado, anos 80)
// ---------------------------------------------------------------------------

/**
 * Height field do grão. Duas camadas Worley em escalas diferentes (células
 * irregulares) + fBm fino, para que o padrão nunca leia como regular.
 */
function* pebbleHeightField(size: number, seed: number): Generator<void, Field> {
  const rng = createRng(seed)
  const coarse = yield* worleyField(size, Math.max(8, Math.round(size / 18)), rng, 1)
  const fine = yield* worleyField(size, Math.max(12, Math.round(size / 11)), rng, 1)
  const micro = yield* fbmField(size, size, 24, 4, 0.5, rng)

  const f = makeField(size, size)
  for (let i = 0; i < f.data.length; i++) {
    const c = coarse.data[i] ?? 0
    const d = fine.data[i] ?? 0
    const m = micro.data[i] ?? 0
    // smoothstep nas células achata os topos e arredonda os vales → casca de laranja
    f.data[i] = 0.52 * smoothT(c) + 0.30 * smoothT(d) + 0.18 * m
  }
  yield* blurField(f, 1)
  normalize01(f)
  return f
}

/**
 * Normal map do grão pebble/orange-peel do ABS. Fino e irregular — é isto que
 * impede o plástico de ler como CG.
 *
 * @param size  resolução em px (potência de dois)
 * @param intensity multiplicador da inclinação das facetas (1 = padrão)
 */
export function pebbleGrain(size = 1024, intensity = 1): THREE.DataTexture {
  return drain(pebbleGrainSteps(size, intensity))
}

function* pebbleGrainSteps(size: number, intensity: number): Generator<void, THREE.DataTexture> {
  return yield* memoSteps(`pebble:${size}:${intensity}`, function* () {
    const field = yield* memoField(`pebbleH:${size}`, () => pebbleHeightField(size, SEED_PEBBLE))
    return yield* heightToNormalTexture(field, 6.5 * intensity, THREE.RepeatWrapping, false)
  })
}

// ---------------------------------------------------------------------------
// Variação de rugosidade
// ---------------------------------------------------------------------------

/**
 * Manchas suaves de rugosidade. O mapa é *multiplicativo* em three.js, então a
 * faixa de saída define quanto a rugosidade do material pode cair:
 * `roughness_final = material.roughness * valor`.
 *
 * @param min valor mínimo do mapa (padrão 0.78 → queda de 22%)
 * @param max valor máximo do mapa (padrão 1.0 → pico igual ao do material)
 */
export function roughnessVariation(size = 1024, min = 0.78, max = 1): THREE.DataTexture {
  return drain(
    memoSteps(`rough:${size}:${min}:${max}`, function* () {
      const rng = createRng(SEED_ROUGH)
      const blotch = yield* fbmField(size, size, 3, 4, 0.5, rng)
      const mid = yield* fbmField(size, size, 11, 3, 0.5, rng)
      const f = makeField(size, size)
      for (let i = 0; i < f.data.length; i++) {
        const b = blotch.data[i] ?? 0
        const m = mid.data[i] ?? 0
        // pow acentua as manchas sem criar bordas duras
        f.data[i] = Math.pow(clamp01(0.72 * b + 0.28 * m), 1.35)
      }
      normalize01(f)
      for (let i = 0; i < f.data.length; i++) f.data[i] = min + (max - min) * (f.data[i] ?? 0)
      return yield* grayTexture(f, THREE.RepeatWrapping, false)
    }),
  )
}

// ---------------------------------------------------------------------------
// Microarranhões
// ---------------------------------------------------------------------------

function createCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx === null) throw new Error('Não foi possível obter o contexto 2D do canvas.')
  return { canvas, ctx }
}

/** Campo de arranhões (0 = intacto, 1 = sulco). Desenhado com wrap nos 8 vizinhos. */
function* scratchHeightField(size: number, density: number): Generator<void, Field> {
  const { canvas, ctx } = createCanvas(size, size)
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, size, size)
  ctx.lineCap = 'round'

  const rng = createRng(SEED_SCRATCH)
  const scale = size / 1024
  const count = Math.max(0, Math.round(520 * density * scale))
  const offsets = [-size, 0, size]

  const stroke = (
    x: number,
    y: number,
    angle: number,
    length: number,
    width: number,
    alpha: number,
  ): void => {
    ctx.lineWidth = width
    ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`
    const dx = Math.cos(angle) * length
    const dy = Math.sin(angle) * length
    // leve arco: um arranhão real quase nunca é perfeitamente reto
    const bow = (rng() - 0.5) * length * 0.06
    for (const ox of offsets) {
      for (const oy of offsets) {
        ctx.beginPath()
        ctx.moveTo(x + ox, y + oy)
        ctx.quadraticCurveTo(
          x + ox + dx * 0.5 - dy * 0.06 + bow,
          y + oy + dy * 0.5 + dx * 0.06 + bow,
          x + ox + dx,
          y + oy + dy,
        )
        ctx.stroke()
      }
    }
  }

  // Banda direcional dominante (sentido do pano de limpeza) + rebeldes.
  for (let i = 0; i < count; i++) {
    if (i % 32 === 0) yield
    const rogue = rng() < 0.14
    const angle = rogue ? rng() * Math.PI : (rng() - 0.5) * 0.34
    const t = rng()
    stroke(
      rng() * size,
      rng() * size,
      angle,
      size * (0.015 + t * t * t * 0.42),
      (0.5 + rng() * 1.1) * scale,
      0.05 + rng() * 0.26,
    )
  }
  // Poucos riscos profundos, bem visíveis em ângulo rasante.
  const deep = Math.max(1, Math.round(9 * density * scale))
  for (let i = 0; i < deep; i++) {
    stroke(
      rng() * size,
      rng() * size,
      (rng() - 0.5) * 0.5,
      size * (0.18 + rng() * 0.5),
      (0.9 + rng() * 1.4) * scale,
      0.45 + rng() * 0.4,
    )
  }

  const img = ctx.getImageData(0, 0, size, size).data
  const f = makeField(size, size)
  for (let i = 0; i < f.data.length; i++) f.data[i] = (img[i * 4] ?? 0) / 255
  canvas.width = 0
  canvas.height = 0
  return f
}

/** Normal + rugosidade dos microarranhões. */
export interface ScratchMaps {
  /** Sulcos rasos — visíveis apenas em ângulo rasante. */
  readonly normalMap: THREE.DataTexture
  /** Multiplicador: o sulco é polido, então a rugosidade cai dentro dele. */
  readonly roughnessMap: THREE.DataTexture
}

/**
 * Arranhões finos e direcionais para as superfícies superiores.
 * @param density 0 = nenhum, 1 = uso pesado de 40 anos
 */
export function microScratches(size = 1024, density = 0.5): ScratchMaps {
  return drain(microScratchesSteps(size, density))
}

/** Variante cooperativa de {@link microScratches} — mesmo cache, mesmas chaves. */
export function microScratchesAsync(size = 1024, density = 0.5): Promise<ScratchMaps> {
  return driveCooperatively(microScratchesSteps(size, density))
}

function* microScratchesSteps(size: number, density: number): Generator<void, ScratchMaps> {
  return yield* memoSteps(`scratch:${size}:${density}`, function* () {
    const f = yield* scratchHeightField(size, density)
    // Sulco = altura negativa.
    const height = makeField(size, size)
    for (let i = 0; i < height.data.length; i++) height.data[i] = -(f.data[i] ?? 0)
    const rough = makeField(size, size)
    for (let i = 0; i < rough.data.length; i++) rough.data[i] = 1 - (f.data[i] ?? 0) * 0.45
    return {
      normalMap: yield* heightToNormalTexture(height, 1.6, THREE.RepeatWrapping, false),
      roughnessMap: yield* grayTexture(rough, THREE.RepeatWrapping, false),
    }
  })
}

// ---------------------------------------------------------------------------
// Poeira
// ---------------------------------------------------------------------------

export interface DustOptions {
  /** Concentração das manchas. 0.5 = padrão. */
  readonly coverage?: number
  /**
   * Faixa de saída `[valorSemPoeira, valorComPoeira]`. O padrão `[0, 1]` devolve
   * densidade de poeira. Passar `[1, 0.88]` devolve um mapa de oclusão pronto
   * para `aoMap` (invertido, sujeira escurece a luz indireta).
   */
  readonly range?: readonly [number, number]
  readonly seed?: number
}

/** Poeira assentada: manchas macias em escala grande + salpico fino. */
export function dustAccumulation(size = 1024, opts: DustOptions = {}): THREE.DataTexture {
  return drain(dustAccumulationSteps(size, opts))
}

/** Variante cooperativa de {@link dustAccumulation} — mesmo cache, mesmas chaves. */
export function dustAccumulationAsync(size = 1024, opts: DustOptions = {}): Promise<THREE.DataTexture> {
  return driveCooperatively(dustAccumulationSteps(size, opts))
}

function* dustAccumulationSteps(size: number, opts: DustOptions): Generator<void, THREE.DataTexture> {
  const coverage = opts.coverage ?? 0.5
  const lo = opts.range?.[0] ?? 0
  const hi = opts.range?.[1] ?? 1
  const seed = opts.seed ?? SEED_DUST
  return yield* memoSteps(`dust:${size}:${coverage}:${lo}:${hi}:${seed}`, function* () {
    const rng = createRng(seed)
    const clouds = yield* fbmField(size, size, 4, 5, 0.55, rng)
    const speck = yield* worleyField(size, Math.max(16, Math.round(size / 8)), rng, 1)
    const f = makeField(size, size)
    for (let i = 0; i < f.data.length; i++) {
      const c = clouds.data[i] ?? 0
      // grãozinhos: só o núcleo das células vira partícula
      const g = 1 - smoothT(clamp01((speck.data[i] ?? 0) * 1.6))
      f.data[i] = clamp01(Math.pow(c, 2.1 - coverage) * 0.82 + g * 0.28 * c)
    }
    normalize01(f)
    yield* blurField(f, 1)
    for (let i = 0; i < f.data.length; i++) f.data[i] = lo + (hi - lo) * clamp01(f.data[i] ?? 0)
    return yield* grayTexture(f, THREE.RepeatWrapping, false)
  })
}

// ---------------------------------------------------------------------------
// Decalques (silkscreen e legendas de tecla)
// ---------------------------------------------------------------------------

/**
 * Conjunto de mapas de um decalque. A arte fica em `map` (com alfa), e a tinta
 * é levemente *saliente* (`normalMap`) e um pouco mais brilhante que o
 * substrato (`roughnessMap`), como serigrafia real sobre ABS.
 */
export interface DecalMaps {
  readonly map: THREE.CanvasTexture
  readonly normalMap: THREE.DataTexture
  readonly roughnessMap: THREE.DataTexture
}

/** Callback de desenho. Coordenadas em px do canvas, origem no canto superior esquerdo. */
export type DecalDraw = (ctx: CanvasRenderingContext2D, width: number, height: number) => void

export interface SilkscreenOptions {
  readonly width?: number
  readonly height?: number
  /** Cor da tinta. Serigrafia branca real nunca é branco puro. */
  readonly ink?: string
  /** Força do relevo da tinta no normal map. */
  readonly relief?: number
  /** 0 = impressão perfeita, 1 = muito gasta/falhada. */
  readonly wear?: number
  /** Quanto a tinta reduz a rugosidade do substrato (0..1). */
  readonly gloss?: number
  readonly seed?: number
  /** Se informado, o resultado é memoizado sob esta chave. */
  readonly cacheKey?: string
}

const DEFAULT_INK = '#EAE7DF'

function* decalMapsFromCanvas(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  wear: number,
  relief: number,
  gloss: number,
  seed: number,
): Generator<void, DecalMaps> {
  const w = canvas.width
  const h = canvas.height
  const image = ctx.getImageData(0, 0, w, h)
  const px = image.data

  if (wear > 0) {
    const rng = createRng(seed)
    const grain = yield* fbmField(w, h, Math.max(8, Math.round(w / 12)), 3, 0.55, rng)
    normalize01(grain)
    for (let i = 0; i < w * h; i++) {
      const a = px[i * 4 + 3] ?? 0
      if (a === 0) continue
      const n = grain.data[i] ?? 0
      // Falhas do tampo de impressão: bordas comem primeiro, com micro-furos.
      const eaten = 1 - wear * (1 - n) * (1 - n) * 1.6
      px[i * 4 + 3] = Math.max(0, Math.round(a * clamp01(eaten)))
    }
  }
  ctx.putImageData(image, 0, 0)

  const height = makeField(w, h)
  const rough = makeField(w, h)
  for (let i = 0; i < w * h; i++) {
    const a = (px[i * 4 + 3] ?? 0) / 255
    height.data[i] = a
    rough.data[i] = 1 - a * gloss
  }
  if (Math.min(w, h) >= 512) yield* blurField(height, 1)

  const map = new THREE.CanvasTexture(canvas)
  finishTexture(map, THREE.SRGBColorSpace, THREE.ClampToEdgeWrapping)

  return {
    map,
    // flipRows=true: DataTexture usa flipY=false, CanvasTexture usa flipY=true.
    normalMap: yield* heightToNormalTexture(height, relief, THREE.ClampToEdgeWrapping, true),
    roughnessMap: yield* grayTexture(rough, THREE.ClampToEdgeWrapping, true),
  }
}

/**
 * Renderiza arte de serigrafia branca e devolve `{map, normalMap, roughnessMap}`.
 * O callback recebe um contexto já configurado com a cor da tinta.
 */
export function silkscreenDecal(draw: DecalDraw, opts: SilkscreenOptions = {}): DecalMaps {
  return drain(silkscreenDecalSteps(draw, opts))
}

/** Variante cooperativa de {@link silkscreenDecal} — mesmo cache, mesmas chaves. */
export function silkscreenDecalAsync(draw: DecalDraw, opts: SilkscreenOptions = {}): Promise<DecalMaps> {
  return driveCooperatively(silkscreenDecalSteps(draw, opts))
}

function* silkscreenDecalSteps(draw: DecalDraw, opts: SilkscreenOptions): Generator<void, DecalMaps> {
  const w = opts.width ?? 1024
  const h = opts.height ?? opts.width ?? 1024
  const ink = opts.ink ?? DEFAULT_INK
  const wear = opts.wear ?? 0.18
  const relief = opts.relief ?? 3.2
  const gloss = opts.gloss ?? 0.45
  const seed = opts.seed ?? SEED_WEAR

  function* build(): Generator<void, DecalMaps> {
    const { canvas, ctx } = createCanvas(w, h)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = ink
    ctx.strokeStyle = ink
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    ctx.font = `${Math.round(h * 0.06)}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    draw(ctx, w, h)
    yield
    return yield* decalMapsFromCanvas(canvas, ctx, wear, relief, gloss, seed)
  }

  const key = opts.cacheKey
  if (key === undefined) return yield* build()
  return yield* memoSteps(`silk:${key}:${w}x${h}:${wear}:${relief}:${gloss}`, build)
}

// ---------------------------------------------------------------------------
// Legendas de teclado (pad printing)
// ---------------------------------------------------------------------------

export interface KeycapLegendOptions {
  /** Resolução da célula em px. 256 avulso, 128 no atlas. */
  readonly size?: number
  /** Legenda secundária (símbolo de shift), impressa acima da principal. */
  readonly secondary?: string
  /** Escala da fonte relativa à célula (1 = padrão). */
  readonly fontScale?: number
  readonly ink?: string
  /** 0 = nova de fábrica, 1 = quase apagada. */
  readonly wear?: number
  readonly seed?: number
}

const LEGEND_FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif'

function fitFont(ctx: CanvasRenderingContext2D, text: string, px: number, maxWidth: number): number {
  let size = px
  ctx.font = `${size.toFixed(1)}px ${LEGEND_FONT}`
  let measured = ctx.measureText(text).width
  while (measured > maxWidth && size > 4) {
    size *= maxWidth / measured
    ctx.font = `${size.toFixed(1)}px ${LEGEND_FONT}`
    measured = ctx.measureText(text).width
  }
  return size
}

/** Desenha uma legenda (com quebra por `\n`) centrada num retângulo. */
function drawLegendBlock(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  boxW: number,
  px: number,
): void {
  const lines = text.split('\n')
  const lineH = px * 1.12
  const top = cy - ((lines.length - 1) * lineH) / 2
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const size = fitFont(ctx, line, px, boxW)
    const width = ctx.measureText(line).width
    ctx.fillText(line, cx - width / 2, top + i * lineH + size * 0.36)
  }
}

function drawLegendCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  primary: string,
  secondary: string | undefined,
  fontScale: number,
  rng: () => number,
): void {
  ctx.save()
  // Desregistro do tampo: giro e deslocamento minúsculos, como impressão real.
  ctx.translate(x + w / 2 + (rng() - 0.5) * w * 0.012, y + h / 2 + (rng() - 0.5) * h * 0.012)
  ctx.rotate((rng() - 0.5) * 0.014)
  ctx.translate(-w / 2, -h / 2)

  if (secondary === undefined) {
    drawLegendBlock(ctx, primary, w * 0.5, h * 0.5, w * 0.82, h * 0.34 * fontScale)
  } else {
    drawLegendBlock(ctx, secondary, w * 0.36, h * 0.29, w * 0.5, h * 0.27 * fontScale)
    drawLegendBlock(ctx, primary, w * 0.36, h * 0.68, w * 0.5, h * 0.31 * fontScale)
  }
  ctx.restore()
}

/**
 * Legenda de keycap impressa por tampografia, levemente irregular e gasta.
 * Para os 89 caps prefira `keycapLegendAtlas` — uma textura só, instanciável.
 */
export function keycapLegend(char: string, opts: KeycapLegendOptions = {}): DecalMaps {
  const size = opts.size ?? 256
  const secondary = opts.secondary
  const fontScale = opts.fontScale ?? 1
  const wear = opts.wear ?? 0.3
  const seed = opts.seed ?? hashString(`${char}|${secondary ?? ''}`)

  return silkscreenDecal(
    (ctx, w, h) => {
      const rng = createRng(seed)
      drawLegendCell(ctx, 0, 0, w, h, char, secondary, fontScale, rng)
    },
    {
      width: size,
      height: size,
      ink: opts.ink ?? '#E8E6DE',
      wear,
      relief: 1.6,
      gloss: 0.5,
      seed,
      cacheKey: `key:${char}|${secondary ?? ''}|${fontScale}|${size}|${wear}`,
    },
  )
}

export interface LegendSpec {
  /** Identificador da tecla, ex. 'KeyA', 'Enter', 'F1'. */
  readonly id: string
  readonly primary: string
  readonly secondary?: string
  readonly fontScale?: number
}

export interface LegendAtlas {
  readonly maps: DecalMaps
  /** `id` → (offsetU, offsetV, repeatU, repeatV) para `texture.offset/repeat`. */
  readonly cells: ReadonlyMap<string, THREE.Vector4>
  readonly atlasSize: number
  readonly cellSize: number
}

export interface LegendAtlasOptions {
  readonly cellSize?: number
  readonly ink?: string
  readonly wear?: number
}

/**
 * Empacota várias legendas numa textura única para permitir instanciar os
 * keycaps mantendo o orçamento de draw calls (SPEC §10).
 */
export function keycapLegendAtlas(
  legends: readonly LegendSpec[],
  opts: LegendAtlasOptions = {},
): LegendAtlas {
  const cell = opts.cellSize ?? 128
  const cols = Math.max(1, Math.ceil(Math.sqrt(legends.length)))
  let atlas = cell * cols
  atlas = Math.pow(2, Math.ceil(Math.log2(Math.max(cell, atlas))))
  const perRow = Math.max(1, Math.floor(atlas / cell))

  const cells = new Map<string, THREE.Vector4>()
  const uv = cell / atlas
  legends.forEach((spec, i) => {
    const gx = i % perRow
    const gy = Math.floor(i / perRow)
    cells.set(spec.id, new THREE.Vector4(gx * uv, 1 - (gy + 1) * uv, uv, uv))
  })

  const maps = silkscreenDecal(
    (ctx) => {
      legends.forEach((spec, i) => {
        const gx = i % perRow
        const gy = Math.floor(i / perRow)
        const rng = createRng(hashString(spec.id))
        drawLegendCell(
          ctx,
          gx * cell,
          gy * cell,
          cell,
          cell,
          spec.primary,
          spec.secondary,
          spec.fontScale ?? 1,
          rng,
        )
      })
    },
    {
      width: atlas,
      height: atlas,
      ink: opts.ink ?? '#E8E6DE',
      wear: opts.wear ?? 0.3,
      relief: 1.6,
      gloss: 0.5,
      seed: SEED_WEAR,
      cacheKey: `atlas:${cell}:${legends.map((l) => `${l.id}${l.primary}${l.secondary ?? ''}`).join(',')}`,
    },
  )

  return { maps, cells, atlasSize: atlas, cellSize: cell }
}

// ---------------------------------------------------------------------------
// Conjunto composto de superfície (o que os materiais realmente usam)
// ---------------------------------------------------------------------------

/** Trio pronto para plugar num `MeshPhysicalMaterial`. */
export interface SurfaceMaps {
  readonly normalMap: THREE.DataTexture
  readonly roughnessMap: THREE.DataTexture
  readonly aoMap: THREE.DataTexture
}

export interface SurfaceOptions {
  readonly size?: number
  /** Multiplicador do relevo do grão pebble. */
  readonly grain?: number
  /** 0..1 — quantidade de microarranhões. */
  readonly scratchDensity?: number
  /** 0..1 — quanta poeira/sujeira entra na rugosidade e na oclusão. */
  readonly dust?: number
  /** Faixa multiplicativa da rugosidade (padrão `[0.78, 1]`). */
  readonly roughnessRange?: readonly [number, number]
}

/**
 * Compõe grão + arranhões + poeira num único trio de mapas. Compor os campos
 * *antes* do Sobel evita empilhar samplers e mantém o custo de GPU baixo,
 * além de dar um normal fisicamente coerente (um único height field).
 */
export function caseSurfaceMaps(opts: SurfaceOptions = {}): SurfaceMaps {
  return drain(caseSurfaceMapsSteps(opts))
}

/**
 * Variante cooperativa de {@link caseSurfaceMaps}: gera os mesmos mapas, nas
 * mesmas chaves de cache, mas fatiada em tarefas curtas. É o coração do
 * pré-aquecimento do boot — quem chamar a versão síncrona depois acha tudo
 * pronto e não paga nada.
 */
export function caseSurfaceMapsAsync(opts: SurfaceOptions = {}): Promise<SurfaceMaps> {
  return driveCooperatively(caseSurfaceMapsSteps(opts))
}

function* caseSurfaceMapsSteps(opts: SurfaceOptions): Generator<void, SurfaceMaps> {
  const size = opts.size ?? 1024
  const grain = opts.grain ?? 1
  const scratchDensity = opts.scratchDensity ?? 0.55
  const dust = opts.dust ?? 0.5
  const rLo = opts.roughnessRange?.[0] ?? 0.78
  const rHi = opts.roughnessRange?.[1] ?? 1

  return yield* memoSteps(`surface:${size}:${grain}:${scratchDensity}:${dust}:${rLo}:${rHi}`, function* () {
    const pebble = yield* memoField(`pebbleH:${size}`, () => pebbleHeightField(size, SEED_PEBBLE))
    const scratch = yield* memoField(`scratchH:${size}:${scratchDensity}`, () =>
      scratchHeightField(size, scratchDensity),
    )
    const dirt = yield* memoField(`dustH:${size}`, function* () {
      const rng = createRng(SEED_DUST)
      const clouds = yield* fbmField(size, size, 4, 5, 0.55, rng)
      const speck = yield* worleyField(size, Math.max(16, Math.round(size / 8)), rng, 1)
      const f = makeField(size, size)
      for (let i = 0; i < f.data.length; i++) {
        const c = clouds.data[i] ?? 0
        const g = 1 - smoothT(clamp01((speck.data[i] ?? 0) * 1.6))
        f.data[i] = clamp01(Math.pow(c, 1.7) * 0.82 + g * 0.28 * c)
      }
      normalize01(f)
      return f
    })
    const variation = yield* memoField(`roughV:${size}`, function* () {
      const rng = createRng(SEED_ROUGH)
      const blotch = yield* fbmField(size, size, 3, 4, 0.5, rng)
      const mid = yield* fbmField(size, size, 11, 3, 0.5, rng)
      const f = makeField(size, size)
      for (let i = 0; i < f.data.length; i++) {
        const b = blotch.data[i] ?? 0
        const m = mid.data[i] ?? 0
        f.data[i] = Math.pow(clamp01(0.72 * b + 0.28 * m), 1.35)
      }
      normalize01(f)
      return f
    })

    /**
     * Segunda oitava, ~5× mais fina que o grão pebble e **exclusiva da
     * rugosidade**. Na escala de tiling usada pelo gabinete (um tile a cada
     * 10 mm) esta oitava fica em torno de 0.03 mm: sub-pixel em qualquer
     * enquadramento realista, portanto entra como quebra de brilho e nunca
     * como normal — é isso que dá o lustro macio e desigual do ABS real, sem
     * aliasing especular.
     */
    const micro = yield* memoField(`microRoughH:${size}`, function* () {
      const rng = createRng(SEED_ROUGH ^ 0x5a5a5a)
      // 9 px per cell is the floor: below that the Worley distance field is so
      // heavily quantised by the sampling grid that it stops being cellular and
      // starts being a visible diamond lattice.
      return yield* worleyField(size, Math.max(48, Math.round(size / 9)), rng, 1)
    })

    const n = size * size
    const height = makeField(size, size)
    const rough = makeField(size, size)
    const ao = makeField(size, size)
    for (let i = 0; i < n; i++) {
      const s = scratch.data[i] ?? 0
      const d = (dirt.data[i] ?? 0) * dust
      height.data[i] = (pebble.data[i] ?? 0) * grain - s * 0.14
      // Base manchada, sulco polido (cai), poeira fosca (sobe) — depois recortada
      // na faixa multiplicativa para que o pico continue igual ao do material.
      const base = rLo + (rHi - rLo) * (variation.data[i] ?? 0)
      const fine = 0.94 + 0.06 * (micro.data[i] ?? 0)
      rough.data[i] = clamp01(base * fine * (1 - s * 0.42) * (1 + d * 0.14))
      ao.data[i] = clamp01(1 - d * 0.22)
    }

    return {
      normalMap: yield* heightToNormalTexture(height, 6.5, THREE.RepeatWrapping, false),
      roughnessMap: yield* grayTexture(rough, THREE.RepeatWrapping, false),
      aoMap: yield* grayTexture(ao, THREE.RepeatWrapping, false),
    }
  })
}
