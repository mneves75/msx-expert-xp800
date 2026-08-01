/**
 * Cartuchos MSX — Gradiente Expert XP-800.
 *
 * Um cartucho MSX de 1985 é uma casca de ABS em duas metades (tampa + fundo) com
 * uma língua de placa impressa saindo pela ponta de inserção. Este módulo constrói
 * quatro cartuchos distintos, todos procedurais: geometria de extrusão para a
 * casca (com o filete real das arestas e a linha de junção das metades), nervuras
 * de pega em geometria de verdade nas laterais, etiqueta de PAPEL com espessura
 * visível e canto levantado, e o conector de borda com 50 contatos dourados
 * instanciados, gastos na ponta que entra no compartimento.
 *
 * Sistema de coordenadas local de cada cartucho (SPEC §1, metros, Y para cima):
 *
 *   +X  largura   (0.090)          origem no centro da casca de plástico
 *   +Y  espessura (0.0155)         etiqueta virada para +Y
 *   -Z  inserção  → o nariz e o conector apontam para -Z, ou seja, para dentro
 *                    da máquina quando o cartucho é empurrado no compartimento
 *
 *   plástico:  z ∈ [-0.035, +0.035]
 *   placa:     z ∈ [-0.047, -0.029]   (0.012 de língua exposta)
 *
 * Tudo aqui é gerado em código — nenhum arquivo de textura ou modelo é baixado
 * (SPEC §10). As artes das etiquetas são desenhadas em canvas 2D simulando
 * impressão offset dos anos 80: chapa de fundo, chapa de tinta e um pequeno
 * erro de registro entre elas.
 *
 * Nada de iluminação assada no albedo: a rugosidade do papel é independente da
 * cor, e o único "escurecimento" pintado é sujeira/envelhecimento de verdade.
 */

import * as THREE from 'three'

import { yieldToMain } from '../core/cooperative'
import type { InteractiveUserData, MaterialLibrary, ModuleContext, SceneModule } from '../core/types'

// ---------------------------------------------------------------------------
// Dimensões (metros)
// ---------------------------------------------------------------------------

/**
 * Medidas externas do cartucho. Publicadas para que o compartimento do console e
 * a animação de inserção possam se alinhar sem adivinhar nada.
 */
export const CARTRIDGE_DIMENSIONS = {
  /** Largura da casca. */
  width: 0.09,
  /** Espessura do corpo (a região do nariz é mais fina). */
  thickness: 0.0155,
  /** Espessura da região do nariz, a que entra na fenda. */
  noseThickness: 0.0105,
  /** Profundidade só do plástico. */
  shellDepth: 0.07,
  /** z da face frontal do plástico (ponta do nariz). */
  noseFrontZ: -0.035,
  /** z da ponta da placa de circuito impresso. */
  connectorTipZ: -0.047,
  /** z da traseira (extremidade da pega). */
  rearZ: 0.035,
  /** Avanço do cartucho entre encostar na fenda e o fim de curso. */
  insertionDepth: 0.03,
} as const

const W = CARTRIDGE_DIMENSIONS.width
const T = CARTRIDGE_DIMENSIONS.thickness
const NOSE_T = CARTRIDGE_DIMENSIONS.noseThickness

/** Plano da junção das duas metades — ligeiramente abaixo do meio, como no original. */
const SEAM_Y = -0.0012
/** Folga total da junção. Sem ela a linha de sombra da casca desaparece. */
const SEAM_GAP = 0.00022

const Z_TIP = CARTRIDGE_DIMENSIONS.noseFrontZ
const Z_CHAMFER = Z_TIP + 0.0013
const Z_NOSE_END = -0.0165
const Z_STEP_END = -0.0148
const Z_REAR = CARTRIDGE_DIMENSIONS.rearZ
const REAR_RADIUS = 0.005

/**
 * Densidade do grão do ABS, em repetições por metro. As UVs da extrusão são
 * métricas, então isto é literalmente "quantas vezes o mapa cabe em 1 m": 60
 * põe a casquinha de laranja em ~0,3 mm, que é a escala real do ABS moldado.
 */
const SHELL_TILING = 60

/**
 * Chanfro das arestas da casca. Atenção: no three, o bevel da `ExtrudeGeometry`
 * é somado *para fora* do contorno — a peça acabada fica `BEVEL_SIZE` maior em
 * cada lado. Por isso o perfil é desenhado já recuado desse valor, senão a
 * casca cresce 1 mm, engole a etiqueta e fecha a folga da junção.
 */
const BEVEL_SIZE = 0.0005
const BEVEL_THICKNESS = 0.0006

// ---------------------------------------------------------------------------
// PRNG determinístico (local — este arquivo não depende de mais ninguém)
// ---------------------------------------------------------------------------

/** mulberry32. */
function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a — sementes estáveis a partir do id do cartucho. */
function hashString(text: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function smoothstep(t: number): number {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

// ---------------------------------------------------------------------------
// Ruído de valor (fibra do papel)
// ---------------------------------------------------------------------------

function latticeNoise(w: number, h: number, cells: number, rng: () => number): Float32Array {
  const n = Math.max(2, cells)
  const lat = new Float32Array(n * n)
  for (let i = 0; i < lat.length; i++) lat[i] = rng()
  const out = new Float32Array(w * h)
  const sx = n / w
  const sy = n / h
  for (let y = 0; y < h; y++) {
    const fy = y * sy
    const iy = Math.floor(fy)
    const ty = smoothstep(fy - iy)
    const y0 = ((iy % n) + n) % n
    const y1 = (y0 + 1) % n
    for (let x = 0; x < w; x++) {
      const fx = x * sx
      const ix = Math.floor(fx)
      const tx = smoothstep(fx - ix)
      const x0 = ((ix % n) + n) % n
      const x1 = (x0 + 1) % n
      const a = lat[y0 * n + x0] ?? 0
      const b = lat[y0 * n + x1] ?? 0
      const c = lat[y1 * n + x0] ?? 0
      const d = lat[y1 * n + x1] ?? 0
      out[y * w + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
    }
  }
  return out
}

/** fBm somando oitavas do ruído de valor. Saída normalizada em [0, 1]. */
function fbm(
  w: number,
  h: number,
  cells: number,
  octaves: number,
  gain: number,
  rng: () => number,
): Float32Array {
  const out = new Float32Array(w * h)
  let amp = 1
  let total = 0
  let c = cells
  for (let o = 0; o < octaves; o++) {
    const layer = latticeNoise(w, h, Math.round(c), rng)
    for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) + (layer[i] ?? 0) * amp
    total += amp
    amp *= gain
    c *= 2
  }
  if (total > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / total
  return out
}

// ---------------------------------------------------------------------------
// Canvas / texturas
// ---------------------------------------------------------------------------

interface Canvas2D {
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D
}

function makeCanvas(width: number, height: number): Canvas2D {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('Cartridge: não foi possível obter o contexto 2D do canvas.')
  return { canvas, ctx }
}

/** Recursos criados por este módulo — liberados em `dispose()`. */
const owned = {
  geometries: [] as THREE.BufferGeometry[],
  materials: [] as THREE.Material[],
  textures: [] as THREE.Texture[],
}

function texFromCanvas(canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas)
  // Mapas de cor são conteúdo sRGB; rugosidade e normal são lineares (sem conversão).
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.wrapS = THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.anisotropy = 8
  t.needsUpdate = true
  owned.textures.push(t)
  return t
}

/**
 * Clona um material da biblioteca compartilhada e re-tila os mapas para a escala
 * desta peça. As texturas clonadas dividem a mesma `Source`, portanto não custam
 * memória de GPU adicional — só um sampler com outro `repeat`.
 */
function retileClone(
  source: THREE.MeshPhysicalMaterial,
  repeatU: number,
  repeatV: number,
  name: string,
): THREE.MeshPhysicalMaterial {
  const m = source.clone()
  m.name = name
  const slots = ['map', 'normalMap', 'roughnessMap', 'aoMap', 'metalnessMap'] as const
  for (const slot of slots) {
    const tex = m[slot]
    if (tex === null) continue
    const t = tex.clone()
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
    t.repeat.set(repeatU, repeatV)
    t.needsUpdate = true
    owned.textures.push(t)
    m[slot] = t
  }
  m.needsUpdate = true
  owned.materials.push(m)
  return m
}

// ---------------------------------------------------------------------------
// Desenho: primitivas de apoio
// ---------------------------------------------------------------------------

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
}

/**
 * Reduz o corpo da fonte até o texto caber em `maxWidth`.
 *
 * Devolve o mesmo valor da busca linear original (o menor `k` com
 * `size·0.94^k` coubando), mas salta direto para perto de `k` pela razão
 * medida uma única vez — a versão iterativa fazia até 40 `measureText` por
 * rótulo e era a maior tarefa única do boot depois das texturas.
 */
function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  size: number,
  font: (px: number) => string,
): number {
  ctx.font = font(size)
  const initial = ctx.measureText(text).width
  if (initial <= maxWidth) return size

  // Largura escala linearmente com o corpo → estimativa de k, com folga de 2
  // passos para absorver arredondamento; depois caminha como a busca original.
  const estimate = Math.ceil(Math.log(maxWidth / initial) / Math.log(0.94))
  let k = Math.max(0, Math.min(40, estimate) - 2)
  let px = size * Math.pow(0.94, k)
  for (; k < 40; k++) {
    ctx.font = font(px)
    if (ctx.measureText(text).width <= maxWidth) break
    px *= 0.94
  }
  return px
}

