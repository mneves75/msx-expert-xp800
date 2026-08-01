/**
 * Mesa / palco — o "vazio de estúdio" onde a máquina flutua.
 *
 * SPEC §6: não é uma sala, é um set fotográfico. Existe exatamente uma superfície,
 * em `y = 0`, e nada mais: sem paredes, sem adereços, sem horizonte. Ela precisa
 * fazer três coisas ao mesmo tempo, sem nunca competir com o objeto:
 *
 *  1. **Receber a sombra de contato** — a projetada pela chave, o SSAO do
 *     pós-processamento e, principalmente, um termo analítico de oclusão calculado
 *     contra a pegada real de cada objeto apoiado nela. É esse último que faz o
 *     conjunto *tocar* a mesa em vez de pairar sobre ela.
 *  2. **Ter presença de material** — um grão fino e fosco que só aparece quando a
 *     luz de recorte passa rasante. Sem isso o chão vira um plano morto.
 *  3. **Devolver um reflexo planar suave**, nítido junto ao objeto e desfocado com
 *     a distância — como a bancada preta da foto `reference/raw/Expert_Extras.jpg`.
 *
 * O reflexo é planar de verdade (câmera espelhada renderizando num alvo próprio),
 * não um truque de espaço de tela: um SSR perderia justamente o que interessa, a
 * parte do objeto que fica fora do quadro. O desfoque por distância sai da cadeia
 * de mipmaps do alvo — fisicamente motivado, porque num plano espelhado a distância
 * até a base do objeto é proporcional à altura do ponto refletido.
 *
 * O desvanecimento radial é feito no fragmento, misturando a cor final com a cor do
 * vazio *antes* do tone mapping. Assim o disco não tem borda: ele simplesmente deixa
 * de existir. Um `alphaMap` traria ordenação de transparência e estragaria a
 * profundidade que o DoF e o SSAO consomem — por isso a malha continua opaca.
 *
 * Orçamento: 1 draw call na cena principal, 128 triângulos, um alvo de reflexo em
 * meia resolução. Zero bytes baixados — o grão é gerado aqui, em código.
 */

import * as THREE from 'three'

import { yieldToMain } from '../core/cooperative'
import type { ModuleContext, SceneModule } from '../core/types'
import { VOID_GRADIENT_GLSL, voidUniforms } from '../core/Lighting'

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

export interface DeskOptions {
  /** Raio do disco, em metros. Padrão 3.2 — o desvanecimento acaba muito antes. */
  readonly radius?: number
  /** Segmentos do leque radial. Padrão 128. */
  readonly segments?: number
  /** Altura do plano. Padrão -0.00025 m: evita z-fight com a base dos pés. */
  readonly height?: number
  /** Raio (m) onde o desvanecimento começa. Padrão 0.5. */
  readonly fadeInner?: number
  /** Raio (m) onde a superfície já virou vazio. Padrão 2.1. */
  readonly fadeOuter?: number
  /** Albedo da superfície. Padrão 0x0b0b0d — grafite quase preto, levemente frio. */
  readonly colour?: THREE.ColorRepresentation
  /** Rugosidade de pico. O mapa só reduz a partir daqui. Padrão 0.84. */
  readonly roughness?: number
  /** Relevo do grão. Padrão 0.16. Acima de ~0.5 o chão começa a "chamar atenção". */
  readonly normalScale?: number
  /** Repetições do grão sobre o disco inteiro. Padrão 40 (~16 cm por ladrilho). */
  readonly tiling?: number
  /** Habilita o reflexo planar. Padrão true. */
  readonly reflection?: boolean
  /** Intensidade do reflexo, aplicada sobre o termo de Fresnel. Padrão 0.72. */
  readonly reflectionStrength?: number
  /** Fração da resolução do canvas usada pelo alvo de reflexo. Padrão 0.7. */
  readonly reflectionScale?: number
  /** Largura máxima (px) do alvo de reflexo. Padrão 1600. */
  readonly reflectionMaxWidth?: number
  /** Amostras de MSAA no alvo de reflexo. Padrão 4. */
  readonly reflectionSamples?: number
  /**
   * Renderiza o reflexo a cada N frames. Padrão 2 — o espelho é escuro e
   * desfocado, então 30 Hz é indistinguível de 60 Hz e devolve metade do custo.
   * A matriz de textura só é atualizada junto com o alvo, portanto o reflexo
   * atrasado continua ancorado no mundo em vez de escorregar.
   */
  readonly reflectionInterval?: number
}

/** Módulo da mesa, com os poucos controles que a UI de depuração pode querer. */
export interface DeskModule extends SceneModule {
  /** Null antes do `build()`. */
  readonly ground: THREE.Mesh | null
  /** Liga/desliga o passe de reflexo (custa uma renderização extra da cena). */
  setReflectionEnabled(enabled: boolean): void
  /** 0 = sem reflexo. 1 = calibrado. Valores acima de ~1.6 viram piso de shopping. */
  setReflectionStrength(strength: number): void
  /** Ajusta o gradiente radial, em metros. */
  setFalloff(inner: number, outer: number): void
}

