import * as THREE from 'three'

/**
 * Pipeline de vídeo do tubo (SPEC §5; ordem de implementação documentada após o passo 10).
 *
 * Recebe a textura crua do emulador (sinal lógico 272×208 do WebMSX ou
 * 256×192 do renderer procedural, apresentado num canvas 272×240) e devolve
 * uma textura já "vista por trás do vidro": persistência, barril, sangramento
 * de croma NTSC, halação e vinheta. O `CrtMonitorModule` consome o resultado como
 * mapa da tela e aplica brilho/contraste/cantos, scanlines e máscara de fósforo
 * no espaço de tela, onde as derivadas preservam o passo físico desses padrões.
 *
 * São dois passes, e a divisão não é arbitrária:
 *
 *  1. **Fósforo** (na resolução nativa, ~65 kpx): decaimento com realimentação
 *     do frame anterior. Persistência é propriedade do grão de fósforo, não da
 *     imagem ampliada — fazer isso depois da máscara borraria a própria máscara.
 *     Este passe faz ping-pong entre dois alvos.
 *  2. **Tubo** (1536×1152 por padrão): geometria, banda de composto, feixe,
 *     halação, vinheta e a rampa de aquecimento. Escreve sempre no
 *     mesmo alvo, então a textura exposta por {@link CrtProcessor.texture} tem
 *     identidade estável e pode ser plugada uma única vez no material da tela.
 *
 * O alvo final é half-float linear: sobra faixa acima de 1.0 para a halação
 * alimentar o bloom do pós-processamento em vez de estourar em branco chapado.
 */

/** Parâmetros ajustáveis do tubo. */
export interface CrtTuning {
  /**
   * Pincushion residual do jugo de deflexão. **Não** é a curvatura do vidro:
   * essa mora na geometria da face (`CrtMonitor`, `faceSag`). Sobrepor um
   * barril de UV aqui em cima da malha abaulada dobrava a distorção e era o
   * que fazia a borda de baixo "escorrer" cinco vezes mais que a de cima.
   * Valores da ordem de 0.03 = o erro de correção que um aparelho de 1985
   * realmente tinha, simétrico em torno do centro geométrico.
   */
  curvature: number
  /** Persistência do fósforo verde, em segundos (constante de tempo). */
  persistence: number
  /** Sangramento de croma do composto NTSC, 0..1. */
  chroma: number
  /** Dot crawl nas bordas de alto contraste, 0..1. */
  dotCrawl: number
  /**
   * Gama residual do canhão, aplicada ao sinal antes da halação.
   *
   * **Fica em 1,0 e há um motivo forte para isso.** O material da tela agora
   * fecha a cadeia com uma resposta fotográfica explícita — transferência sRGB
   * com ombro — e depois desfaz a AgX do pós-processamento (`SCREEN_TONE` em
   * `CrtMonitor`). Nesse arranjo o sinal *é* a cor de exibição pretendida: um
   * campo de paleta com sinal `srgbToLinear(hex)` sai da tela valendo exatamente
   * `hex`, que é o que a SPEC §5 exige das 15 cores. Qualquer gama aqui desloca
   * a paleta inteira e não há como recuperá-la depois.
   *
   * O parâmetro continua exposto porque é o lugar certo para simular um monitor
   * mal ajustado, mas o padrão correto é 1,0.
   */
  gunGamma: number
  /** Halação: luz espalhada dentro do vidro. */
  halation: number
  /** Vinheta do tubo. */
  vignette: number
  /** Ganho geral do feixe. */
  brightness: number
  /** Ruído de vídeo, bem fino. */
  noise: number
}

export const DEFAULT_CRT_TUNING: Readonly<CrtTuning> = Object.freeze({
  curvature: 0.046,
  persistence: 0.024,
  chroma: 0.55,
  dotCrawl: 0.35,
  gunGamma: 1.0,
  halation: 0.62,
  vignette: 0.06,
  brightness: 1.0,
  noise: 0.01,
})