/** Marca ⊚ da Gradiente: anel externo com espiral interna. */
function gradienteMark(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  ctx.lineWidth = r * 0.17
  ctx.beginPath()
  ctx.arc(cx, cy, r * 0.94, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  const steps = 96
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const a = t * 2.15 * Math.PI * 2 + Math.PI * 0.25
    const rr = r * 0.7 * (1 - t * 0.88)
    const x = cx + Math.cos(a) * rr
    const y = cy + Math.sin(a) * rr
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.lineWidth = r * 0.2
  ctx.stroke()
  ctx.restore()
}

function gradienteWordmark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  h: number,
  color: string,
): number {
  ctx.save()
  gradienteMark(ctx, x + h * 0.5, y, h * 0.52, color)
  ctx.fillStyle = color
  ctx.font = `bold ${Math.round(h * 0.95)}px "Helvetica Neue", Helvetica, Arial, sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const tx = x + h * 1.12
  ctx.fillText('gradiente', tx, y + h * 0.04)
  const width = h * 1.12 + ctx.measureText('gradiente').width
  ctx.restore()
  return width
}

/** Selo MSX: caixa vermelha, tipo branco (SPEC §3.2 — #CC2229). */
function msxBadge(ctx: CanvasRenderingContext2D, x: number, y: number, h: number): void {
  const w = h * 1.95
  ctx.save()
  ctx.fillStyle = '#CC2229'
  roundRectPath(ctx, x, y, w, h, h * 0.1)
  ctx.fill()
  ctx.fillStyle = '#FFFFFF'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold ${Math.round(h * 0.6)}px "Arial Black", "Helvetica Neue", Arial, sans-serif`
  ctx.fillText('MSX', x + w * 0.5, y + h * 0.56)
  ctx.restore()
}

/** Filete horizontal fino, o padrão da identidade Expert (ver `Expert_Box.jpg`). */
function pinstripes(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  step: number,
  color: string,
  lineWidth: number,
): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  for (let yy = y; yy <= y + h; yy += step) {
    ctx.beginPath()
    ctx.moveTo(x, yy)
    ctx.lineTo(x + w, yy)
    ctx.stroke()
  }
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Artes de etiqueta
// ---------------------------------------------------------------------------

type LabelDraw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void

/** Uma arte de etiqueta em duas chapas de impressão, como offset de verdade. */
export interface LabelArt {
  readonly id: string
  /** Título impresso. */
  readonly titulo: string
  /** Linha secundária impressa. */
  readonly subtitulo: string
  /** Cor do papel antes de qualquer tinta. */
  readonly papel: string
  /** Resolução horizontal da arte, em px. */
  readonly resolucao: number
  /** Chapa de fundo: campos de cor chapados. */
  readonly fundo: LabelDraw
  /** Chapa de tinta: linha, tipografia e selos. Desenhada com desregistro. */
  readonly tinta: LabelDraw
  /** 0 = impressão nova, 1 = etiqueta encardida. */
  readonly envelhecimento: number
  /** Deslocamento do desregistro de impressão, em fração da largura. */
  readonly desregistro: number
}

// ---- 1. Cartucho de arcade ------------------------------------------------