const DEFAULTS = {
  radius: 3.2,
  segments: 128,
  height: -0.00025,
  fadeInner: 0.5,
  fadeOuter: 2.1,
  colour: 0x0b0b0d,
  roughness: 0.84,
  normalScale: 0.16,
  tiling: 40,
  reflection: true,
  // 1.05 punha a bancada em primeiro plano acima do produto em brilho. O espelho é um
  // detalhe de material, não um segundo assunto.
  reflectionStrength: 0.72,
  // Meia resolução escadeava visivelmente sob o painel traseiro (degraus horizontais de
  // uns 4 px). A 0.7 / 1600 px o passo some sem custar um render inteiro.
  reflectionScale: 0.7,
  reflectionMaxWidth: 1600,
  reflectionSamples: 4,
  reflectionInterval: 2,
} as const

/** Distância (m) a partir da qual o reflexo começa a borrar. */
const BLUR_START = 0.10
/** Níveis de mip por metro de distância. */
const BLUR_PER_METRE = 3.6
/**
 * Deslocamento máximo do reflexo pelo mapa de normais, em UV de tela.
 *
 * Estava em 0.012 — quase 23 px a 1920. Um deslocamento desse tamanho, guiado por um
 * mapa de normais de alta frequência, espalha o reflexo brilhante do teclado em fiapos
 * de 1–2 px ao longo de toda a linha de contato: a "franja de pelo" que denunciava a
 * cena de imediato. 0.0016 é ~3 px e continua quebrando o espelho o suficiente para
 * ele não parecer vidro polido.
 */
const REFLECT_DISTORTION = 0.0016

/** Quantos volumes de contato o shader consegue considerar. */
const CONTACT_MAX = 8
/** Metros. Distância em que a sombra de contato decai a ~5 % (3 × este valor). */
const CONTACT_FALLOFF = 0.011
/** Oclusão no ponto de contato. 0.78 = a mesa cai a 22 % do valor iluminado. */
const CONTACT_STRENGTH = 0.78
/** Frames entre releituras das pegadas dos objetos. */
const CONTACT_REFRESH = 240
/** Lado do mapa de grão, em texels. */
const GRAIN_SIZE = 1024
/** Semente do grão — fixa, para a mesa ser idêntica em todo reload. */
const GRAIN_SEED = 0x5c9d
/** Amplitude (±) da variação larga de rugosidade calculada no shader. */
const MOTTLE = 0.07

// ---------------------------------------------------------------------------
// Shader — injeções no MeshPhysicalMaterial
// ---------------------------------------------------------------------------

const VERTEX_DECLARATIONS = /* glsl */ `
uniform mat4 uDeskReflectMatrix;
varying vec3 vDeskWorld;
varying vec4 vDeskReflect;
`

const VERTEX_BODY = /* glsl */ `
vDeskWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vDeskReflect = uDeskReflectMatrix * vec4( transformed, 1.0 );
`

const FRAGMENT_DECLARATIONS = /* glsl */ `
uniform sampler2D uDeskReflectMap;
uniform vec3 uDeskCentre;
uniform vec2 uDeskFalloff;
uniform float uDeskReflectStrength;
uniform float uDeskBlurStart;
uniform float uDeskBlurScale;
uniform float uDeskMaxLod;
uniform float uDeskDistortion;
uniform float uDeskMottle;
uniform vec4 uContactRect[ ${CONTACT_MAX} ];
uniform vec2 uContactMeta[ ${CONTACT_MAX} ];
uniform int uContactCount;
varying vec3 vDeskWorld;
varying vec4 vDeskReflect;

${VOID_GRADIENT_GLSL}

float deskHash( vec2 p ) {
  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
}

float deskNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = deskHash( i );
  float b = deskHash( i + vec2( 1.0, 0.0 ) );
  float c = deskHash( i + vec2( 0.0, 1.0 ) );
  float d = deskHash( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

/**
 * Sombra de contato: oclusão de ambiente analítica contra a pegada real de cada objeto
 * apoiado na mesa (retângulos lidos da cena em tempo de execução, não valores fixos).
 *
 * É este termo, e não o mapa de sombras, que faz um objeto "tocar" a mesa. Uma sombra
 * projetada por uma fonte de 1.2 m tem penumbra larga por definição; o que o olho
 * procura é o núcleo escuro nos últimos milímetros antes do contato, onde nenhuma luz
 * ambiente consegue entrar. Sem ele tudo levita, por melhor que seja o resto.
 */
float deskContact( vec2 p ) {
  float occlusion = 0.0;
  for ( int i = 0; i < ${CONTACT_MAX}; i++ ) {
    if ( i >= uContactCount ) break;
    vec4 rect = uContactRect[ i ];
    vec2 d = abs( p - rect.xy ) - rect.zw;
    // Distância assinada até o retângulo; negativa dentro dele.
    float outside = length( max( d, vec2( 0.0 ) ) ) + min( max( d.x, d.y ), 0.0 );
    vec2 meta = uContactMeta[ i ];
    occlusion = max( occlusion, meta.y * exp( -max( outside, 0.0 ) / meta.x ) );
  }
  return clamp( occlusion, 0.0, 1.0 );
}
`

/**
 * Variação larga de rugosidade calculada a partir da posição no mundo, não da UV:
 * é o que dá manchas de polimento e poeira sem trazer junto a assinatura do
 * ladrilho. Toda estrutura de baixa frequência que vem de textura repetida vira
 * xadrez no rasante — este é o motivo de ela ser analítica aqui.
 */