export interface CrtProcessorOptions {
  /** Largura do alvo de saída. Padrão 1536 (≈3 px por tríade num tubo de 14"). */
  readonly width?: number
  /** Altura do alvo de saída. Padrão 1152 (4:3). */
  readonly height?: number
  /** Resolução nativa da fonte, se a textura ainda não tiver imagem. */
  readonly sourceWidth?: number
  readonly sourceHeight?: number
  readonly tuning?: Partial<CrtTuning>
}

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`

/**
 * Passe 1 — fósforo. `max()` em vez de `mix()`: fósforo decai, não faz média.
 * Assim o rastro só aparece quando algo brilhante apaga; o que está parado
 * continua nítido, sem o borrão de "motion blur" que denuncia um filtro falso.
 */
const PHOSPHOR_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSource;
uniform sampler2D tPrev;
uniform vec3 uDecay;
void main() {
  vec3 incoming = texture2D( tSource, vUv ).rgb;
  vec3 residual = texture2D( tPrev, vUv ).rgb * uDecay;
  gl_FragColor = vec4( max( incoming, residual ), 1.0 );
}
`

/**
 * Passe 3 — média do quadro, num alvo de 1×1.
 *
 * A tela é uma fonte de luz de verdade na cena (SPEC §6, "screen light"), e a
 * cor dessa luz é a cor do que está na tela: um campo azul do MSX derrama azul,
 * uma tela de texto branco derrama branco. Sem esta leitura, o emissor fica
 * preso numa cor de fósforo fixa e o queixo da moldura acaba mais vermelho que
 * azul debaixo de um raster azul — que foi exatamente o que a revisão mediu.
 *
 * 6×6 amostras bastam: é a *cor média* de um quadro de 272×240 que interessa,
 * não a sua estrutura. Guardado em raiz quadrada porque o alvo é de 8 bits.
 */