const ARTE_ARCADE: LabelArt = {
  id: 'arcade-vermelho',
  titulo: 'SUPER CÓSMICO',
  subtitulo: 'AVENTURA ESPACIAL',
  papel: '#0B0B12',
  resolucao: 1024,
  envelhecimento: 0.3,
  desregistro: 0.0018,
  fundo: (ctx, w, h) => {
    const rng = createRng(hashString('arcade-fundo'))
    ctx.fillStyle = '#0B0B12'
    ctx.fillRect(0, 0, w, h)

    // Nebulosa: brilho azul profundo subindo do rodapé.
    const glow = ctx.createRadialGradient(w * 0.5, h * 1.05, h * 0.05, w * 0.5, h * 1.05, h * 1.25)
    glow.addColorStop(0, '#25348F')
    glow.addColorStop(0.55, '#141B4A')
    glow.addColorStop(1, 'rgba(11,11,18,0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, w, h)

    // Campo de estrelas.
    for (let i = 0; i < 190; i++) {
      const x = rng() * w
      const y = rng() * h
      const r = 0.6 + rng() * 1.9
      const b = 0.5 + rng() * 0.5
      ctx.fillStyle = `rgba(255,255,255,${b.toFixed(3)})`
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }

    // Planeta cortado pela borda direita.
    const pr = h * 0.62
    const px = w * 1.02
    const py = h * 0.9
    const planet = ctx.createRadialGradient(px - pr * 0.5, py - pr * 0.6, pr * 0.05, px, py, pr)
    planet.addColorStop(0, '#F6A72B')
    planet.addColorStop(0.6, '#D2541A')
    planet.addColorStop(1, '#5E1608')
    ctx.fillStyle = planet
    ctx.beginPath()
    ctx.arc(px, py, pr, 0, Math.PI * 2)
    ctx.fill()

    // Faixa diagonal quente atrás do título.
    ctx.save()
    ctx.translate(w * 0.5, h * 0.47)
    ctx.rotate(-0.075)
    const band = ctx.createLinearGradient(-w * 0.6, 0, w * 0.6, 0)
    band.addColorStop(0, '#8C0F16')
    band.addColorStop(0.42, '#D8202A')
    band.addColorStop(1, '#F08A16')
    ctx.fillStyle = band
    ctx.fillRect(-w * 0.6, -h * 0.19, w * 1.2, h * 0.38)
    ctx.restore()

    // Barra preta superior com filete amarelo.
    ctx.fillStyle = '#101018'
    ctx.fillRect(0, 0, w, h * 0.19)
    ctx.fillStyle = '#F2C41B'
    ctx.fillRect(0, h * 0.19, w, h * 0.011)
  },
  tinta: (ctx, w, h) => {
    // Moldura de segurança.
    ctx.strokeStyle = 'rgba(255,255,255,0.82)'
    ctx.lineWidth = Math.max(1, w * 0.0035)
    roundRectPath(ctx, w * 0.012, h * 0.016, w * 0.976, h * 0.968, w * 0.016)
    ctx.stroke()

    // Título em itálico condensado, com sombra dura amarela.
    const title = 'SUPER CÓSMICO'
    const font = (px: number): string =>
      `italic 900 ${Math.round(px)}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`
    ctx.save()
    ctx.translate(w * 0.5, h * 0.5)
    ctx.rotate(-0.055)
    const px = fitFont(ctx, title, w * 0.84, h * 0.3, font)
    ctx.font = font(px)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#1A0B06'
    ctx.fillText(title, w * 0.008, h * 0.02)
    ctx.fillStyle = '#F7D93C'
    ctx.fillText(title, -w * 0.004, -h * 0.012)
    ctx.fillStyle = '#FFFFFF'
    ctx.fillText(title, 0, 0)
    ctx.restore()

    // Selos e créditos.
    msxBadge(ctx, w * 0.038, h * 0.045, h * 0.1)
    ctx.fillStyle = '#FFFFFF'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'right'
    ctx.font = `bold ${Math.round(h * 0.072)}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    ctx.fillText('CARTUCHO DE JOGO', w * 0.962, h * 0.095)

    ctx.textAlign = 'left'
    ctx.fillStyle = '#F7D93C'
    ctx.font = `bold ${Math.round(h * 0.082)}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    ctx.fillText('AVENTURA ESPACIAL', w * 0.045, h * 0.79)

    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.font = `${Math.round(h * 0.058)}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    ctx.fillText('ROM 32 KB · 1 OU 2 JOGADORES', w * 0.045, h * 0.905)
    ctx.textAlign = 'right'
    ctx.fillText('© 1986 SOFTWARE BRASIL', w * 0.955, h * 0.905)
  },
}

// ---- 2. Cartucho Gradiente ------------------------------------------------

const ARTE_GRADIENTE: LabelArt = {
  id: 'gradiente-basic',
  titulo: 'BASIC ESTENDIDO',
  subtitulo: 'CARTUCHO DE PROGRAMA',
  papel: '#EDEBE3',
  resolucao: 1024,
  envelhecimento: 0.42,
  desregistro: 0.0012,
  fundo: (ctx, w, h) => {
    ctx.fillStyle = '#EDEBE3'
    ctx.fillRect(0, 0, w, h)
    // Filetes finos: o padrão da caixa do Expert.
    pinstripes(ctx, 0, h * 0.3, w, h * 0.7, h * 0.052, 'rgba(30,42,60,0.16)', Math.max(1, h * 0.006))
    // Faixa superior verde-escuro (a cor do wordmark EXPERT).
    ctx.fillStyle = '#1D4B3E'
    ctx.fillRect(0, 0, w, h * 0.28)
    ctx.fillStyle = '#2E7FB8'
    ctx.fillRect(0, h * 0.28, w, h * 0.016)
    // Bloco prateado do canto inferior direito.
    const silver = ctx.createLinearGradient(0, h * 0.62, 0, h)
    silver.addColorStop(0, '#C9C6BC')
    silver.addColorStop(1, '#A8A49B')
    ctx.fillStyle = silver
    ctx.fillRect(w * 0.63, h * 0.62, w * 0.37, h * 0.38)
  },
  tinta: (ctx, w, h) => {
    gradienteWordmark(ctx, w * 0.04, h * 0.145, h * 0.15, '#FFFFFF')

    ctx.fillStyle = '#FFFFFF'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.font = `${Math.round(h * 0.078)}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    ctx.fillText('PERSONAL COMPUTER', w * 0.96, h * 0.145)

    const title = 'BASIC ESTENDIDO'
    const font = (px: number): string =>
      `bold ${Math.round(px)}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    const px = fitFont(ctx, title, w * 0.56, h * 0.2, font)
    ctx.font = font(px)
    ctx.textAlign = 'left'
    ctx.fillStyle = '#17331F'
    ctx.fillText(title, w * 0.045, h * 0.47)

    ctx.font = `${Math.round(h * 0.075)}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    ctx.fillStyle = '#33383A'
    ctx.fillText('CARTUCHO DE PROGRAMA', w * 0.045, h * 0.62)
    ctx.fillText('EXPERT XP-800 · ROM 16 KB', w * 0.045, h * 0.73)

    ctx.font = `${Math.round(h * 0.058)}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    ctx.fillStyle = '#4A4E50'
    ctx.fillText('INDÚSTRIA BRASILEIRA', w * 0.045, h * 0.9)

    msxBadge(ctx, w * 0.7, h * 0.68, h * 0.15)
    ctx.textAlign = 'center'
    ctx.font = `${Math.round(h * 0.05)}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    ctx.fillStyle = '#3A3733'
    ctx.fillText('SISTEMA', w * 0.7 + h * 0.146, h * 0.645)

    ctx.strokeStyle = 'rgba(40,44,46,0.55)'
    ctx.lineWidth = Math.max(1, w * 0.0022)
    roundRectPath(ctx, w * 0.011, h * 0.014, w * 0.978, h * 0.972, w * 0.008)
    ctx.stroke()
  },
}

// ---- 3. Cartucho genérico preto -------------------------------------------

const ARTE_GENERICO: LabelArt = {
  id: 'preto-generico',
  titulo: 'PROGRAMA 32 KB',
  subtitulo: 'N.º 014',
  papel: '#E7DEC6',
  resolucao: 640,
  envelhecimento: 0.85,
  desregistro: 0.0026,
  fundo: (ctx, w, h) => {
    const rng = createRng(hashString('generico-fundo'))
    ctx.fillStyle = '#E7DEC6'
    ctx.fillRect(0, 0, w, h)
    // Fibra grossa de papel barato: pontinhos escuros na massa.
    for (let i = 0; i < 420; i++) {
      const x = rng() * w
      const y = rng() * h
      const r = 0.4 + rng() * 1.1
      ctx.fillStyle = `rgba(120,100,70,${(0.05 + rng() * 0.16).toFixed(3)})`
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    // Mancha de café no canto.
    ctx.save()
    ctx.globalAlpha = 0.16
    ctx.strokeStyle = '#6B4A22'
    ctx.lineWidth = h * 0.03
    ctx.beginPath()
    ctx.arc(w * 0.86, h * 0.78, h * 0.28, 0.2, Math.PI * 1.7)
    ctx.stroke()
    ctx.restore()
  },
  tinta: (ctx, w, h) => {
    ctx.strokeStyle = '#1E1B16'
    ctx.lineWidth = Math.max(1, w * 0.006)
    ctx.strokeRect(w * 0.045, h * 0.09, w * 0.91, h * 0.82)

    ctx.fillStyle = '#1E1B16'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    // Datilografado: cada linha é reduzida até caber dentro do quadro impresso.
    const mono = (px: number): string => `${Math.round(px)}px "Courier New", Courier, monospace`
    const bold = (px: number): string =>
      `bold ${Math.round(px)}px "Courier New", Courier, monospace`
    const box = w * 0.83

    ctx.font = bold(fitFont(ctx, 'PROGRAMA 32 KB', box, h * 0.17, bold))
    ctx.fillText('PROGRAMA 32 KB', w * 0.085, h * 0.29)

    ctx.font = mono(fitFont(ctx, 'USO PESSOAL — NÃO COMERCIAL', box, h * 0.115, mono))
    ctx.fillText('USO PESSOAL — NÃO COMERCIAL', w * 0.085, h * 0.52)
    ctx.fillText('N.º 014', w * 0.085, h * 0.7)

    // Carimbo torto, tinta gasta.
    ctx.save()
    ctx.translate(w * 0.74, h * 0.66)
    ctx.rotate(-0.22)
    ctx.globalAlpha = 0.72
    ctx.strokeStyle = '#7A2A22'
    ctx.fillStyle = '#7A2A22'
    ctx.lineWidth = Math.max(1, w * 0.007)
    roundRectPath(ctx, -w * 0.13, -h * 0.11, w * 0.26, h * 0.22, w * 0.02)
    ctx.stroke()
    ctx.textAlign = 'center'
    ctx.font = `bold ${Math.round(h * 0.13)}px "Courier New", Courier, monospace`
    ctx.fillText('REV. B', 0, h * 0.01)
    ctx.restore()
  },
}

// ---- 4. Cartucho educativo ------------------------------------------------

const ARTE_EDUCATIVO: LabelArt = {
  id: 'educativo-verde',
  titulo: 'MATEMÁTICA I',
  subtitulo: 'SOFTWARE EDUCATIVO',
  papel: '#F4F2EC',
  resolucao: 1024,
  envelhecimento: 0.5,
  desregistro: 0.0016,
  fundo: (ctx, w, h) => {
    ctx.fillStyle = '#F4F2EC'
    ctx.fillRect(0, 0, w, h)

    // Cunha verde diagonal.
    ctx.fillStyle = '#2E7D4F'
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(w * 0.46, 0)
    ctx.lineTo(w * 0.3, h)
    ctx.lineTo(0, h)
    ctx.closePath()
    ctx.fill()

    // Formas geométricas soltas — o vocabulário gráfico de 1986.
    ctx.fillStyle = '#E8B92A'
    ctx.beginPath()
    ctx.arc(w * 0.83, h * 0.29, h * 0.19, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = '#2E6FB0'
    ctx.beginPath()
    ctx.moveTo(w * 0.66, h * 0.94)
    ctx.lineTo(w * 0.76, h * 0.64)
    ctx.lineTo(w * 0.86, h * 0.94)
    ctx.closePath()
    ctx.fill()

    ctx.fillStyle = '#C0392B'
    ctx.fillRect(w * 0.87, h * 0.62, h * 0.2, h * 0.2)

    // Filete fino sob o título.
    ctx.fillStyle = '#2E7D4F'
    ctx.fillRect(w * 0.36, h * 0.5, w * 0.2, h * 0.018)
  },
  tinta: (ctx, w, h) => {
    ctx.fillStyle = '#FFFFFF'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.save()
    ctx.translate(w * 0.05, h * 0.5)
    ctx.rotate(-Math.PI / 2)
    ctx.font = `bold ${Math.round(h * 0.11)}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    ctx.textAlign = 'center'
    ctx.fillText('EDUCATIVO', 0, 0)
    ctx.restore()

    const title = 'MATEMÁTICA I'
    const font = (px: number): string =>
      `bold ${Math.round(px)}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    const px = fitFont(ctx, title, w * 0.5, h * 0.21, font)
    ctx.font = font(px)
    ctx.textAlign = 'left'
    ctx.fillStyle = '#1B3A2B'
    ctx.fillText(title, w * 0.36, h * 0.34)

    // As duas linhas de corpo param antes das formas geométricas da direita.
    const corpo = (p: number): string =>
      `${Math.round(p)}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    ctx.font = corpo(fitFont(ctx, 'SOFTWARE EDUCATIVO', w * 0.28, h * 0.078, corpo))
    ctx.fillStyle = '#37474F'
    ctx.fillText('SOFTWARE EDUCATIVO', w * 0.36, h * 0.63)
    ctx.fillText('1.º GRAU · ROM 16 KB', w * 0.36, h * 0.74)

    ctx.font = `bold ${Math.round(h * 0.062)}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    ctx.fillStyle = '#2E7D4F'
    ctx.fillText('EDITORA MERIDIANO', w * 0.36, h * 0.89)

    msxBadge(ctx, w * 0.63, h * 0.045, h * 0.1)
  },
}

// ---------------------------------------------------------------------------
// Manifesto
// ---------------------------------------------------------------------------

export type CartridgeId = 'arcade-vermelho' | 'gradiente-basic' | 'preto-generico' | 'educativo-verde'

/** Geometria e acabamento da etiqueta de papel colada na casca. */
export interface LabelSpec {
  /** Largura da etiqueta, em metros. */
  readonly largura: number
  /** Profundidade da etiqueta, em metros. */
  readonly profundidade: number
  /** Deslocamento em X do centro da etiqueta. */
  readonly deslocamentoX: number
  /** Deslocamento em Z do centro da etiqueta. */
  readonly deslocamentoZ: number
  /** Canto que descola, em sinais (x, z). Ausente = etiqueta bem colada. */
  readonly cantoLevantado?: readonly [number, number]
  /** Altura do descolamento, em metros. */
  readonly alturaLevantada?: number
}

export interface CartridgeInfo {
  readonly id: CartridgeId
  /** Nome de exibição, pt-BR. */
  readonly nome: string
  /** Descrição curta para o HUD, pt-BR. */
  readonly descricao: string
  /** Arte da etiqueta (chapas de impressão + metadados). */
  readonly arte: LabelArt
  /** Cor da metade superior da casca. */
  readonly corSuperior: number
  /** Cor da metade inferior da casca. */
  readonly corInferior: number
  /** Rugosidade base do ABS da casca. */
  readonly rugosidade: number
  /** Etiqueta. */
  readonly etiqueta: LabelSpec
  /** 0 = conector novo, 1 = inserido mil vezes (ouro gasto na ponta). */
  readonly desgasteContatos: number
}

/**
 * Biblioteca de cartuchos. Os `id` valem como `romId` no contrato de
 * `ScreenSource.insertCartridge()` — nenhuma ROM real é distribuída, o emulador
 * decide o que fazer com o id (SPEC §9).
 */
export const CARTRIDGE_MANIFEST: readonly CartridgeInfo[] = [
  {
    id: 'arcade-vermelho',
    nome: 'Super Cósmico',
    descricao: 'Cartucho de jogo, 32 KB — arte de arcade, 1986',
    arte: ARTE_ARCADE,
    corSuperior: 0x37373a,
    corInferior: 0x2b2b2e,
    rugosidade: 0.56,
    etiqueta: {
      largura: 0.078,
      profundidade: 0.042,
      deslocamentoX: 0,
      deslocamentoZ: 0.009,
      cantoLevantado: [-1, 1],
      alturaLevantada: 0.0005,
    },
    desgasteContatos: 0.75,
  },
  {
    id: 'gradiente-basic',
    nome: 'Gradiente BASIC Estendido',
    descricao: 'Cartucho de programa da própria Gradiente, 16 KB',
    arte: ARTE_GRADIENTE,
    corSuperior: 0xa29e95,
    corInferior: 0x6f6c65,
    rugosidade: 0.6,
    etiqueta: {
      largura: 0.078,
      profundidade: 0.04,
      deslocamentoX: 0,
      deslocamentoZ: 0.01,
    },
    desgasteContatos: 0.45,
  },
  {
    id: 'preto-generico',
    nome: 'Cartucho genérico',
    descricao: 'Casca preta sem marca, etiqueta datilografada e encardida',
    arte: ARTE_GENERICO,
    corSuperior: 0x1f1f21,
    corInferior: 0x1a1a1c,
    rugosidade: 0.62,
    etiqueta: {
      largura: 0.05,
      profundidade: 0.03,
      deslocamentoX: -0.009,
      deslocamentoZ: 0.011,
      // A etiqueta velha descolou no canto de trás, à esquerda.
      cantoLevantado: [-1, 1],
      alturaLevantada: 0.0019,
    },
    desgasteContatos: 1,
  },
  {
    id: 'educativo-verde',
    nome: 'Matemática I',
    descricao: 'Software educativo, 16 KB — Editora Meridiano',
    arte: ARTE_EDUCATIVO,
    corSuperior: 0xc7c1b2,
    corInferior: 0x8e8a80,
    rugosidade: 0.58,
    etiqueta: {
      largura: 0.076,
      profundidade: 0.042,
      deslocamentoX: 0,
      deslocamentoZ: 0.009,
    },
    desgasteContatos: 0.35,
  },
]

const MANIFEST_BY_ID = new Map<string, CartridgeInfo>(CARTRIDGE_MANIFEST.map((c) => [c.id, c]))

/** Busca um cartucho pelo id (o mesmo id usado como `romId`). */
export function getCartridgeInfo(romId: string): CartridgeInfo | null {
  return MANIFEST_BY_ID.get(romId) ?? null
}

// ---------------------------------------------------------------------------
// Etiqueta: arte, envelhecimento e mapas de papel
// ---------------------------------------------------------------------------

function tintedCopy(src: HTMLCanvasElement, tint: string): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height)
  c.ctx.drawImage(src, 0, 0)
  // `source-in` pinta só onde há tinta — é isso que dá a franja de desregistro.
  c.ctx.globalCompositeOperation = 'source-in'
  c.ctx.fillStyle = tint
  c.ctx.fillRect(0, 0, src.width, src.height)
  return c.canvas
}

/** Envelhecimento de papel: amarelado, sujeira de borda, riscos e vincos. */
function agePaper(target: Canvas2D, amount: number, seed: number): void {
  if (amount <= 0) return
  const { canvas, ctx } = target
  const w = canvas.width
  const h = canvas.height
  const rng = createRng(seed)

  ctx.save()
  // Amarelado desigual (multiplicativo — é pigmento, não luz).
  ctx.globalCompositeOperation = 'multiply'
  const yellow = ctx.createLinearGradient(0, 0, w * 0.8, h)
  yellow.addColorStop(0, `rgba(226,206,160,${(0.1 + amount * 0.22).toFixed(3)})`)
  yellow.addColorStop(1, `rgba(206,182,132,${(0.06 + amount * 0.3).toFixed(3)})`)
  ctx.fillStyle = yellow
  ctx.fillRect(0, 0, w, h)

  // Sujeira acumulada nas bordas (onde os dedos pegam).
  const edge = ctx.createLinearGradient(0, 0, 0, h)
  edge.addColorStop(0, `rgba(120,104,78,${(amount * 0.3).toFixed(3)})`)
  edge.addColorStop(0.18, 'rgba(120,104,78,0)')
  edge.addColorStop(0.82, 'rgba(120,104,78,0)')
  edge.addColorStop(1, `rgba(120,104,78,${(amount * 0.34).toFixed(3)})`)
  ctx.fillStyle = edge
  ctx.fillRect(0, 0, w, h)
  const edgeX = ctx.createLinearGradient(0, 0, w, 0)
  edgeX.addColorStop(0, `rgba(120,104,78,${(amount * 0.26).toFixed(3)})`)
  edgeX.addColorStop(0.14, 'rgba(120,104,78,0)')
  edgeX.addColorStop(0.86, 'rgba(120,104,78,0)')
  edgeX.addColorStop(1, `rgba(120,104,78,${(amount * 0.3).toFixed(3)})`)
  ctx.fillStyle = edgeX
  ctx.fillRect(0, 0, w, h)
  ctx.restore()

  // Micro-riscos claros: papel esfolado deixa a fibra branca à mostra.
  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  const scratches = Math.round(6 + amount * 22)
  for (let i = 0; i < scratches; i++) {
    const x = rng() * w
    const y = rng() * h
    const len = (0.02 + rng() * 0.16) * w
    const a = (rng() - 0.5) * 0.9
    ctx.strokeStyle = `rgba(255,252,243,${(0.05 + rng() * 0.16 * amount).toFixed(3)})`
    ctx.lineWidth = Math.max(0.6, rng() * 1.6)
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * Compõe a arte final da etiqueta: chapa de fundo, chapa de tinta com
 * desregistro ciano/magenta e envelhecimento.
 *
 * Exportado para que a interface possa mostrar a arte em 2D (miniatura do
 * seletor de cartuchos) sem precisar renderizar a cena.
 */
export function renderLabelArtwork(romId: string, widthPx?: number): HTMLCanvasElement {
  const info = getCartridgeInfo(romId) ?? CARTRIDGE_MANIFEST[0]
  if (info === undefined) throw new Error('Cartridge: manifesto de cartuchos vazio.')
  const art = info.arte
  const w = Math.max(64, Math.round(widthPx ?? art.resolucao))
  const h = Math.max(48, Math.round((w * info.etiqueta.profundidade) / info.etiqueta.largura))

  const base = makeCanvas(w, h)
  base.ctx.fillStyle = art.papel
  base.ctx.fillRect(0, 0, w, h)
  art.fundo(base.ctx, w, h)

  const ink = makeCanvas(w, h)
  ink.ctx.textBaseline = 'alphabetic'
  art.tinta(ink.ctx, w, h)

  // Erro de registro entre as chapas: a máquina de 1986 nunca acertava.
  const d = art.desregistro * w
  base.ctx.save()
  base.ctx.globalAlpha = 0.32
  base.ctx.drawImage(tintedCopy(ink.canvas, '#00A6C8'), -d * 1.1, d * 0.45)
  base.ctx.globalAlpha = 0.24
  base.ctx.drawImage(tintedCopy(ink.canvas, '#D6006E'), d * 0.9, -d * 0.4)
  base.ctx.globalAlpha = 0.97
  base.ctx.drawImage(ink.canvas, 0, 0)
  base.ctx.restore()

  agePaper(base, art.envelhecimento, hashString(`age:${info.id}`))
  return base.canvas
}

interface PaperMaps {
  readonly roughnessMap: THREE.CanvasTexture
  readonly normalMap: THREE.CanvasTexture
}

/**
 * Rugosidade e normal do papel, derivados da própria arte: onde há tinta o papel
 * fecha e fica um pouco mais brilhante; onde não há, a fibra domina. O relevo é
 * mínimo (tinta offset tem alguns micrômetros), mas é ele que impede a etiqueta
 * de parecer um decalque plano.
 */
function paperMaps(art: HTMLCanvasElement, seed: number): PaperMaps {
  const w = 512
  const h = Math.max(64, Math.round((512 * art.height) / art.width))

  const small = makeCanvas(w, h)
  small.ctx.drawImage(art, 0, 0, w, h)
  const src = small.ctx.getImageData(0, 0, w, h).data

  const rng = createRng(seed)
  const fibre = fbm(w, h, 110, 3, 0.55, rng)
  const waves = fbm(w, h, 6, 2, 0.5, rng)

  const height = new Float32Array(w * h)
  const rough = makeCanvas(w, h)
  const roughImg = rough.ctx.createImageData(w, h)

  for (let i = 0; i < w * h; i++) {
    const r = src[i * 4] ?? 255
    const g = src[i * 4 + 1] ?? 255
    const b = src[i * 4 + 2] ?? 255
    // Cobertura de tinta: qualquer canal escuro ou saturado significa pigmento.
    const ink = clamp(1 - Math.min(r, Math.min(g, b)) / 255, 0, 1)
    const f = fibre[i] ?? 0.5
    const wv = waves[i] ?? 0.5

    height[i] = (f - 0.5) * 0.5 + (wv - 0.5) * 0.85 + ink * 0.22

    // Multiplicador da rugosidade: papel cru ≈ 1, tinta fecha o poro.
    const rr = clamp(1 - ink * 0.17 + (f - 0.5) * 0.1, 0.68, 1)
    const v = Math.round(rr * 255)
    roughImg.data[i * 4] = v
    roughImg.data[i * 4 + 1] = v
    roughImg.data[i * 4 + 2] = v
    roughImg.data[i * 4 + 3] = 255
  }
  rough.ctx.putImageData(roughImg, 0, 0)

  // Sobel → normal. CanvasTexture usa flipY, então +V sobe na imagem: ny = +dy.
  const normal = makeCanvas(w, h)
  const normalImg = normal.ctx.createImageData(w, h)
  const strength = 1.35
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1) + h) % h
    const yp = (y + 1) % h
    for (let x = 0; x < w; x++) {
      const xm = ((x - 1) + w) % w
      const xp = (x + 1) % w
      const gx = (height[y * w + xp] ?? 0) - (height[y * w + xm] ?? 0)
      const gy = (height[yp * w + x] ?? 0) - (height[ym * w + x] ?? 0)
      let nx = -gx * strength
      let ny = gy * strength
      const nz = 1
      const inv = 1 / Math.hypot(nx, ny, nz)
      nx *= inv
      ny *= inv
      const i = y * w + x
      normalImg.data[i * 4] = Math.round((nx * 0.5 + 0.5) * 255)
      normalImg.data[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      normalImg.data[i * 4 + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255)
      normalImg.data[i * 4 + 3] = 255
    }
  }
  normal.ctx.putImageData(normalImg, 0, 0)

  return {
    roughnessMap: texFromCanvas(rough.canvas, false),
    normalMap: texFromCanvas(normal.canvas, false),
  }
}

// ---------------------------------------------------------------------------
// Geometria: casca
// ---------------------------------------------------------------------------

interface HalfSpec {
  /** Y do plano de junção (lado desta metade). */
  readonly seamY: number
  /** Y da face externa (topo ou fundo). */
  readonly outerY: number
  /** Y da face externa na região do nariz. */
  readonly noseY: number
  /** Y da face externa na ponta chanfrada. */
  readonly tipY: number
}

/** Área com sinal — usada para forçar o contorno em sentido anti-horário. */
function signedArea(points: readonly THREE.Vector2[]): number {
  let a = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    if (p === undefined || q === undefined) continue
    a += p.x * q.y - q.x * p.y
  }
  return a * 0.5
}