const ROUGHNESS_BODY = /* glsl */ `
{
  vec2 deskP = vDeskWorld.xz;
  float deskMottleValue =
    deskNoise( deskP * 1.7 ) * 0.62 +
    deskNoise( deskP * 4.1 ) * 0.38 - 0.5;
  roughnessFactor = clamp( roughnessFactor + deskMottleValue * uDeskMottle, 0.08, 1.0 );

  // Toksvig, na prática: quando um pixel cobre muitos texels do grão (distância ou
  // ângulo rasante), a variância das normais deixa de ser relevo e vira rugosidade.
  // Filtragem anisotrópica sozinha não resolve isso — ela suaviza a textura, mas a
  // especular continua brilhando em cada crista sobrevivente, e o resultado é a franja
  // serrilhada na borda da mesa.
  float deskFootprint = length( fwidth( vDeskWorld.xz ) );
  float deskFlatten = smoothstep( 0.0006, 0.0042, deskFootprint );
  roughnessFactor = clamp( mix( roughnessFactor, 0.97, deskFlatten * 0.8 ), 0.08, 1.0 );
}
`

/** Achata a normal perturbada na mesma medida em que a rugosidade sobe. */
const NORMAL_BODY = /* glsl */ `
{
  float deskFootprintN = length( fwidth( vDeskWorld.xz ) );
  float deskFlattenN = smoothstep( 0.0006, 0.0042, deskFootprintN );
  normal = normalize( mix( normal, nonPerturbedNormal, deskFlattenN ) );
}
`

/**
 * Injetado imediatamente antes de `opaque_fragment`, ainda em espaço linear e
 * antes de qualquer tone mapping — é o único ponto em que somar o reflexo e
 * misturar o vazio dá o mesmo resultado com e sem a cadeia de pós-processamento.
 */
const FRAGMENT_BODY = /* glsl */ `
{
  float deskRadius = length( vDeskWorld.xz - uDeskCentre.xz );
  float deskFade = 1.0 - smoothstep( uDeskFalloff.x, uDeskFalloff.y, deskRadius );
  deskFade = pow( deskFade, 1.6 );

  float deskOcclusion = deskContact( vDeskWorld.xz );
  outgoingLight *= ( 1.0 - deskOcclusion );

  if ( uDeskReflectStrength > 0.0 && vDeskReflect.w > 0.0 ) {
    vec2 deskUv = vDeskReflect.xy / vDeskReflect.w;

    #ifdef USE_NORMALMAP_TANGENTSPACE
      // O mesmo grão que espalha a especular também quebra o espelho, de leve.
      vec2 deskWobble = ( texture2D( normalMap, vNormalMapUv ).xy - 0.5 ) * uDeskDistortion;
      deskUv += deskWobble;
    #endif

    // Longe da base do objeto = ponto refletido mais alto = caminho óptico maior.
    float deskLod = clamp( ( deskRadius - uDeskBlurStart ) * uDeskBlurScale, 0.0, uDeskMaxLod );
    vec3 deskMirror = textureLod( uDeskReflectMap, clamp( deskUv, vec2( 0.0 ), vec2( 1.0 ) ), deskLod ).rgb;

    vec3 deskView = normalize( cameraPosition - vDeskWorld );
    // Fresnel com a normal geométrica (não a perturbada): mantém o reflexo estável.
    float deskCos = clamp( dot( deskView, vec3( 0.0, 1.0, 0.0 ) ), 0.0, 1.0 );
    // F90 bem abaixo de 1: uma bancada de estúdio não vira espelho no rasante. Com o
    // valor antigo (0.545) a mesa em primeiro plano virava a região mais clara do
    // quadro — mais clara que o próprio produto, que é uma inversão de hierarquia.
    float deskFresnel = 0.03 + 0.24 * pow( 1.0 - deskCos, 4.0 );

    // O núcleo da sombra de contato também apaga o espelho: nenhuma luz chega ali.
    outgoingLight += deskMirror * ( uDeskReflectStrength * deskFresnel * ( 1.0 - deskOcclusion * 0.85 ) );
  }

  // O vazio é a MESMA função usada pela cúpula do fundo, avaliada no mesmo raio de
  // visão — então a borda do disco não existe: a mesa vira fundo sem costura.
  vec3 deskVoid = msxVoidRadiance( vDeskWorld - cameraPosition );
  outgoingLight = mix( deskVoid, outgoingLight, deskFade );
}
`

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** `Matrix4.elements` é `number[]`; com `noUncheckedIndexedAccess` precisa de guarda. */
function el(matrix: THREE.Matrix4, index: number): number {
  return matrix.elements[index] ?? 0
}

/** PRNG determinístico — a mesa é idêntica em toda máquina e em todo reload. */
function rng(seed: number): () => number {
  let state = (seed | 0) || 1
  return () => {
    state = (state * 1664525 + 1013904223) | 0
    return ((state >>> 8) & 0xffffff) / 0x1000000
  }
}

function smootherStep(t: number): number {
  return t * t * (3 - 2 * t)
}

/**
 * Ruído de valor com látice periódico: os índices dão a volta em `cells`, então o
 * campo é perfeitamente seamless na borda da textura.
 */