const AVERAGE_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSource;
void main() {
  vec3 acc = vec3( 0.0 );
  for ( int y = 0; y < 6; y++ ) {
    for ( int x = 0; x < 6; x++ ) {
      vec2 uv = ( vec2( float( x ), float( y ) ) + 0.5 ) / 6.0;
      acc += texture2D( tSource, uv ).rgb;
    }
  }
  gl_FragColor = vec4( sqrt( max( acc / 36.0, 0.0 ) ), 1.0 );
}
`

const TUBE_FRAGMENT = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D tPhosphor;
uniform vec2 uSourceSize;
uniform vec2 uOutputSize;
uniform float uTime;
uniform float uFrame;
uniform float uWarmup;

uniform float uCurvature;
uniform float uChroma;
uniform float uDotCrawl;
uniform float uGunGamma;
uniform float uHalation;
uniform float uVignette;
uniform float uBrightness;
uniform float uNoise;

const float TAU = 6.28318530718;
/** Proporção da face do tubo (4:3). Usada para medir raios em unidades físicas. */
const float CRT_ASPECT = 1.3333333;

// Matrizes YIQ do NTSC (SMPTE 170M). Luma com banda larga, croma com banda
// estreita — é literalmente por isso que a cor "vaza" para os lados num MSX
// ligado no composto.
vec3 rgbToYiq( vec3 c ) {
  return vec3(
    dot( c, vec3( 0.299, 0.587, 0.114 ) ),
    dot( c, vec3( 0.5959, -0.2746, -0.3213 ) ),
    dot( c, vec3( 0.2115, -0.5227, 0.3112 ) )
  );
}

vec3 yiqToRgb( vec3 c ) {
  return vec3(
    c.x + 0.956 * c.y + 0.619 * c.z,
    c.x - 0.272 * c.y - 0.647 * c.z,
    c.x - 1.106 * c.y + 1.703 * c.z
  );
}

/**
 * Erro de correção de pincushion do jugo, **não** a curvatura do vidro (essa é
 * geometria de malha, em CrtMonitor).
 *
 * Radialmente simétrico em torno do centro **geométrico do raster** e medido em
 * unidades físicas da face (por isso o "ASPECT"): a versão anterior trabalhava
 * em UV normalizado, o que faz "r2" crescer 1,78× mais rápido na horizontal que
 * na vertical e produz uma barriga anisotrópica — o tubo lia como um cilindro
 * dobrado no eixo horizontal, não como um bulbo. Normalizado no meio da borda
 * direita para não comer a primeira coluna de caracteres: um MSX de verdade tem
 * borda de sinal para gastar, e a nossa é de 8 px por lado.
 */
vec2 crtWarp( vec2 uv, float k ) {
  vec2 p = ( uv - 0.5 ) * vec2( CRT_ASPECT, 1.0 );
  float r2 = dot( p, p );
  float ref = 0.25 * CRT_ASPECT * CRT_ASPECT;
  float f = ( 1.0 + k * ( r2 + 0.32 * r2 * r2 ) ) / ( 1.0 + k * ( ref + 0.32 * ref * ref ) );
  return 0.5 + p * f / vec2( CRT_ASPECT, 1.0 );
}

/**
 * Amostra travada no *centro do pixel de origem*, nas duas direções.
 *
 * Vertical: cada linha do VDP é um traço discreto do feixe, e borrar entre
 * linhas mata a scanline. Horizontal: era interpolação bilinear, que somava um
 * borrão de meio texel a tudo — é o que fazia a borda de um glifo branco subir
 * em 16 px enquanto a borda de uma caixa gráfica subia em 4. A limitação de
 * banda do composto tem de vir dos filtros de luma/croma abaixo, que são
 * calibrados em MHz, e de nenhum outro lugar.
 */
vec3 sampleLine( vec2 uv, float dx ) {
  vec2 t = ( floor( vec2( uv.x + dx, uv.y ) * uSourceSize ) + 0.5 ) / uSourceSize;
  return texture2D( tPhosphor, t ).rgb;
}

void main() {
  vec2 uv = crtWarp( vUv, uCurvature );

  // Aquecimento: o tubo abre a partir de uma faixa central e o feixe sobe.
  // Nunca liga de estalo (SPEC §8).
  float warm = clamp( uWarmup, 0.0, 1.0 );
  float openAmount = smoothstep( 0.0, 0.42, warm );
  float vScale = mix( 0.045, 1.0, openAmount );
  uv.y = 0.5 + ( uv.y - 0.5 ) / max( vScale, 0.001 );

  // Alta tensão ainda instável enquanto aquece: leve tremor horizontal.
  float instability = ( 1.0 - smoothstep( 0.25, 0.85, warm ) ) * 0.0022;
  uv.x += sin( uTime * 41.0 + uv.y * 27.0 ) * instability;

  float inside = step( 0.0, uv.x ) * step( uv.x, 1.0 ) * step( 0.0, uv.y ) * step( uv.y, 1.0 );
  if ( inside < 0.5 ) {
    // Fora da área varrida: fósforo apagado, sem clarão de borda.
    gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
    return;
  }

  float texel = 1.0 / uSourceSize.x;

  // --- 1. Composto NTSC: luma banda larga, croma banda estreita -------------
  vec3 yiqCentre = rgbToYiq( sampleLine( uv, 0.0 ) );
  vec3 chromaAcc = vec3( 0.0 );
  float wsum = 0.0;
  // Passa-baixa de croma **assimétrica**: o núcleo é centrado 1,4 texel à
  // direita. Um FIR simétrico produz um halo igual dos dois lados — que é o que
  // faz o efeito ler como "borrão tingido" em vez de composto. O atraso de
  // grupo do demodulador de croma real arrasta a cor para a direita da borda,
  // e é esse rastro (2–4 px) que se vê num MSX ligado no vídeo composto.
  for ( int i = -6; i <= 3; i++ ) {
    float fi = float( i ) + 1.4;
    float w = exp( -fi * fi / 9.0 );
    chromaAcc += rgbToYiq( sampleLine( uv, float( i ) * texel ) ) * w;
    wsum += w;
  }
  chromaAcc /= wsum;

  vec3 yiq = vec3( yiqCentre.x, mix( yiqCentre.yz, chromaAcc.yz, uChroma ) );

  // 3,58 MHz de banda não passam um degrau perfeito: luma levemente suavizada.
  float lumaSoft = ( rgbToYiq( sampleLine( uv, -texel * 0.5 ) ).x
    + rgbToYiq( sampleLine( uv, texel * 0.5 ) ).x ) * 0.5;
  yiq.x = mix( yiq.x, lumaSoft, 0.28 );

  // Dot crawl: resíduo da subportadora que o filtro não separou. Só aparece
  // onde há gradiente forte de luma, exatamente como num MSX de verdade.
  float grad = abs( sampleLine( uv, texel ).g - sampleLine( uv, -texel ).g );
  float phase = TAU * ( uv.x * uSourceSize.x * 0.5
    + floor( uv.y * uSourceSize.y ) * 0.5 + uFrame * 0.5 );
  yiq.yz += sin( phase + vec2( 0.0, 1.5707963 ) ) * grad * uDotCrawl * 0.16;

  vec3 colour = max( yiqToRgb( yiq ), 0.0 );

  // Transferência do canhão. Antes da halação, porque a halação espalha a luz
  // *emitida* — inverter a ordem borraria o sinal e depois o curvaria, o que
  // engorda o glifo e some com a separação que a gama acabou de criar.
  colour = pow( colour, vec3( uGunGamma ) );

  // --- 2. Halação em duas escalas -------------------------------------------
  // O nível de preto de um TRC **não** é um offset somado: é luz de verdade,
  // espalhada dentro do faceplate. Por isso são duas escalas — um halo curto,
  // que engorda o glifo, e uma cauda muito larga e fraca, que é o que levanta o
  // interior de uma caixa preta cercada de azul e dá a ela um viés de cor. A
  // cauda longa é o que vende o vidro; sem ela sobra um cinza chapado.
  // O halo curto é **anisotrópico**: 1 px de fósforo tem ~3,5× mais largura que
  // altura no quadro de 272×240 esticado para 4:3, e o feixe corre na
  // horizontal. Um anel isotrópico em espaço de texel produz um halo redondo
  // igual dos quatro lados — a assinatura de um blur tingido, não de halação.
  vec2 halTexel = 1.0 / uSourceSize;
  vec2 nearAspect = vec2( 1.55, 0.85 );
  vec3 near = vec3( 0.0 );
  vec3 wide = vec3( 0.0 );
  for ( int i = 0; i < 8; i++ ) {
    float a = TAU * ( float( i ) + 0.5 ) / 8.0;
    vec2 dir = vec2( cos( a ), sin( a ) );
    near += texture2D( tPhosphor, uv + dir * nearAspect * halTexel * 2.0 ).rgb * 0.62;
    near += texture2D( tPhosphor, uv + dir * nearAspect * halTexel * 5.0 ).rgb * 0.38;
    // Cauda longa: dois anéis bem afastados, girados meia fase entre si para
    // não deixar o octógono aparecer. Esta é a luz espalhada *dentro do vidro*,
    // que é isotrópica de verdade — só o halo curto segue o feixe.
    vec2 dirB = vec2( cos( a + 0.3927 ), sin( a + 0.3927 ) );
    wide += texture2D( tPhosphor, uv + dirB * halTexel * 13.0 ).rgb;
    wide += texture2D( tPhosphor, uv + dir * halTexel * 30.0 ).rgb;
  }
  near /= 8.0;
  wide /= 16.0;
  float nearLuma = dot( near, vec3( 0.299, 0.587, 0.114 ) );
  // O halo curto é super-linear (só glifo branco engorda de verdade); a cauda
  // larga é linear, porque um campo azul inteiro também espalha.
  colour += near * vec3( 1.0, 0.95, 0.88 ) * nearLuma * uHalation * 0.95;
  // A cauda longa é **fraca**. Ela existe para dar viés de cor ao preto cercado
  // de azul, não para levantar a tela inteira: com peso alto, um campo azul de
  // tela cheia espalha em si mesmo e o tubo vira um painel leitoso onde texto
  // branco e fundo ficam a um passo de distância. 0,04 é o limite onde ainda se
  // enxerga o efeito no interior de uma caixa preta sem lavar o resto.
  colour += wide * vec3( 0.86, 0.92, 1.0 ) * uHalation * 0.04;

  // --- 3. Vinheta + queda de eficiência nas quinas --------------------------
  vec2 vc = vUv - 0.5;
  float r2 = dot( vc, vc );
  colour *= 1.0 - uVignette * r2 * ( 1.1 + 0.9 * r2 );

  // --- 4. Ruído de vídeo, bem fino ------------------------------------------
  // Só o ruído do *sinal*. O grão do fósforo é por pixel de tela e mora no
  // material da tela — aqui ele seria borrado pelo mipmap do alvo.
  float n = fract( sin( dot( vUv * uOutputSize + uTime * 60.0, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  colour *= 1.0 + ( n - 0.5 ) * uNoise;

  // --- 5. Rampa de aquecimento ----------------------------------------------
  // O filamento esquenta antes de o brilho estabilizar: o ganho sobe rápido,
  // passa um pouco do ponto no meio da rampa e a cor sai do azulado.
  float gain = pow( warm, 0.75 );
  float overshoot = 1.0 + 0.22 * exp( -pow( ( warm - 0.55 ) * 4.5, 2.0 ) );
  colour *= gain * overshoot * uBrightness;
  colour *= mix( vec3( 0.72, 0.82, 1.15 ), vec3( 1.0 ), smoothstep( 0.1, 0.8, warm ) );
  // Traço incandescente no instante em que a faixa central abre.
  colour += vec3( 0.35, 0.36, 0.42 ) * ( 1.0 - openAmount ) * gain
    * exp( -pow( ( vUv.y - 0.5 ) * 46.0, 2.0 ) );

  gl_FragColor = vec4( colour, 1.0 );
}
`