/**
 * Perfil lateral de uma das metades da casca, no plano (z, y). O contorno segue
 * a ponta chanfrada, o degrau do nariz, a face externa, o canto traseiro
 * arredondado e volta pelo plano de junção.
 *
 * Todas as coordenadas já vêm recuadas de `BEVEL_SIZE`: é o chanfro que devolve
 * a peça à cota nominal.
 */
function halfShellShape(spec: HalfSpec): THREE.Shape {
  const { seamY, outerY, noseY, tipY } = spec
  const sign = Math.sign(outerY - seamY)
  const zTip = Z_TIP + BEVEL_SIZE
  const zRear = Z_REAR - BEVEL_SIZE
  const radius = REAR_RADIUS - BEVEL_SIZE
  const pts: THREE.Vector2[] = []

  pts.push(new THREE.Vector2(zTip, seamY))
  pts.push(new THREE.Vector2(zTip, tipY))
  pts.push(new THREE.Vector2(Z_CHAMFER, noseY))
  pts.push(new THREE.Vector2(Z_NOSE_END, noseY))
  pts.push(new THREE.Vector2(Z_STEP_END, outerY))
  pts.push(new THREE.Vector2(zRear - radius, outerY))

  // Canto traseiro arredondado — é ele que devolve o realce alongado da pega.
  const cz = zRear - radius
  const cy = outerY - sign * radius
  const segments = 7
  for (let i = 1; i <= segments; i++) {
    const a = (i / segments) * (Math.PI / 2)
    pts.push(new THREE.Vector2(cz + Math.sin(a) * radius, cy + sign * Math.cos(a) * radius))
  }
  pts.push(new THREE.Vector2(zRear, seamY))

  if (signedArea(pts) < 0) pts.reverse()
  return new THREE.Shape(pts)
}

