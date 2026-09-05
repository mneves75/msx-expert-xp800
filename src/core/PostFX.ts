import { HalfFloatType, NoToneMapping, Uniform, Vector3, WebGLRenderTarget } from 'three'

import { yieldToMain } from './cooperative'
import type { PerspectiveCamera, Scene, ToneMapping, WebGLRenderer } from 'three'
import type { Pass } from 'postprocessing'
import {
  BlendFunction,
  BloomEffect,
  DepthOfFieldEffect,
  EdgeDetectionMode,
  Effect,
  EffectComposer,
  EffectPass,
  FXAAEffect,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  VignetteTechnique,
} from 'postprocessing'
// n8ao@2.0.0 publishes JSDoc but no TypeScript declarations.
// @ts-expect-error The typed boundary immediately below mirrors its published API.
import { N8AOPostPass as UntypedN8AOPostPass } from 'n8ao'

/**
 * Post-processing chain for the XP-800 scene (SPEC §7).
 *
 * Chain, in render order:
 *
 *   RenderPass                                   HDR scene, half-float, MSAA on `high`
 *   N8AOPostPass                                 depth-only occlusion, still HDR
 *   EffectPass[ Bloom ]                          screen/specular glow, still HDR
 *   EffectPass[ DepthOfField ]                   f/5.6-grade defocus, machine stays sharp
 *   EffectPass[ ChromaticAberration, FilmGrain,
 *               Vignette, ToneMapping ]          lens + sensor artefacts, then AgX
 *   EffectPass[ SMAA ]                           morphological AA on the tone-mapped image
 *
 * Two deliberate ordering choices recorded in §7, both in service of the quality bar:
 *
 *  1. **SMAA runs last, not first.** SMAA is a morphological filter: it reads a
 *     finished image and reconstructs edges from colour discontinuities. Fed the raw
 *     HDR buffer (where the CRT sits at radiance 4–8 and the graphite case at ~0.1) its
 *     edge detection saturates on the screen and misses everything else. §7's "TAA or
 *     SMAA" first-in-chain placement is correct for TAA — a temporal resolve of a
 *     jittered render — and wrong for SMAA. Geometric aliasing is instead handled up
 *     front by real MSAA on the composer's input buffer, which is strictly better than
 *     SMAA at that stage; SMAA then cleans up shader/specular/normal-map aliasing that
 *     MSAA cannot see. `edgeDetectionThreshold` is lowered from the 0.1 default because
 *     the buffer SMAA reads is still linear-light, which compresses dark-on-dark
 *     contrast — and this scene is a dark machine against a dark void.
 *
 *  2. **Depth-only AO precedes Bloom.** N8AO reconstructs normals from the RenderPass
 *     depth texture, avoiding a second scene submission. It modulates raw HDR radiance
 *     before Bloom and the AgX tone curve, which is where physical occlusion belongs.
 *
 * Tone mapping is owned by `ToneMappingEffect` (AgX), so `createPostFX` forces
 * `renderer.toneMapping = NoToneMapping`. Never re-enable renderer-side tone mapping:
 * it would apply the curve twice. Exposure still works — `renderer.toneMappingExposure`
 * feeds the `toneMappingExposure` uniform that three's AgX chunk reads — and is exposed
 * here as {@link PostFX.setExposure}.
 *
 * Restraint is the rule (SPEC §7): every default below is deliberately under-driven.
 * If an effect can be named by a viewer it is too strong. All handles are public so the
 * critic loop can push values and see the render change without touching this file.
 */

export type PostFXQuality = 'low' | 'high'

interface N8AOConfiguration {
  aoSamples: number
  aoRadius: number
  denoiseSamples: number
  denoiseRadius: number
  distanceFalloff: number
  intensity: number
  gammaCorrection: boolean
  screenSpaceRadius: boolean
  halfRes: boolean
  depthAwareUpsampling: boolean
  transparencyAware: boolean
}

interface N8AOPostPassHandle extends Pass {
  readonly configuration: N8AOConfiguration
}

const N8AOPostPass = UntypedN8AOPostPass as unknown as new (
  scene: Scene,
  camera: PerspectiveCamera,
  width?: number,
  height?: number,
) => N8AOPostPassHandle