function makeTarget(
  width: number,
  height: number,
  name: string,
  mipmapped: boolean,
): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: mipmapped ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: mipmapped,
  })
  if (mipmapped) {
    // Na cena a tela sempre aparece menor que o alvo, e uma grade de máscara
    // sem mipmap bate contra a grade do monitor do usuário: moiré em anéis,
    // que denuncia shader na hora. Mipmap + anisotropia resolvem, e de quebra
    // reproduzem o certo: um tubo visto de longe não mostra as tríades.
    target.texture.anisotropy = 8
  }
  // Tudo aqui é linear e sai linear: o material da tela do monitor é
  // `MeshBasicMaterial`, que converte o mapa para o espaço de trabalho. Marcar
  // como sRGB aplicaria uma segunda transferência e lavaria a imagem.
  target.texture.colorSpace = THREE.LinearSRGBColorSpace
  target.texture.wrapS = THREE.ClampToEdgeWrapping
  target.texture.wrapT = THREE.ClampToEdgeWrapping
  target.texture.name = name
  return target
}

function readImageSize(texture: THREE.Texture): { width: number; height: number } | null {
  const image: unknown = texture.image
  if (typeof image !== 'object' || image === null) return null
  const candidate = image as { width?: unknown; height?: unknown }
  if (typeof candidate.width !== 'number' || typeof candidate.height !== 'number') return null
  if (candidate.width <= 0 || candidate.height <= 0) return null
  return { width: candidate.width, height: candidate.height }
}

function normalizeTargetSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(Number.isFinite(width) ? width : 1)),
    height: Math.max(1, Math.round(Number.isFinite(height) ? height : 1)),
  }
}

/** Rampa de aquecimento do tubo, dirigida pela energia do ScreenPipeline. */
export class CrtWarmup {
  private value = 0
  private target = 0

  /** Constante de tempo da subida; a descida é bem mais rápida, como no vidro. */
  public constructor(
    private readonly riseTau = 0.5,
    private readonly fallTau = 0.14,
  ) {}

  public powerOn(): void {
    this.target = 1
  }

  public powerOff(): void {
    this.target = 0
  }

  public update(dt: number): number {
    const tau = this.target > this.value ? this.riseTau : this.fallTau
    const k = 1 - Math.exp(-Math.max(dt, 0) / Math.max(tau, 1e-3))
    this.value += (this.target - this.value) * k
    if (this.target === 0 && this.value < 0.002) this.value = 0
    if (this.target === 1 && this.value > 0.998) this.value = 1
    return this.value
  }
}

/** Passe de tubo fora de tela, com realimentação de fósforo. */
export class CrtProcessor {
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1)
  private readonly geometry = new THREE.PlaneGeometry(2, 2)
  private readonly quad: THREE.Mesh
  private readonly phosphorMaterial: THREE.ShaderMaterial
  private readonly tubeMaterial: THREE.ShaderMaterial
  private readonly tuning: CrtTuning

  private readonly phosphorUniforms: {
    tSource: { value: THREE.Texture | null }
    tPrev: { value: THREE.Texture | null }
    uDecay: { value: THREE.Vector3 }
  }

  private readonly tubeUniforms: {
    tPhosphor: { value: THREE.Texture | null }
    uSourceSize: { value: THREE.Vector2 }
    uOutputSize: { value: THREE.Vector2 }
    uTime: { value: number }
    uFrame: { value: number }
    uWarmup: { value: number }
    uCurvature: { value: number }
    uChroma: { value: number }
    uDotCrawl: { value: number }
    uGunGamma: { value: number }
    uHalation: { value: number }
    uVignette: { value: number }
    uBrightness: { value: number }
    uNoise: { value: number }
  }

  private phosphorFront: THREE.WebGLRenderTarget
  private phosphorBack: THREE.WebGLRenderTarget
  private readonly tubeTarget: THREE.WebGLRenderTarget
  private readonly averageTarget: THREE.WebGLRenderTarget
  private readonly averageMaterial: THREE.ShaderMaterial
  private readonly averageUniforms: { tSource: { value: THREE.Texture | null } }
  private readonly averagePixels = new Uint8Array(4)
  private readonly averageColour = { r: 0, g: 0, b: 0 }
  private averagePending = false
  private elapsed = 0
  private frame = 0
  private outputWidth: number
  private outputHeight: number
  private primed = false
  private disposed = false

  public constructor(source: THREE.Texture, options: CrtProcessorOptions = {}) {
    const output = normalizeTargetSize(options.width ?? 1536, options.height ?? 1152)
    const width = output.width
    const height = output.height
    this.outputWidth = width
    this.outputHeight = height
    this.tuning = { ...DEFAULT_CRT_TUNING, ...options.tuning }

    const measured = readImageSize(source)
    const sourceWidth = options.sourceWidth ?? measured?.width ?? 272
    const sourceHeight = options.sourceHeight ?? measured?.height ?? 240

    this.phosphorFront = makeTarget(sourceWidth, sourceHeight, 'crt-fosforo-a', false)
    this.phosphorBack = makeTarget(sourceWidth, sourceHeight, 'crt-fosforo-b', false)
    this.tubeTarget = makeTarget(width, height, 'crt-tubo', true)

    this.phosphorUniforms = {
      tSource: { value: source },
      tPrev: { value: this.phosphorBack.texture },
      uDecay: { value: new THREE.Vector3(0, 0, 0) },
    }

    this.tubeUniforms = {
      tPhosphor: { value: this.phosphorFront.texture },
      uSourceSize: { value: new THREE.Vector2(sourceWidth, sourceHeight) },
      uOutputSize: { value: new THREE.Vector2(width, height) },
      uTime: { value: 0 },
      uFrame: { value: 0 },
      uWarmup: { value: 0 },
      uCurvature: { value: this.tuning.curvature },
      uChroma: { value: this.tuning.chroma },
      uDotCrawl: { value: this.tuning.dotCrawl },
      uGunGamma: { value: this.tuning.gunGamma },
      uHalation: { value: this.tuning.halation },
      uVignette: { value: this.tuning.vignette },
      uBrightness: { value: this.tuning.brightness },
      uNoise: { value: this.tuning.noise },
    }

    this.phosphorMaterial = new THREE.ShaderMaterial({
      name: 'crt-fosforo',
      uniforms: this.phosphorUniforms,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: PHOSPHOR_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })

    // Alvo de 1×1 em bytes: é lido de volta para a CPU, e half-float exigiria
    // conversão manual de meia precisão sem ganho nenhum para uma cor de luz.
    this.averageTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    })
    this.averageTarget.texture.name = 'crt-media'
    this.averageUniforms = { tSource: { value: this.phosphorFront.texture } }
    this.averageMaterial = new THREE.ShaderMaterial({
      name: 'crt-media',
      uniforms: this.averageUniforms,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: AVERAGE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })

    this.tubeMaterial = new THREE.ShaderMaterial({
      name: 'crt-tubo',
      uniforms: this.tubeUniforms,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: TUBE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })

    this.quad = new THREE.Mesh(this.geometry, this.phosphorMaterial)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)

    this.publishSourceSize(sourceWidth, sourceHeight)
    applySourceFiltering(source)
  }

  /**
   * Carimba a resolução do sinal na textura de saída.
   *
   * O material da tela do monitor desenha as linhas de varredura e precisa saber
   * quantas existem, mas só recebe o alvo já ampliado (1536×1152) — a contagem
   * de linhas se perde no caminho. Publicar aqui mantém as duas camadas
   * desacopladas: quem consome lê `texture.userData` se quiser, e continua
   * funcionando se não ler. Sem isso, trocar o procedural (192 linhas) pelo
   * WebMSX (240) deixaria a grade de varredura batendo contra as linhas de
   * pixel da fonte — o moiré clássico de shader de CRT mal calibrado.
   */
  private publishSourceSize(width: number, height: number): void {
    const data = this.tubeTarget.texture.userData as Record<string, unknown>
    data['crtSourceWidth'] = width
    data['crtSourceHeight'] = height
    // Referência **estável** para a cor média: quem consome a textura lê este
    // objeto uma vez e vê o valor mudar sozinho. É como o monitor descobre de
    // que cor é a luz que a tela derrama sem conhecer o processador.
    data['crtFrameAverage'] = this.averageColour
  }

  /**
   * Textura processada, pronta para virar o mapa da tela do monitor. A
   * identidade é estável durante toda a vida do objeto — pode ser plugada uma
   * vez só, no boot.
   */
  public get texture(): THREE.Texture {
    return this.tubeTarget.texture
  }

  /** Resolução nativa da fonte em uso. */
  public get sourceSize(): THREE.Vector2 {
    return this.tubeUniforms.uSourceSize.value
  }

  /** Troca a fonte — por exemplo, WebMSX assumindo o lugar do procedural. */
  public setSource(source: THREE.Texture, width?: number, height?: number): void {
    if (this.disposed) return
    this.phosphorUniforms.tSource.value = source
    applySourceFiltering(source)

    const measured = readImageSize(source)
    const w = width ?? measured?.width
    const h = height ?? measured?.height
    if (w === undefined || h === undefined) return
    if (w === this.tubeUniforms.uSourceSize.value.x && h === this.tubeUniforms.uSourceSize.value.y) {
      return
    }
    this.tubeUniforms.uSourceSize.value.set(w, h)
    this.phosphorFront.setSize(w, h)
    this.phosphorBack.setSize(w, h)
    this.publishSourceSize(w, h)
    this.primed = false
  }

  /**
   * Cor média do quadro (linear, 0..1), atualizada a cada ~6 frames.
   *
   * É o que a tela derrama na cena: o consumidor multiplica isso pela potência
   * do emissor. Vale `{0,0,0}` até a primeira leitura voltar — a luz então sobe
   * junto com a rampa de aquecimento, o que é o comportamento certo.
   */
  public get frameAverage(): { readonly r: number; readonly g: number; readonly b: number } {
    return this.averageColour
  }

  /**
   * Leitura assíncrona do alvo de 1×1. `readRenderTargetPixelsAsync` usa um PBO
   * no WebGL2, então não trava o pipeline; a versão síncrona custaria um flush
   * por chamada. Se o navegador não expuser a variante assíncrona, a cor
   * simplesmente não atualiza — a cena continua, só sem rastrear conteúdo.
   */
  private requestAverage(renderer: THREE.WebGLRenderer): void {
    if (this.averagePending) return
    const read: unknown = (renderer as { readRenderTargetPixelsAsync?: unknown })
      .readRenderTargetPixelsAsync
    if (typeof read !== 'function') return
    this.averagePending = true
    void renderer
      .readRenderTargetPixelsAsync(this.averageTarget, 0, 0, 1, 1, this.averagePixels)
      .then(() => {
        // Desfaz a raiz quadrada do passe de média.
        const r = (this.averagePixels[0] ?? 0) / 255
        const g = (this.averagePixels[1] ?? 0) / 255
        const b = (this.averagePixels[2] ?? 0) / 255
        this.averageColour.r = r * r
        this.averageColour.g = g * g
        this.averageColour.b = b * b
      })
      .catch(() => {
        /* alvo destruído no meio da leitura: nada a fazer. */
      })
      .finally(() => {
        this.averagePending = false
      })
  }

  /** Rampa de aquecimento 0→1, dirigida pela sequência de energia. */
  public setWarmup(value: number): void {
    this.tubeUniforms.uWarmup.value = Math.min(1, Math.max(0, value))
  }

  public getTuning(): Readonly<CrtTuning> {
    return this.tuning
  }

  public setTuning(patch: Partial<CrtTuning>): void {
    Object.assign(this.tuning, patch)
    this.tubeUniforms.uCurvature.value = this.tuning.curvature
    this.tubeUniforms.uChroma.value = this.tuning.chroma
    this.tubeUniforms.uDotCrawl.value = this.tuning.dotCrawl
    this.tubeUniforms.uGunGamma.value = this.tuning.gunGamma
    this.tubeUniforms.uHalation.value = this.tuning.halation
    this.tubeUniforms.uVignette.value = this.tuning.vignette
    this.tubeUniforms.uBrightness.value = this.tuning.brightness
    this.tubeUniforms.uNoise.value = this.tuning.noise
  }

  /** Redimensiona só o alvo de saída (o de fósforo segue a fonte). */
  public setSize(width: number, height: number): boolean {
    if (this.disposed) return false
    const output = normalizeTargetSize(width, height)
    if (output.width === this.outputWidth && output.height === this.outputHeight) return false
    this.outputWidth = output.width
    this.outputHeight = output.height
    this.tubeTarget.setSize(output.width, output.height)
    this.tubeUniforms.uOutputSize.value.set(output.width, output.height)
    return true
  }

  /**
   * Roda os dois passes. Deve ser chamado antes do render principal da cena,
   * com o mesmo `dt` do laço — a persistência depende do tempo decorrido de
   * verdade, não da contagem de frames.
   */
  public render(renderer: THREE.WebGLRenderer, dt: number): void {
    if (this.disposed) return
    const step = Math.min(Math.max(dt, 1 / 480), 1 / 15)
    this.elapsed += step
    this.frame += 1

    // P22: o verde persiste mais que o vermelho, e o azul apaga primeiro.
    const tau = Math.max(this.tuning.persistence, 1e-4)
    const decay = this.primed ? 1 : 0
    this.phosphorUniforms.uDecay.value.set(
      Math.exp(-step / (tau * 0.62)) * decay,
      Math.exp(-step / tau) * decay,
      Math.exp(-step / (tau * 0.45)) * decay,
    )
    this.phosphorUniforms.tPrev.value = this.phosphorBack.texture

    this.tubeUniforms.uTime.value = this.elapsed
    this.tubeUniforms.uFrame.value = this.frame % 2

    const previousTarget = renderer.getRenderTarget()
    const previousCubeFace = renderer.getActiveCubeFace()
    const previousMipLevel = renderer.getActiveMipmapLevel()
    const sampleAverage = this.frame % 6 === 0

    try {
      // Passe 1 — fósforo, na resolução nativa.
      this.quad.material = this.phosphorMaterial
      renderer.setRenderTarget(this.phosphorFront)
      renderer.render(this.scene, this.camera)

      // Passe 2 — tubo, no alvo estável.
      this.tubeUniforms.tPhosphor.value = this.phosphorFront.texture
      this.quad.material = this.tubeMaterial
      renderer.setRenderTarget(this.tubeTarget)
      renderer.render(this.scene, this.camera)

      // Passe 3 — média do quadro, a cada 6 frames. É 1 pixel: o custo é a
      // sincronização da leitura, e por isso ela é assíncrona e nunca reentrante.
      if (sampleAverage) {
        this.averageUniforms.tSource.value = this.phosphorFront.texture
        this.quad.material = this.averageMaterial
        renderer.setRenderTarget(this.averageTarget)
        renderer.render(this.scene, this.camera)
      }

      // Ping-pong: o que acabou de sair vira o resíduo da próxima volta.
      const swap = this.phosphorFront
      this.phosphorFront = this.phosphorBack
      this.phosphorBack = swap
      this.primed = true
    } finally {
      // Uma falha de upload/render nunca pode deixar o Engine desenhando no
      // alvo interno do tubo.
      renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipLevel)
    }
    if (sampleAverage) this.requestAverage(renderer)
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scene.remove(this.quad)
    this.geometry.dispose()
    this.phosphorMaterial.dispose()
    this.tubeMaterial.dispose()
    this.averageMaterial.dispose()
    this.phosphorFront.dispose()
    this.phosphorBack.dispose()
    this.tubeTarget.dispose()
    this.averageTarget.dispose()
  }
}

/**
 * A fonte precisa ser linear e sem mipmap: o shader trava a coordenada no
 * centro da linha de varredura, então a interpolação bilinear passa a ser
 * exatamente a limitação de banda horizontal do composto — e nada mais.
 */
function applySourceFiltering(source: THREE.Texture): void {
  // Defensivo: este módulo é varrido por camadas que instanciam exports às
  // cegas para descobrir fontes de vídeo. Se algo que não é textura chegar
  // aqui, não saímos escrevendo propriedades no objeto dos outros.
  if (source === null || typeof source !== 'object' || source.isTexture !== true) return
  source.minFilter = THREE.LinearFilter
  source.magFilter = THREE.LinearFilter
  source.generateMipmaps = false
  source.wrapS = THREE.ClampToEdgeWrapping
  source.wrapT = THREE.ClampToEdgeWrapping
  source.needsUpdate = true
}