/** Extruda a metade ao longo da largura e reorienta para o eixo local X. */
function buildHalfGeometry(spec: HalfSpec): THREE.BufferGeometry {
  const depth = W - BEVEL_THICKNESS * 2

  const geo = new THREE.ExtrudeGeometry(halfShellShape(spec), {
    depth,
    bevelEnabled: true,
    bevelThickness: BEVEL_THICKNESS,
    bevelSize: BEVEL_SIZE,
    bevelOffset: 0,
    bevelSegments: 3,
    curveSegments: 3,
    steps: 1,
  })
  geo.translate(0, 0, -depth / 2)
  // A forma vive em (z, y); girar -90° em Y põe a extrusão no eixo X e mantém
  // a profundidade no eixo Z com o mesmo sinal.
  geo.rotateY(-Math.PI / 2)
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}

let shellTopGeo: THREE.BufferGeometry | null = null
let shellBottomGeo: THREE.BufferGeometry | null = null

function shellGeometries(): { top: THREE.BufferGeometry; bottom: THREE.BufferGeometry } {
  if (shellTopGeo === null) {
    shellTopGeo = buildHalfGeometry({
      seamY: SEAM_Y + SEAM_GAP / 2 + BEVEL_SIZE,
      outerY: T / 2 - BEVEL_SIZE,
      noseY: NOSE_T / 2 - BEVEL_SIZE,
      tipY: NOSE_T / 2 - BEVEL_SIZE - 0.0016,
    })
    owned.geometries.push(shellTopGeo)
  }
  if (shellBottomGeo === null) {
    shellBottomGeo = buildHalfGeometry({
      seamY: SEAM_Y - SEAM_GAP / 2 - BEVEL_SIZE,
      outerY: -(T / 2 - BEVEL_SIZE),
      noseY: -(NOSE_T / 2 - BEVEL_SIZE),
      tipY: -(NOSE_T / 2 - BEVEL_SIZE - 0.0016),
    })
    owned.geometries.push(shellBottomGeo)
  }
  return { top: shellTopGeo, bottom: shellBottomGeo }
}