/** Individual effect handles, exposed for tuning during the critic loop. */
export interface PostFXEffects {
  readonly smaa: SMAAEffect | null
  readonly antialias: SMAAEffect | FXAAEffect
  readonly bloom: BloomEffect
  readonly depthOfField: DepthOfFieldEffect
  readonly chromaticAberration: RadialChromaticAberrationEffect
  readonly filmGrain: NoiseEffect
  readonly vignette: VignetteEffect
  readonly toneMapping: ToneMappingEffect
}

/** Pass handles, exposed so the engine can toggle stages (wireframe/X-ray modes). */
export interface PostFXPasses {
  readonly render: RenderPass
  readonly ao: N8AOPostPassHandle
  readonly bloom: EffectPass
  readonly depthOfField: EffectPass
  readonly lensAndTone: EffectPass
  readonly antialias: EffectPass
}

export interface PostFX {
  readonly composer: EffectComposer
  readonly effects: PostFXEffects
  readonly passes: PostFXPasses
  /** Current quality tier. */
  readonly quality: PostFXQuality
  /** Renders one frame. `deltaTime` in seconds; drives the film-grain animation. */
  render(deltaTime?: number): void
  /**
   * Resizes every buffer, pass and the renderer itself — do NOT also call
   * `renderer.setSize`. Dimensions are CSS pixels; the composer allocates its targets at
   * the drawing-buffer size, so `renderer.setPixelRatio` is honoured automatically.
   */
  setSize(width: number, height: number): void
  /**
   * Switch the perf tier (SPEC §10). NÃO é grátis: mudar `multisampling` realoca o
   * buffer de entrada do composer (hitch de um quadro) — chamar por transição de
   * tier, nunca por quadro.
   */
  setQuality(quality: PostFXQuality): void
  /** Enables or disables the single ambient-occlusion pass. */
  setAOEnabled(on: boolean): void
  /**
   * World-space point the depth of field focuses on. `null` freezes the focus at the
   * current distance. Defaults to the centre of the main unit.
   */
  setFocusTarget(target: Vector3 | null): void
  /** Photographic exposure applied by the AgX curve. 1.0 is neutral. */
  setExposure(exposure: number): void
  /**
   * Re-derives the camera-dependent DoF settings. Call after changing the camera.
   */
  syncCamera(): void
  dispose(): void
}

interface QualityProfile {
  /** MSAA sample count on the composer's input buffer. */
  readonly multisampling: number
  readonly ao: boolean
  readonly aoSamples: number
  /** World-space AO radius in metres (SPEC: centimetre-scale). */
  readonly aoRadius: number
  readonly aoDenoiseSamples: number
  readonly aoDenoiseRadius: number
  readonly aoHalfResolution: boolean
  readonly aoIntensity: number
  readonly bloomLevels: number
  readonly depthOfField: boolean
  readonly bokehScale: number
  readonly dofResolutionScale: number
  readonly smaaPreset: SMAAPreset
  readonly smaaEdgeThreshold: number
  readonly chromaticAberration: number
  readonly grainOpacity: number
}

/**
 * True radial (lateral) chromatic aberration.
 *
 * `ChromaticAberrationEffect` from the library shifts R and B along a *fixed* vector —
 * `vUvR = uv + offset` — so the fringe has the same colour and the same direction along
 * every edge in the frame, including edges at the optical centre where a real lens has
 * exactly zero aberration. That reads as a shader bug, and SPEC §7's rule is that a
 * nameable effect is a failed effect.
 *
 * Real lateral CA is a *magnification* difference between wavelengths: the displacement
 * points radially outward and grows with the field angle, roughly as r². This is that,
 * budgeted so the red/blue separation is 0 at the centre and ≈0.6 px at the corner of a
 * 1920-wide frame — under the resolving limit of the eye at 100 % zoom, which is exactly
 * where a good prime lens sits.
 */
const RADIAL_CA_FRAGMENT = /* glsl */ `
uniform float scale;

void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
  vec2 fromCentre = uv - vec2( 0.5 );
  // r2 = 1 at the edge midpoints, 2 in the corners.
  float r2 = dot( fromCentre, fromCentre ) * 4.0;
  vec2 shift = fromCentre * ( r2 * scale );
  float r = texture2D( inputBuffer, uv + shift ).r;
  float b = texture2D( inputBuffer, uv - shift ).b;
  outputColor = vec4( r, inputColor.g, b, inputColor.a );
}
`