function periodicValueNoise(size: number, cells: number, random: () => number): Float32Array {
  const lattice = new Float32Array(cells * cells)
  for (let i = 0; i < lattice.length; i++) lattice[i] = random()

  const field = new Float32Array(size * size)
  const scale = cells / size
  for (let y = 0; y < size; y++) {
    const fy = y * scale
    const y0 = Math.floor(fy) % cells
    const y1 = (y0 + 1) % cells
    const ty = smootherStep(fy - Math.floor(fy))
    for (let x = 0; x < size; x++) {
      const fx = x * scale
      const x0 = Math.floor(fx) % cells
      const x1 = (x0 + 1) % cells
      const tx = smootherStep(fx - Math.floor(fx))
      const a = lattice[y0 * cells + x0] ?? 0
      const b = lattice[y0 * cells + x1] ?? 0
      const c = lattice[y1 * cells + x0] ?? 0
      const d = lattice[y1 * cells + x1] ?? 0
      const top = a + (b - a) * tx
      const bottom = c + (d - c) * tx
      field[y * size + x] = top + (bottom - top) * ty
    }
  }
  return field
}

export interface GrainMaps {
  readonly normalMap: THREE.DataTexture
  readonly roughnessMap: THREE.DataTexture
}

/**
 * Grão fino da mesa — e a razão de ele não vir de `textures/procedural`.
 *
 * O grão do gabinete tem estrutura de baixa frequência (células de pebble); num
 * plano visto em ângulo rasante essa estrutura repete e o chão vira xadrez. Aqui
 * o campo de altura só tem oitavas curtas (16, 8 e 4 px), então o ladrilho some:
 * ruído de alta frequência não tem "desenho" para o olho reconhecer.
 */
function fineGrainMaps(size: number, seed: number): GrainMaps {
  const random = rng(seed)
  const octaves: readonly (readonly [number, number])[] = [
    [size / 16, 0.5],
    [size / 8, 0.32],
    [size / 4, 0.18],
  ]

  const height = new Float32Array(size * size)
  for (const [cells, weight] of octaves) {
    const field = periodicValueNoise(size, Math.max(2, Math.round(cells)), random)
    for (let i = 0; i < height.length; i++) height[i] = (height[i] ?? 0) + (field[i] ?? 0) * weight
  }

  const normalData = new Uint8Array(size * size * 4)
  const roughData = new Uint8Array(size * size * 4)
  const at = (x: number, y: number): number =>
    height[((y + size) % size) * size + ((x + size) % size)] ?? 0

  // Sobel sobre o campo de altura: relevo coerente, um único height field.
  const relief = 5.5
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
      const dy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
      const nx = -dx * relief
      const ny = -dy * relief
      const inv = 1 / Math.hypot(nx, ny, 1)
      const i = (y * size + x) * 4
      normalData[i] = Math.round((nx * inv * 0.5 + 0.5) * 255)
      normalData[i + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255)
      normalData[i + 2] = Math.round((inv * 0.5 + 0.5) * 255)
      normalData[i + 3] = 255

      // Rugosidade acompanha o micro-relevo: vale polido, crista áspera.
      const h = height[y * size + x] ?? 0
      const r = Math.round((0.9 + 0.1 * h) * 255)
      roughData[i] = r
      roughData[i + 1] = r
      roughData[i + 2] = r
      roughData[i + 3] = 255
    }
  }

  const normalMap = new THREE.DataTexture(normalData, size, size, THREE.RGBAFormat)
  normalMap.name = 'mesa-grao-normal'
  const roughnessMap = new THREE.DataTexture(roughData, size, size, THREE.RGBAFormat)
  roughnessMap.name = 'mesa-grao-rugosidade'

  for (const texture of [normalMap, roughnessMap]) {
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.generateMipmaps = true
    texture.needsUpdate = true
  }

  return { normalMap, roughnessMap }
}

// ---------------------------------------------------------------------------
// Módulo
// ---------------------------------------------------------------------------

/** Configuração já resolvida — mutável, porque a UI de depuração ajusta em tempo real. */
interface DeskConfig {
  radius: number
  segments: number
  height: number
  fadeInner: number
  fadeOuter: number
  colour: THREE.ColorRepresentation
  roughness: number
  normalScale: number
  tiling: number
  reflection: boolean
  reflectionStrength: number
  reflectionScale: number
  reflectionMaxWidth: number
  reflectionSamples: number
  reflectionInterval: number
}

class StudioDesk implements DeskModule {
  readonly name = 'Desk'

  ground: THREE.Mesh | null = null

  private readonly opts: DeskConfig

  private group: THREE.Group | null = null
  private geometry: THREE.CircleGeometry | null = null
  private material: THREE.MeshPhysicalMaterial | null = null
  private readonly ownedTextures: THREE.Texture[] = []

  // ── reflexo ────────────────────────────────────────────────────────────────
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private target: THREE.WebGLRenderTarget | null = null
  private readonly virtualCamera = new THREE.PerspectiveCamera()
  private reflectionEnabled: boolean
  /** Desligado permanentemente se o passe falhar — a cena nunca cai por causa dele. */
  private reflectionBroken = false
  private frame = 0