// ---------------------------------------------------------------------------
// Geometria: nervuras de pega
// ---------------------------------------------------------------------------

const RIB_COUNT = 7
const RIB_RADIUS = 0.0008
const RIB_PROUD = 0.0005
const RIB_Z0 = 0.0115
/** A faixa termina antes de z = 0.030: dali para trás o perfil arredonda e a
 *  nervura (que atravessa toda a espessura) escaparia da silhueta. */
const RIB_PITCH = 0.0026

let ribGeo: THREE.BufferGeometry | null = null

function ribGeometry(): THREE.BufferGeometry {
  if (ribGeo === null) {
    ribGeo = new THREE.CylinderGeometry(RIB_RADIUS, RIB_RADIUS, T - 0.0004, 10, 1, false)
    owned.geometries.push(ribGeo)
  }
  return ribGeo
}

function buildRibs(material: THREE.Material): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(ribGeometry(), material, RIB_COUNT * 2)
  mesh.name = 'cartucho-nervuras'
  const dummy = new THREE.Object3D()
  let i = 0
  for (const side of [-1, 1]) {
    for (let k = 0; k < RIB_COUNT; k++) {
      dummy.position.set(side * (W / 2 - RIB_RADIUS + RIB_PROUD), 0, RIB_Z0 + k * RIB_PITCH)
      dummy.rotation.set(0, 0, 0)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
      i++
    }
  }
  mesh.instanceMatrix.needsUpdate = true
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

// ---------------------------------------------------------------------------
// Geometria: conector de borda
// ---------------------------------------------------------------------------

const PCB_WIDTH = 0.066
const PCB_THICKNESS = 0.0016
const PCB_Z_TIP = CARTRIDGE_DIMENSIONS.connectorTipZ
const PCB_Z_BACK = -0.029
const CONTACT_COUNT = 25
const CONTACT_PITCH = 0.00254
const CONTACT_WIDTH = 0.0018
const CONTACT_LENGTH = 0.008
const CONTACT_HEIGHT = 0.00006

let pcbGeo: THREE.BufferGeometry | null = null
let contactGeo: THREE.BufferGeometry | null = null