export class RadialChromaticAberrationEffect extends Effect {
  public constructor(scale: number) {
    super('RadialChromaticAberrationEffect', RADIAL_CA_FRAGMENT, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform<number>>([['scale', new Uniform(scale)]]),
    })
  }

  /** Corner displacement as a fraction of frame width. 0 disables the effect. */
  public get scale(): number {
    const uniform = this.uniforms.get('scale')
    return typeof uniform?.value === 'number' ? uniform.value : 0
  }

  public set scale(value: number) {
    const uniform = this.uniforms.get('scale')
    if (uniform !== undefined) uniform.value = value
  }
}

/**
 * Scene scale is metres (SPEC §1): the main unit is 0.400 m wide and the camera sits
 * roughly 0.5–1.5 m out. Every world-space number below is in that frame of reference.
 *
 * The autofocus target is the **front fascia**, not the geometric centre: that is where
 * a photographer would put the plane of focus on a 0.4 m subject, and it keeps the
 * badge, the POWER legend and the slot lips — the highest-frequency detail in the frame
 * — dead sharp.
 */
const MACHINE_CENTRE = new Vector3(0, 0.05, 0.12)

const QUALITY_PROFILES: Record<PostFXQuality, QualityProfile> = {
  high: {
    multisampling: 4,
    ao: true,
    aoSamples: 12,
    aoDenoiseSamples: 7,
    aoDenoiseRadius: 12,
    aoHalfResolution: false,
    // 5 mm in world space at the subject. Deliberately
    // *tighter* than a general-purpose AO radius: this term exists for the seams, the
    // vent slots, the shell-overhang line and the last few millimetres before an object
    // meets the desk. A wide radius produces the soft grey wash that made everything in
    // the previous pass look like it was hovering.
    aoRadius: 0.005,
    aoIntensity: 1.9,
    bloomLevels: 8,
    depthOfField: true,
    // A revisão do tubo mediu que nada no macro estava em foco e que a borda de
    // um glifo levava 16 px para subir enquanto a de uma caixa gráfica levava 4.
    // Metade disso vinha do bokeh calculado a meia resolução: o passe de Kawase
    // roda no buffer reduzido e volta interpolado, então mesmo com círculo de
    // confusão perto de zero sobra um assentamento de ~2 px em todo o quadro. A
    // resolução plena custa um buffer e devolve a estrutura de fósforo.
    bokehScale: 0.3,
    dofResolutionScale: 1,
    smaaPreset: SMAAPreset.ULTRA,
    smaaEdgeThreshold: 0.03,
    chromaticAberration: 0.00016,
    grainOpacity: 0.038,
  },
  low: {
    multisampling: 0,
    ao: true,
    aoSamples: 6,
    aoDenoiseSamples: 5,
    aoDenoiseRadius: 12,
    aoHalfResolution: true,
    // Half-resolution AO needs a slightly wider kernel or it turns to noise.
    aoRadius: 0.007,
    aoIntensity: 1.7,
    bloomLevels: 5,
    depthOfField: false,
    bokehScale: 0.4,
    dofResolutionScale: 0.35,
    smaaPreset: SMAAPreset.LOW,
    smaaEdgeThreshold: 0.06,
    chromaticAberration: 0.00012,
    grainOpacity: 0.03,
  },
}

/**
 * Depth of field at a *product-photography* aperture, in metres.
 *
 * A 0.4 m subject on a 100 mm macro is shot at f/11–f/16 precisely so the whole product
 * stays sharp; the background is thrown out by distance, not by a shallow plane. 0.9 m
 * of range around the fascia puts the console, the keyboard 0.25 m in front of it and
 * the CRT 0.35 m behind it *all* inside the sharp zone, and only the far void and the
 * extreme near desk edge soften. If the keyboard legends go soft, this is too small.
 */
const DOF_FOCUS_RANGE = 0.9

/**
 * Seed focus distance, in metres. Only ever used for the frame before autofocus first
 * runs — `depthOfField.target` re-derives the real distance from the camera every frame.
 */
const DOF_SEED_FOCUS_DISTANCE = 0.75