  private readonly uniforms = {
    uDeskReflectMatrix: { value: new THREE.Matrix4() },
    uDeskReflectMap: { value: null as THREE.Texture | null },
    uDeskCentre: { value: new THREE.Vector3(0, 0, 0) },
    uDeskFalloff: { value: new THREE.Vector2(DEFAULTS.fadeInner, DEFAULTS.fadeOuter) },
    uDeskReflectStrength: { value: 0 },
    uDeskBlurStart: { value: BLUR_START },
    uDeskBlurScale: { value: BLUR_PER_METRE },
    uDeskMaxLod: { value: 5 },
    uDeskDistortion: { value: REFLECT_DISTORTION },
    uDeskMottle: { value: MOTTLE },
    uContactRect: {
      value: Array.from({ length: CONTACT_MAX }, () => new THREE.Vector4(0, 0, 0, 0)),
    },
    uContactMeta: {
      value: Array.from({ length: CONTACT_MAX }, () => new THREE.Vector2(CONTACT_FALLOFF, 0)),
    },
    uContactCount: { value: 0 },
  }

  // ── sombra de contato ──────────────────────────────────────────────────────
  private readonly contactBox = new THREE.Box3()
  private readonly meshBox = new THREE.Box3()

  // Temporários do algoritmo de espelhamento — nada aloca por frame.
  private readonly reflectorPosition = new THREE.Vector3()
  private readonly cameraPosition = new THREE.Vector3()
  private readonly planeNormal = new THREE.Vector3()
  private readonly rotation = new THREE.Matrix4()
  private readonly view = new THREE.Vector3()
  private readonly lookAt = new THREE.Vector3()
  private readonly lookTarget = new THREE.Vector3()
  private readonly reflectorPlane = new THREE.Plane()
  private readonly clipPlane = new THREE.Vector4()
  private readonly clipQ = new THREE.Vector4()
  private readonly drawingBuffer = new THREE.Vector2()

  constructor(options: DeskOptions = {}) {
    this.opts = {
      radius: options.radius ?? DEFAULTS.radius,
      segments: options.segments ?? DEFAULTS.segments,
      height: options.height ?? DEFAULTS.height,
      fadeInner: options.fadeInner ?? DEFAULTS.fadeInner,
      fadeOuter: options.fadeOuter ?? DEFAULTS.fadeOuter,
      colour: options.colour ?? DEFAULTS.colour,
      roughness: options.roughness ?? DEFAULTS.roughness,
      normalScale: options.normalScale ?? DEFAULTS.normalScale,
      tiling: options.tiling ?? DEFAULTS.tiling,
      reflection: options.reflection ?? DEFAULTS.reflection,
      reflectionStrength: options.reflectionStrength ?? DEFAULTS.reflectionStrength,
      reflectionScale: options.reflectionScale ?? DEFAULTS.reflectionScale,
      reflectionMaxWidth: options.reflectionMaxWidth ?? DEFAULTS.reflectionMaxWidth,
      reflectionSamples: options.reflectionSamples ?? DEFAULTS.reflectionSamples,
      reflectionInterval: Math.max(1, Math.round(options.reflectionInterval ?? DEFAULTS.reflectionInterval)),
    }
    this.reflectionEnabled = this.opts.reflection
  }

  // ── construção ─────────────────────────────────────────────────────────────

  async build(ctx: ModuleContext): Promise<THREE.Group> {
    this.renderer = ctx.renderer
    this.scene = ctx.scene
    this.camera = ctx.camera

    const group = new THREE.Group()
    group.name = 'mesa-estudio'

    this.uniforms.uDeskFalloff.value.set(this.opts.fadeInner, this.opts.fadeOuter)

    this.geometry = new THREE.CircleGeometry(this.opts.radius, this.opts.segments)
    // O grão fino da mesa é o único trabalho pesado deste módulo: fatia própria.
    await yieldToMain()
    this.material = this.buildMaterial(ctx.renderer)

    const mesh = new THREE.Mesh(this.geometry, this.material)
    mesh.name = 'mesa-superficie'
    mesh.rotation.x = -Math.PI / 2
    mesh.position.y = this.opts.height
    // Recebe sombra, nunca projeta: é a base do mundo, não há nada abaixo dela.
    mesh.receiveShadow = true
    mesh.castShadow = false
    // O disco cobre o quadro inteiro em qualquer pose; testar frustum é desperdício.
    mesh.frustumCulled = false
    // Sem `renderOrder`: a ordenação padrão dos opacos (frente para trás) já é a
    // melhor para overdraw, e forçar o chão para o início seria o pior caso.
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()

    group.add(mesh)
    group.updateMatrixWorld(true)

    this.ground = mesh
    this.group = group

    if (this.reflectionEnabled) this.setupReflection(ctx.renderer)

    return group
  }