function pcbGeometry(): THREE.BufferGeometry {
  if (pcbGeo === null) {
    const d = PCB_Z_BACK - PCB_Z_TIP
    const geo = new THREE.BoxGeometry(PCB_WIDTH, PCB_THICKNESS, d, 1, 1, 1)
    // Chanfro da borda de contato: a ponta afina, como toda placa de cartucho.
    const pos = geo.attributes['position']
    if (pos instanceof THREE.BufferAttribute) {
      for (let i = 0; i < pos.count; i++) {
        if (pos.getZ(i) < -d * 0.49) pos.setY(i, pos.getY(i) * 0.55)
      }
      pos.needsUpdate = true
      geo.computeVertexNormals()
    }
    geo.translate(0, 0, PCB_Z_TIP + d / 2)
    pcbGeo = geo
    owned.geometries.push(geo)
  }
  return pcbGeo
}

/**
 * Um contato dourado. As cores de vértice carregam o desgaste ao longo do
 * comprimento: a ponta, que raspa nos contatos-mola do compartimento, perde o
 * banho de ouro e vira níquel acinzentado.
 */
function contactGeometry(): THREE.BufferGeometry {
  if (contactGeo === null) {
    const geo = new THREE.BoxGeometry(CONTACT_WIDTH, CONTACT_HEIGHT, CONTACT_LENGTH, 1, 1, 4)
    const pos = geo.attributes['position']
    if (pos instanceof THREE.BufferAttribute) {
      const colors = new Float32Array(pos.count * 3)
      for (let i = 0; i < pos.count; i++) {
        // z = -L/2 é a ponta de entrada.
        const t = clamp((pos.getZ(i) + CONTACT_LENGTH / 2) / CONTACT_LENGTH, 0, 1)
        const wear = 1 - smoothstep(t * 1.35)
        colors[i * 3] = 1 - wear * 0.1
        colors[i * 3 + 1] = 1 + wear * 0.04
        colors[i * 3 + 2] = 1 + wear * 0.42
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    }
    contactGeo = geo
    owned.geometries.push(geo)
  }
  return contactGeo
}

function buildContacts(material: THREE.Material, wear: number): THREE.InstancedMesh {
  const count = CONTACT_COUNT * 2
  const mesh = new THREE.InstancedMesh(contactGeometry(), material, count)
  mesh.name = 'cartucho-contatos'
  const dummy = new THREE.Object3D()
  const color = new THREE.Color()
  const rng = createRng(0x51b3d1)
  const x0 = -((CONTACT_COUNT - 1) * CONTACT_PITCH) / 2
  const z = PCB_Z_TIP + 0.0015 + CONTACT_LENGTH / 2
  let i = 0
  for (const side of [1, -1]) {
    for (let k = 0; k < CONTACT_COUNT; k++) {
      dummy.position.set(
        x0 + k * CONTACT_PITCH,
        side * (PCB_THICKNESS / 2 + CONTACT_HEIGHT / 2),
        z,
      )
      dummy.rotation.set(0, 0, 0)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
      // Cada dedo de contato pegou uma dose diferente de uso.
      const v = 1 - wear * (0.03 + rng() * 0.1)
      color.setRGB(v, v * 0.995, v * 0.98)
      mesh.setColorAt(i, color)
      i++
    }
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true
  mesh.castShadow = false
  mesh.receiveShadow = true
  return mesh
}

// ---------------------------------------------------------------------------
// Geometria: etiqueta de papel
// ---------------------------------------------------------------------------

const LABEL_THICKNESS = 0.00016

/**
 * Placa de papel com espessura real. A malha do topo e do fundo é deslocada
 * junto — a etiqueta se comporta como uma folha que empena, não como uma caixa:
 * ondulação suave da cola em toda a área e, quando pedido, um canto descolado.
 */
function buildLabelGeometry(spec: LabelSpec, seed: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(spec.largura, LABEL_THICKNESS, spec.profundidade, 22, 1, 16)
  const pos = geo.attributes['position']
  if (!(pos instanceof THREE.BufferAttribute)) return geo

  const rng = createRng(seed)
  const phase = rng() * Math.PI * 2
  const corner = spec.cantoLevantado
  const lift = spec.alturaLevantada ?? 0
  const hw = spec.largura / 2
  const hd = spec.profundidade / 2
  const radius = Math.min(spec.largura, spec.profundidade) * 0.55

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const y = pos.getY(i)

    // Ondulação da cola: amplitude de 25 µm, invisível de frente e evidente
    // em ângulo rasante — que é exatamente como papel colado se comporta.
    let dy = Math.sin(x * 190 + phase) * 0.000012 + Math.sin(z * 240 + phase * 1.7) * 0.000014

    if (corner !== undefined && lift > 0) {
      const cx = (corner[0] ?? 0) * hw
      const cz = (corner[1] ?? 0) * hd
      const d = Math.hypot(x - cx, z - cz)
      const t = 1 - smoothstep(d / radius)
      dy += lift * t * t
    }
    pos.setY(i, y + dy)
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
  geo.computeBoundingBox()
  geo.computeBoundingSphere()

  // A BoxGeometry vem com 6 grupos (+X, −X, +Y, −Y, +Z, −Z) e o three emite uma
  // chamada de desenho por grupo. Só a face +Y leva a arte; as outras cinco são
  // o mesmo corte de papel, e como o buffer é contíguo dá para fundi-las em
  // dois grupos — 3 chamadas em vez de 6.
  const g = geo.groups
  const before = g[0]
  const after = g[1]
  const face = g[2]
  const rest = [g[3], g[4], g[5]]
  if (before !== undefined && after !== undefined && face !== undefined && rest[0] !== undefined) {
    const tail = rest.reduce((sum, grp) => sum + (grp?.count ?? 0), 0)
    geo.clearGroups()
    geo.addGroup(before.start, before.count + after.count, LABEL_EDGE_INDEX)
    geo.addGroup(face.start, face.count, LABEL_FACE_INDEX)
    geo.addGroup(rest[0].start, tail, LABEL_EDGE_INDEX)
  }

  owned.geometries.push(geo)
  return geo
}

/** Índices no array de materiais da etiqueta. */
const LABEL_EDGE_INDEX = 0
const LABEL_FACE_INDEX = 1

// ---------------------------------------------------------------------------
// Materiais
// ---------------------------------------------------------------------------

interface CartridgeMaterials {
  readonly shellTop: THREE.MeshPhysicalMaterial
  readonly shellBottom: THREE.MeshPhysicalMaterial
  readonly labelFace: THREE.MeshPhysicalMaterial
  readonly labelEdge: THREE.MeshPhysicalMaterial
  readonly pcb: THREE.MeshPhysicalMaterial
  readonly contacts: THREE.MeshPhysicalMaterial
}

const materialCache = new Map<string, CartridgeMaterials>()

function buildMaterials(info: CartridgeInfo, lib: MaterialLibrary): CartridgeMaterials {
  const cached = materialCache.get(info.id)
  if (cached !== undefined) return cached

  // A casca sai do mesmo ABS da biblioteca (grão pebble, microarranhões, poeira),
  // só com outra cor e outra escala de tiling — assim o cartucho responde à luz
  // igual ao resto da máquina em vez de parecer vindo de outra cena.
  const base = lib.caseGraphite()
  const shellTop = retileClone(base, SHELL_TILING, SHELL_TILING, `cartucho-${info.id}-topo`)
  shellTop.color = new THREE.Color(info.corSuperior)
  shellTop.roughness = info.rugosidade
  shellTop.normalScale = new THREE.Vector2(0.22, 0.22)

  const shellBottom = retileClone(base, SHELL_TILING, SHELL_TILING, `cartucho-${info.id}-fundo`)
  shellBottom.color = new THREE.Color(info.corInferior)
  shellBottom.roughness = Math.min(0.78, info.rugosidade + 0.06)
  shellBottom.normalScale = new THREE.Vector2(0.22, 0.22)

  const art = renderLabelArtwork(info.id)
  const maps = paperMaps(art, hashString(`paper:${info.id}`))
  const labelFace = new THREE.MeshPhysicalMaterial({
    name: `cartucho-${info.id}-etiqueta`,
    map: texFromCanvas(art, true),
    roughnessMap: maps.roughnessMap,
    normalMap: maps.normalMap,
    normalScale: new THREE.Vector2(0.55, 0.55),
    // Papel: mais fosco que o ABS da casca e sem nenhum brilho especular duro.
    roughness: 0.72,
    metalness: 0,
    ior: 1.45,
    specularIntensity: 0.62,
    sheen: 0.22,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color(0xf2ece0),
    dithering: true,
  })
  owned.materials.push(labelFace)

  const labelEdge = new THREE.MeshPhysicalMaterial({
    name: `cartucho-${info.id}-etiqueta-corte`,
    // O corte da etiqueta mostra o miolo do papel, mais claro que a arte mas
    // encardido pela borda — nunca branco de folha nova.
    color: new THREE.Color(0xd8d0be),
    roughness: 0.9,
    metalness: 0,
    ior: 1.45,
    specularIntensity: 0.4,
    dithering: true,
  })
  owned.materials.push(labelEdge)

  const pcb = new THREE.MeshPhysicalMaterial({
    name: `cartucho-${info.id}-placa`,
    color: new THREE.Color(0x1c4d2c),
    roughness: 0.48,
    metalness: 0,
    clearcoat: 0.35,
    clearcoatRoughness: 0.45,
    ior: 1.55,
    dithering: true,
  })
  owned.materials.push(pcb)

  // Ouro de contato: banho fino sobre níquel, um pouco mais áspero que ouro puro.
  const contacts = retileClone(
    lib.metal(0xc9a227, 0.3),
    0.5,
    0.5,
    `cartucho-${info.id}-contatos`,
  )
  contacts.vertexColors = true
  contacts.needsUpdate = true

  const set: CartridgeMaterials = { shellTop, shellBottom, labelFace, labelEdge, pcb, contacts }
  materialCache.set(info.id, set)
  return set
}

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------

export interface CartridgeOptions {
  /** Compartimento a que o cartucho pertence — define o `partId` interativo. */
  readonly slot?: 'A' | 'B'
  /** Biblioteca de materiais. Sem ela, usa a capturada em `build()`. */
  readonly materials?: MaterialLibrary
}

let sharedMaterials: MaterialLibrary | null = null

function tagInteractive(group: THREE.Group, info: CartridgeInfo, slot: 'A' | 'B'): void {
  const data: InteractiveUserData = {
    partId: slot === 'A' ? 'cartridge-a' : 'cartridge-b',
    label: `${info.nome} — encaixe no compartimento ${slot}`,
    cursor: 'grab',
  }
  const payload = { ...data, romId: info.id, slot }
  Object.assign(group.userData, payload)
  group.traverse((child) => {
    if (child !== group) Object.assign(child.userData, payload)
  })
}

/**
 * Monta um cartucho. `romId` é o id do manifesto — o mesmo valor que vai para
 * `ScreenSource.insertCartridge()`.
 */
export function createCartridge(romId: string, options: CartridgeOptions = {}): THREE.Group {
  const lib = options.materials ?? sharedMaterials
  if (lib === null || lib === undefined) {
    throw new Error(
      'Cartridge: biblioteca de materiais indisponível — chame CartridgeModule.build(ctx) antes ou passe `options.materials`.',
    )
  }

  let info = getCartridgeInfo(romId)
  if (info === null) {
    const fallback = CARTRIDGE_MANIFEST[0]
    if (fallback === undefined) throw new Error('Cartridge: manifesto de cartuchos vazio.')
    console.warn(`[Cartridge] cartucho "${romId}" não existe no manifesto — usando "${fallback.id}".`)
    info = fallback
  }

  const mats = buildMaterials(info, lib)
  const group = new THREE.Group()
  group.name = `cartucho-${info.id}`

  const { top, bottom } = shellGeometries()

  const meshTop = new THREE.Mesh(top, mats.shellTop)
  meshTop.name = 'cartucho-casca-superior'
  meshTop.castShadow = true
  meshTop.receiveShadow = true
  group.add(meshTop)

  const meshBottom = new THREE.Mesh(bottom, mats.shellBottom)
  meshBottom.name = 'cartucho-casca-inferior'
  meshBottom.castShadow = true
  meshBottom.receiveShadow = true
  group.add(meshBottom)

  group.add(buildRibs(mats.shellTop))

  const pcbMesh = new THREE.Mesh(pcbGeometry(), mats.pcb)
  pcbMesh.name = 'cartucho-placa'
  pcbMesh.castShadow = true
  pcbMesh.receiveShadow = true
  group.add(pcbMesh)

  group.add(buildContacts(mats.contacts, info.desgasteContatos))

  const labelGeo = buildLabelGeometry(info.etiqueta, hashString(`label:${info.id}`))
  // Grupos já fundidos em `buildLabelGeometry`: 0 = corte do papel (é ele que dá
  // a espessura visível da etiqueta), 1 = face impressa.
  const labelMaterials: THREE.Material[] = []
  labelMaterials[LABEL_EDGE_INDEX] = mats.labelEdge
  labelMaterials[LABEL_FACE_INDEX] = mats.labelFace
  const label = new THREE.Mesh(labelGeo, labelMaterials)
  label.name = 'cartucho-etiqueta'
  // 15 µm de cola entre o papel e o ABS — evita faces coplanares sem abrir vão.
  label.position.set(
    info.etiqueta.deslocamentoX,
    T / 2 + LABEL_THICKNESS / 2 + 0.000015,
    info.etiqueta.deslocamentoZ,
  )
  label.castShadow = true
  label.receiveShadow = true
  group.add(label)

  tagInteractive(group, info, options.slot ?? 'A')
  return group
}

// ---------------------------------------------------------------------------
// SceneModule
// ---------------------------------------------------------------------------

/** Pose de repouso dos cartuchos soltos sobre a mesa. */
interface RestingPose {
  readonly romId: CartridgeId
  readonly slot: 'A' | 'B'
  readonly x: number
  readonly z: number
  readonly yaw: number
}

/**
 * Os dois cartuchos que ficam largados na mesa, à esquerda do console — fora da
 * pegada do teclado (0.435 de largura, centrado) e do próprio console (0.400).
 */
const RESTING: readonly RestingPose[] = [
  { romId: 'arcade-vermelho', slot: 'A', x: -0.303, z: 0.058, yaw: -0.16 },
  { romId: 'preto-generico', slot: 'B', x: -0.296, z: 0.152, yaw: 0.11 },
]

class CartridgeSceneModule implements SceneModule {
  readonly name = 'Cartridge'

  #root: THREE.Group | null = null

  async build(ctx: ModuleContext): Promise<THREE.Group> {
    sharedMaterials = ctx.materials

    const root = new THREE.Group()
    root.name = 'cartuchos'

    for (const pose of RESTING) {
      // Cada cartucho gera rótulo + papel + geometria: uma fatia por cartucho
      // mantém o boot em tarefas curtas (ver core/cooperative.ts).
      await yieldToMain()
      const cart = createCartridge(pose.romId, { slot: pose.slot, materials: ctx.materials })
      // Deitado na mesa: o centro do plástico fica a meia espessura do tampo.
      cart.position.set(pose.x, T / 2, pose.z)
      cart.rotation.y = pose.yaw
      root.add(cart)
    }

    this.#root = root
    return root
  }

  dispose(): void {
    this.#root?.clear()
    this.#root = null
    for (const g of owned.geometries) g.dispose()
    for (const m of owned.materials) m.dispose()
    for (const t of owned.textures) t.dispose()
    owned.geometries.length = 0
    owned.materials.length = 0
    owned.textures.length = 0
    materialCache.clear()
    shellTopGeo = null
    shellBottomGeo = null
    ribGeo = null
    pcbGeo = null
    contactGeo = null
    sharedMaterials = null
  }
}

/** Módulo de cena consumido pelo Engine. */
export const CartridgeModule: SceneModule = new CartridgeSceneModule()