/**
 * O `EffectComposer` clona o buffer de entrada para montar o ping-pong, então o MSAA
 * pedido para o RenderPass acaba TAMBÉM no buffer de saída — e a partir daí todo
 * passe de tela cheia que escreve nele paga alocação multisample e um resolve quando
 * o passe seguinte lê. Um quad de tela cheia produz amostras idênticas por
 * construção, logo esse resolve é a identidade: zerar as amostras do buffer de
 * saída é **bit-idêntico** e corta metade dos resolves por quadro. (No ANGLE o
 * resolve de um alvo half-float custa banda de verdade — em D3D11/iGPU mais ainda.)
 * A lib não expõe o ajuste e o setter `multisampling` o desfaz; re-aplicar depois de
 * toda escrita nele (construção e `applyProfile`).
 */
function stripOutputBufferMultisampling(composer: EffectComposer): void {
  const target = (composer as unknown as { outputBuffer?: unknown }).outputBuffer
  if (!(target instanceof WebGLRenderTarget) || target.samples === 0) return
  target.samples = 0
  // Libera o armazenamento multisample já alocado; o three recria o FBO sem MSAA no
  // próximo bind, com os mesmos parâmetros de textura.
  target.dispose()
}

function clampMultisampling(renderer: WebGLRenderer, requested: number): number {
  if (requested <= 0) {
    return 0
  }
  const maxSamples = renderer.capabilities.maxSamples
  return Math.max(0, Math.min(requested, maxSamples))
}

function disposeSMAALookupTextures(smaa: SMAAEffect): void {
  const material = smaa.weightsMaterial as unknown as {
    searchTexture?: { dispose(): void } | null
    areaTexture?: { dispose(): void } | null
  }
  material.searchTexture?.dispose()
  material.areaTexture?.dispose()
}

function disposeFailedSMAA(smaa: SMAAEffect): void {
  const events = smaa as unknown as {
    addEventListener(type: 'load', listener: () => void): void
  }
  events.addEventListener('load', () => {
    disposeSMAALookupTextures(smaa)
  })
  disposeSMAALookupTextures(smaa)
  smaa.dispose()
}

function probeSMAA(renderer: WebGLRenderer, smaa: SMAAEffect): boolean {
  let shaderFailed = false
  const previousCheckShaderErrors = renderer.debug.checkShaderErrors
  const previousShaderError = renderer.debug.onShaderError
  const previousRenderTarget = renderer.getRenderTarget()
  const previousActiveCubeFace = renderer.getActiveCubeFace()
  const previousActiveMipmapLevel = renderer.getActiveMipmapLevel()
  const probeTarget = new WebGLRenderTarget(16, 16, {
    depthBuffer: false,
    stencilBuffer: false,
  })

  try {
    renderer.debug.checkShaderErrors = true
    renderer.debug.onShaderError = (gl, program, glVertexShader, glFragmentShader) => {
      shaderFailed = true
      previousShaderError?.(gl, program, glVertexShader, glFragmentShader)
    }
    smaa.setSize(16, 16)
    smaa.update(renderer, probeTarget, 0)
    return !shaderFailed
  } catch {
    return false
  } finally {
    renderer.debug.checkShaderErrors = previousCheckShaderErrors
    renderer.debug.onShaderError = previousShaderError
    renderer.setRenderTarget(previousRenderTarget, previousActiveCubeFace, previousActiveMipmapLevel)
    probeTarget.dispose()
  }
}

function createAntialiasEffect(
  renderer: WebGLRenderer,
  profile: QualityProfile,
): { antialias: SMAAEffect | FXAAEffect; smaa: SMAAEffect | null } {
  const smaa = new SMAAEffect({
    preset: profile.smaaPreset,
    edgeDetectionMode: EdgeDetectionMode.COLOR,
  })
  smaa.edgeDetectionMaterial.edgeDetectionThreshold = profile.smaaEdgeThreshold

  if (probeSMAA(renderer, smaa)) {
    return { antialias: smaa, smaa }
  }

  console.warn('[PostFX] SMAA incompatível com este renderer; usando FXAA.')
  disposeFailedSMAA(smaa)
  return { antialias: new FXAAEffect(), smaa: null }
}

/**
 * Builds the composer and every effect in the chain.
 *
 * Side effect: sets `renderer.toneMapping = NoToneMapping` (see the module doc).
 * `renderer.outputColorSpace` is left alone — the composer's final pass encodes to it.
 */