  /**
   * Relê a pegada de cada objeto apoiado na mesa e alimenta a sombra de contato.
   *
   * Os retângulos saem da geometria real, não de constantes: outro módulo pode mover,
   * redimensionar ou substituir o console sem que a sombra de contato saia do lugar.
   * Filtros conservadores — nada muito grande (a cúpula do vazio, o próprio disco),
   * nada rasteiro demais (cabos deitados) e nada que não encoste na mesa.
   */
  private refreshContacts(): void {
    const scene = this.scene
    if (scene === null) return

    interface Footprint {
      readonly cx: number
      readonly cz: number
      readonly hx: number
      readonly hz: number
      readonly area: number
    }
    const found: Footprint[] = []

    for (const child of scene.children) {
      if (child === this.group || !child.visible) continue
      const probe = child as unknown as { isCamera?: boolean; isLight?: boolean }
      if (probe.isCamera === true || probe.isLight === true) continue

      // Só entram as malhas que *encostam* na mesa. A caixa envolvente do objeto
      // inteiro seria muito maior que o apoio real — o tubo do monitor avança bem além
      // do seu pé — e a sombra viraria um retângulo preto óbvio ao redor da peça.
      this.contactBox.makeEmpty()
      child.updateWorldMatrix(true, true)
      child.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (mesh.isMesh !== true || !mesh.visible) return
        const geometry = mesh.geometry
        if (geometry.boundingBox === null) geometry.computeBoundingBox()
        const bounds = geometry.boundingBox
        if (bounds === null) return
        this.meshBox.copy(bounds).applyMatrix4(mesh.matrixWorld)
        if (this.meshBox.min.y > 0.012 || this.meshBox.min.y < -0.05) return
        this.contactBox.union(this.meshBox)
      })
      if (this.contactBox.isEmpty()) continue

      const { min, max } = this.contactBox
      const width = max.x - min.x
      const depth = max.z - min.z
      // Precisa caber num set de estúdio: nada de cúpulas nem do próprio disco.
      if (width < 0.03 || depth < 0.03 || width > 0.8 || depth > 0.8) continue