export async function createPostFX(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: PerspectiveCamera,
): Promise<PostFX> {
  const directToneMapping = renderer.toneMapping
  const cleanupState: { composer: EffectComposer | null } = { composer: null }

  try {
    return await assemblePostFX(renderer, scene, camera, directToneMapping, (composer) => {
      cleanupState.composer = composer
    })
  } catch (error) {
    try {
      cleanupState.composer?.dispose()
    } catch (cleanupError) {
      console.error('[PostFX] falha ao limpar a inicialização incompleta:', cleanupError)
    }
    renderer.toneMapping = directToneMapping
    renderer.setRenderTarget(null)
    throw error
  }
}

async function assemblePostFX(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: PerspectiveCamera,
  directToneMapping: ToneMapping,
  onComposerCreated: (composer: EffectComposer) => void,
): Promise<PostFX> {
  let quality: PostFXQuality = 'high'
  let profile = QUALITY_PROFILES[quality]

  const composer = new EffectComposer(renderer, {
    frameBufferType: HalfFloatType,
    multisampling: clampMultisampling(renderer, profile.multisampling),
    stencilBuffer: false,
    depthBuffer: true,
  })
  onComposerCreated(composer)
  stripOutputBufferMultisampling(composer)

  await yieldToMain()
  const renderPass = new RenderPass(scene, camera)

  // N8AO reconstructs normals from the RenderPass depth texture. Its world-space
  // radius stays at ≈5 mm of subject, and it darkens raw HDR radiance before the
  // downstream AgX tone curve. Never gamma-lift this intermediate buffer.
  const aoPass = new N8AOPostPass(scene, camera)
  aoPass.configuration.gammaCorrection = false
  aoPass.configuration.screenSpaceRadius = false
  aoPass.configuration.distanceFalloff = 1
  aoPass.configuration.depthAwareUpsampling = true
  // Every transparent material in the scene uses depthWrite=false. Automatic
  // transparency handling would re-submit those meshes twice without adding AO depth.
  aoPass.configuration.transparencyAware = false

  function configureAO(next: QualityProfile): void {
    aoPass.configuration.aoSamples = next.aoSamples
    aoPass.configuration.aoRadius = next.aoRadius
    aoPass.configuration.denoiseSamples = next.aoDenoiseSamples
    aoPass.configuration.denoiseRadius = next.aoDenoiseRadius
    aoPass.configuration.halfRes = next.aoHalfResolution
    aoPass.configuration.intensity = next.aoIntensity
  }

  configureAO(profile)

  await yieldToMain()
  const bloom = new BloomEffect({
    mipmapBlur: true,
    // A/B provado em shots/probe/bloom-{on,off}.png: com limiar 1.0 o bloco QWERTY
    // inteiro passava do corte sob o softbox e o teclado virava um clarão leitoso —
    // exatamente o "wash" que o crítico r1 apontou. As capas claras chegam a ~1.2 de
    // radiância linear; o fósforo do CRT e os pontos especulares metálicos passam de
    // 2.0. O limiar em 1.45 deixa o plástico completamente em paz (SPEC §7: só a
    // tela deve realmente brilhar) e 0.6 de intensidade mantém a halação honesta.
    luminanceThreshold: 1.45,
    luminanceSmoothing: 0.22,
    intensity: 0.6,
    radius: 0.72,
    levels: profile.bloomLevels,
  })

  await yieldToMain()
  const depthOfField = new DepthOfFieldEffect(camera, {
    focusDistance: DOF_SEED_FOCUS_DISTANCE,
    focusRange: DOF_FOCUS_RANGE,
    bokehScale: profile.bokehScale,
    resolutionScale: profile.dofResolutionScale,
  })
  // Autofocus: the CoC material re-derives focusDistance from this point every frame,
  // so orbiting the camera keeps the machine sharp instead of drifting out of focus.
  depthOfField.target = MACHINE_CENTRE.clone()

  // Exactly zero at the optical centre, ≈0.6 px of R/B separation in the extreme
  // corners of a 1920-wide frame. Any silkscreen near the optical axis therefore reads
  // R = G = B by construction; if a legend renders orange-white, this is not the cause.
  const chromaticAberration = new RadialChromaticAberrationEffect(profile.chromaticAberration)

  const filmGrain = new NoiseEffect({ premultiply: true })
  // `premultiply` scales the noise by the incoming colour, so the void background stays
  // clean and grain only lives in the lit midtones — the way it does on a negative.
  filmGrain.blendMode.opacity.value = profile.grainOpacity

  // Derived so that the frame is untouched out to ~0.33 of the half-diagonal, falls to
  // ~0.96 at the edge midpoints and ~0.82 in the extreme corners: about -0.3 EV of
  // corner falloff, which is what a good prime does stopped down.
  const vignette = new VignetteEffect({
    technique: VignetteTechnique.DEFAULT,
    offset: 0.195,
    darkness: 0.271,
  })

  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX })

  await yieldToMain()
  const { antialias, smaa } = createAntialiasEffect(renderer, profile)

  await yieldToMain()
  const bloomPass = new EffectPass(camera, bloom)
  const depthOfFieldPass = new EffectPass(camera, depthOfField)
  const lensAndTonePass = new EffectPass(
    camera,
    chromaticAberration,
    filmGrain,
    vignette,
    toneMapping,
  )
  const antialiasPass = new EffectPass(camera, antialias)

  aoPass.enabled = profile.ao
  depthOfFieldPass.enabled = profile.depthOfField

  await yieldToMain()
  composer.addPass(renderPass)
  composer.addPass(aoPass)
  composer.addPass(bloomPass)
  composer.addPass(depthOfFieldPass)
  composer.addPass(lensAndTonePass)
  composer.addPass(antialiasPass)

  const effects: PostFXEffects = {
    smaa,
    antialias,
    bloom,
    depthOfField,
    chromaticAberration,
    filmGrain,
    vignette,
    toneMapping,
  }

  const passes: PostFXPasses = {
    render: renderPass,
    ao: aoPass,
    bloom: bloomPass,
    depthOfField: depthOfFieldPass,
    lensAndTone: lensAndTonePass,
    antialias: antialiasPass,
  }

  function applyCameraDependentSettings(): void {
    depthOfField.mainCamera = camera
  }

  function setAOEnabled(on: boolean): void {
    aoPass.enabled = on
  }

  function applyProfile(next: QualityProfile): void {
    composer.multisampling = clampMultisampling(renderer, next.multisampling)
    // O setter acima re-espelha as amostras nos DOIS buffers do ping-pong.
    stripOutputBufferMultisampling(composer)

    configureAO(next)

    bloom.mipmapBlurPass.levels = next.bloomLevels

    setAOEnabled(next.ao)
    depthOfFieldPass.enabled = next.depthOfField
    depthOfField.bokehScale = next.bokehScale
    depthOfField.resolution.scale = next.dofResolutionScale

    chromaticAberration.scale = next.chromaticAberration

    filmGrain.blendMode.opacity.value = next.grainOpacity

    if (smaa !== null) {
      smaa.applyPreset(next.smaaPreset)
      smaa.edgeDetectionMaterial.edgeDetectionThreshold = next.smaaEdgeThreshold
    }

    applyCameraDependentSettings()
  }

  applyCameraDependentSettings()

  let disposed = false
  const postFX: PostFX = {
    composer,
    effects,
    passes,
    get quality(): PostFXQuality {
      return quality
    },
    render(deltaTime?: number): void {
      composer.render(deltaTime)
    },
    setSize(width: number, height: number): void {
      composer.setSize(width, height)
    },
    setQuality(next: PostFXQuality): void {
      if (next === quality) {
        return
      }
      quality = next
      profile = QUALITY_PROFILES[next]
      applyProfile(profile)
    },
    setAOEnabled,
    setFocusTarget(target: Vector3 | null): void {
      depthOfField.target = target === null ? null : target.clone()
    },
    setExposure(exposure: number): void {
      renderer.toneMappingExposure = exposure
    },
    syncCamera(): void {
      applyCameraDependentSettings()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      try {
        // Disposes every pass, and each EffectPass disposes the effects it owns.
        composer.dispose()
      } finally {
        renderer.toneMapping = directToneMapping
        renderer.setRenderTarget(null)
      }
    },
  }

  // ToneMappingEffect owns tone mapping. Applying the renderer's curve as well would
  // run AgX twice and crush the graphite into mud. Delay this side effect until every
  // composer resource exists, so a construction failure keeps direct rendering valid.
  renderer.toneMapping = NoToneMapping
  return postFX
}