      found.push({
        cx: (min.x + max.x) * 0.5,
        cz: (min.z + max.z) * 0.5,
        // Recolhe 1 mm: a caixa envolvente é sempre um pouco maior que o apoio real.
        hx: Math.max(0.001, width * 0.5 - 0.001),
        hz: Math.max(0.001, depth * 0.5 - 0.001),
        area: width * depth,
      })
    }

    found.sort((a, b) => b.area - a.area)
    const count = Math.min(CONTACT_MAX, found.length)
    for (let i = 0; i < count; i++) {
      const f = found[i]
      if (f === undefined) continue
      this.uniforms.uContactRect.value[i]?.set(f.cx, f.cz, f.hx, f.hz)
      this.uniforms.uContactMeta.value[i]?.set(CONTACT_FALLOFF, CONTACT_STRENGTH)
    }
    this.uniforms.uContactCount.value = count
  }

  private buildMaterial(renderer: THREE.WebGLRenderer): THREE.MeshPhysicalMaterial {
    const { normalMap, roughnessMap } = fineGrainMaps(GRAIN_SIZE, GRAIN_SEED)
    const anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy())
    const repeat = this.opts.tiling
    for (const texture of [normalMap, roughnessMap]) {
      texture.repeat.set(repeat, repeat)
      texture.anisotropy = anisotropy
      this.ownedTextures.push(texture)
    }

    const material = new THREE.MeshPhysicalMaterial({
      name: 'mesa-estudio',
      color: new THREE.Color(this.opts.colour),
      roughness: this.opts.roughness,
      metalness: 0,
      ior: 1.5,
      // Superfície fosca e escura devolve pouco especular direto; o brilho que
      // interessa vem do reflexo planar, não do lóbulo do material. F90 baixo é
      // o que impede o lençol leitoso quando a luz de recorte passa rasante.
      specularIntensity: 0.16,
      envMapIntensity: 0.22,
      normalMap,
      normalScale: new THREE.Vector2(this.opts.normalScale, this.opts.normalScale),
      roughnessMap,
      dithering: true,
      fog: false,
    })

    material.onBeforeCompile = (shader): void => {
      shader.uniforms['uDeskReflectMatrix'] = this.uniforms.uDeskReflectMatrix
      shader.uniforms['uDeskReflectMap'] = this.uniforms.uDeskReflectMap
      shader.uniforms['uDeskCentre'] = this.uniforms.uDeskCentre
      shader.uniforms['uDeskFalloff'] = this.uniforms.uDeskFalloff
      shader.uniforms['uDeskReflectStrength'] = this.uniforms.uDeskReflectStrength
      shader.uniforms['uDeskBlurStart'] = this.uniforms.uDeskBlurStart
      shader.uniforms['uDeskBlurScale'] = this.uniforms.uDeskBlurScale
      shader.uniforms['uDeskMaxLod'] = this.uniforms.uDeskMaxLod
      shader.uniforms['uDeskDistortion'] = this.uniforms.uDeskDistortion
      shader.uniforms['uDeskMottle'] = this.uniforms.uDeskMottle
      shader.uniforms['uContactRect'] = this.uniforms.uContactRect
      shader.uniforms['uContactMeta'] = this.uniforms.uContactMeta
      shader.uniforms['uContactCount'] = this.uniforms.uContactCount
      // O gradiente do vazio é compartilhado com a cúpula do fundo, por referência.
      shader.uniforms['uVoidLow'] = voidUniforms.uVoidLow
      shader.uniforms['uVoidHorizon'] = voidUniforms.uVoidHorizon
      shader.uniforms['uVoidHigh'] = voidUniforms.uVoidHigh
      shader.uniforms['uVoidSpill'] = voidUniforms.uVoidSpill
      shader.uniforms['uVoidSpillDir'] = voidUniforms.uVoidSpillDir

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERTEX_DECLARATIONS}`)
        .replace('#include <project_vertex>', `${VERTEX_BODY}\n#include <project_vertex>`)

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAGMENT_DECLARATIONS}`)
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>\n${ROUGHNESS_BODY}`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>\n${NORMAL_BODY}`,
        )
        .replace('#include <opaque_fragment>', `${FRAGMENT_BODY}\n#include <opaque_fragment>`)
    }
    // Chave própria de cache: o programa da mesa nunca é reaproveitado por outro
    // MeshPhysicalMaterial da cena (nem o contrário).
    material.customProgramCacheKey = (): string => 'desk-studio-ground-v3'

    return material
  }

  // ── reflexo planar ─────────────────────────────────────────────────────────

  private setupReflection(renderer: THREE.WebGLRenderer): void {
    if (this.target !== null) return
    const { width, height } = this.reflectionSize(renderer)

    const target = new THREE.WebGLRenderTarget(width, height, {
      // Meia precisão: o alvo guarda a cena em HDR linear, exatamente como o
      // composer espera. Sem colorSpace declarado = sem codificação na escrita.
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.opts.reflectionSamples,
    })
    target.texture.name = 'mesa-reflexo'
    target.texture.wrapS = THREE.ClampToEdgeWrapping
    target.texture.wrapT = THREE.ClampToEdgeWrapping

    this.target = target
    this.uniforms.uDeskReflectMap.value = target.texture
    this.uniforms.uDeskReflectStrength.value = this.opts.reflectionStrength
    this.updateLodCeiling(width, height)
  }

  private reflectionSize(renderer: THREE.WebGLRenderer): { width: number; height: number } {
    renderer.getDrawingBufferSize(this.drawingBuffer)
    const aspect = this.drawingBuffer.y > 0 ? this.drawingBuffer.y / this.drawingBuffer.x : 0.5625
    const width = Math.round(
      Math.min(
        this.opts.reflectionMaxWidth,
        Math.max(256, this.drawingBuffer.x * this.opts.reflectionScale),
      ),
    )
    const height = Math.max(128, Math.round(width * aspect))
    return { width, height }
  }

  private updateLodCeiling(width: number, height: number): void {
    // Um mip abaixo do topo: o último nível é 1×1 e leva o fundo inteiro junto.
    const levels = Math.floor(Math.log2(Math.max(2, Math.min(width, height))))
    this.uniforms.uDeskMaxLod.value = Math.max(1, Math.min(6, levels - 1))
  }

  private renderReflection(): void {
    const renderer = this.renderer
    const scene = this.scene
    const camera = this.camera
    const mesh = this.ground
    const target = this.target
    if (
      renderer === null ||
      scene === null ||
      camera === null ||
      mesh === null ||
      target === null ||
      this.reflectionBroken ||
      !this.reflectionEnabled
    ) {
      return
    }

    const { width, height } = this.reflectionSize(renderer)
    if (target.width !== width || target.height !== height) {
      target.setSize(width, height)
      this.updateLodCeiling(width, height)
    }

    this.group?.updateMatrixWorld(true)
    camera.updateMatrixWorld()

    this.reflectorPosition.setFromMatrixPosition(mesh.matrixWorld)
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld)
    this.rotation.extractRotation(mesh.matrixWorld)
    this.planeNormal.set(0, 0, 1).applyMatrix4(this.rotation).normalize()

    this.view.subVectors(this.reflectorPosition, this.cameraPosition)
    // Câmera abaixo do plano: não há reflexo a calcular, o quadro já está errado.
    if (this.view.dot(this.planeNormal) > 0) return
    this.view.reflect(this.planeNormal).negate().add(this.reflectorPosition)

    this.rotation.extractRotation(camera.matrixWorld)
    this.lookAt.set(0, 0, -1).applyMatrix4(this.rotation).add(this.cameraPosition)
    this.lookTarget.subVectors(this.reflectorPosition, this.lookAt)
    this.lookTarget.reflect(this.planeNormal).negate().add(this.reflectorPosition)

    const virtual = this.virtualCamera
    virtual.position.copy(this.view)
    virtual.up.set(0, 1, 0).applyMatrix4(this.rotation).reflect(this.planeNormal)
    virtual.lookAt(this.lookTarget)
    virtual.near = camera.near
    virtual.far = camera.far
    virtual.updateMatrixWorld()
    virtual.projectionMatrix.copy(camera.projectionMatrix)

    // Matriz de textura: projeta o fragmento do chão nas coordenadas do alvo.
    // Calculada com a projeção ainda limpa — o corte oblíquo abaixo mexe só na
    // linha de z, portanto x/y projetados continuam idênticos.
    const textureMatrix = this.uniforms.uDeskReflectMatrix.value
    textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
    textureMatrix.multiply(virtual.projectionMatrix)
    textureMatrix.multiply(virtual.matrixWorldInverse)
    textureMatrix.multiply(mesh.matrixWorld)

    this.applyObliqueClip(virtual)

    const previousTarget = renderer.getRenderTarget()
    const previousXr = renderer.xr.enabled
    // O espelho não pode espelhar a si mesmo.
    mesh.visible = false
    renderer.xr.enabled = false

    // Nota, testada: NÃO desligue `shadowMap.autoUpdate` para poupar o passe de
    // sombra aqui. Com ele desligado o three pula o passe inteiro e deixa os
    // samplers de sombra sem textura — cada draw do frame passa a cuspir
    // `GL_INVALID_OPERATION: mismatch between texture format and sampler type`.
    // O custo do mapa duplicado é pago pelo `reflectionInterval`.
    try {
      renderer.setRenderTarget(target)
      renderer.render(scene, virtual)
    } catch (error) {
      this.reflectionBroken = true
      this.uniforms.uDeskReflectStrength.value = 0
      console.error('[Desk] passe de reflexo falhou — a mesa segue sem espelho:', error)
    } finally {
      renderer.setRenderTarget(previousTarget)
      renderer.xr.enabled = previousXr
      mesh.visible = true
    }
  }

  /**
   * Empurra o plano near da câmera virtual para cima do plano do chão (projeção
   * oblíqua, o mesmo truque do `Reflector` do three). Sem isso, qualquer geometria
   * abaixo de `y = 0` apareceria espelhada e atravessaria a mesa.
   */
  private applyObliqueClip(virtual: THREE.PerspectiveCamera): void {
    const clipBias = 0.003
    this.reflectorPlane.setFromNormalAndCoplanarPoint(this.planeNormal, this.reflectorPosition)
    this.reflectorPlane.applyMatrix4(virtual.matrixWorldInverse)

    const plane = this.reflectorPlane
    this.clipPlane.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant)

    const projection = virtual.projectionMatrix
    this.clipQ.x = (Math.sign(this.clipPlane.x) + el(projection, 8)) / el(projection, 0)
    this.clipQ.y = (Math.sign(this.clipPlane.y) + el(projection, 9)) / el(projection, 5)
    this.clipQ.z = -1
    this.clipQ.w = (1 + el(projection, 10)) / el(projection, 14)

    const denominator = this.clipPlane.dot(this.clipQ)
    if (Math.abs(denominator) < 1e-6) return
    this.clipPlane.multiplyScalar(2 / denominator)

    projection.elements[2] = this.clipPlane.x
    projection.elements[6] = this.clipPlane.y
    projection.elements[10] = this.clipPlane.z + 1 - clipBias
    projection.elements[14] = this.clipPlane.w
  }

  // ── ciclo de vida ──────────────────────────────────────────────────────────

  update(): boolean {
    // A mesa é consumidora de mudança, nunca produtora: seu reflexo e suas pegadas só
    // mudam se a cena principal mudou — e aí outro módulo (ou a câmera) já manteve o
    // quadro acordado. Retornar `false` deixa o Engine dormir; o trabalho acoplado ao
    // render vive em `beforeRender`, que só roda em quadros realmente apresentados.
    return false
  }

  beforeRender(): void {
    // Roda imediatamente antes do render principal, só em quadros apresentados: a
    // câmera já está no lugar e nenhum passe de reflexo é gasto num quadro pulado.
    // `frame` conta quadros APRESENTADOS — o Engine garante WARM_FRAMES > 8, então a
    // leitura de contatos do frame 8 sempre acontece.
    const interval = this.opts.reflectionInterval
    const due = this.frame < 2 || interval <= 1 || this.frame % interval === 0

    // As pegadas só mudam quando alguém insere um cartucho ou move o joystick — mas o
    // módulo da mesa constrói antes de todos os outros, então a primeira leitura tem
    // de esperar a cena existir.
    if (this.frame === 8 || (this.frame > 8 && this.frame % CONTACT_REFRESH === 0)) {
      this.refreshContacts()
    }

    this.frame += 1
    if (due) this.renderReflection()
  }

  /** Força uma releitura das pegadas no próximo frame (após inserir/remover peças). */
  invalidateContacts(): void {
    this.refreshContacts()
  }

  setReflectionEnabled(enabled: boolean): void {
    this.reflectionEnabled = enabled && !this.reflectionBroken
    if (enabled && this.renderer !== null && this.target === null && !this.reflectionBroken) {
      this.setupReflection(this.renderer)
    }
    this.uniforms.uDeskReflectStrength.value = this.reflectionEnabled
      ? this.opts.reflectionStrength
      : 0
  }

  setReflectionStrength(strength: number): void {
    const clamped = Math.max(0, strength)
    this.opts.reflectionStrength = clamped
    if (this.reflectionEnabled && !this.reflectionBroken) {
      this.uniforms.uDeskReflectStrength.value = clamped
    }
  }

  setFalloff(inner: number, outer: number): void {
    const safeInner = Math.max(0, inner)
    const safeOuter = Math.max(safeInner + 0.01, outer)
    this.opts.fadeInner = safeInner
    this.opts.fadeOuter = safeOuter
    this.uniforms.uDeskFalloff.value.set(safeInner, safeOuter)
  }

  dispose(): void {
    this.frame = 0
    this.geometry?.dispose()
    this.geometry = null
    this.material?.dispose()
    this.material = null
    for (const texture of this.ownedTextures) texture.dispose()
    this.ownedTextures.length = 0
    this.target?.dispose()
    this.target = null
    this.uniforms.uDeskReflectMap.value = null
    this.ground = null
    this.group = null
    this.renderer = null
    this.scene = null
    this.camera = null
  }
}

/**
 * Cria a mesa. Construir é de graça — nenhuma textura ou alvo de render existe
 * antes do `build()`.
 */
export function createDesk(options: DeskOptions = {}): DeskModule {
  return new StudioDesk(options)
}

/** Instância pronta, para um Engine que só quer registrar o módulo. */
export const deskModule: DeskModule = createDesk()

export default createDesk
