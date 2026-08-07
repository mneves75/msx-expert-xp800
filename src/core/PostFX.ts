import { HalfFloatType, NoToneMapping, Uniform, Vector3, WebGLRenderTarget } from 'three'

import { yieldToMain } from './cooperative'
import type { PerspectiveCamera, Scene, ToneMapping, WebGLRenderer } from 'three'
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
  NormalPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  SSAOEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  VignetteTechnique,
} from 'postprocessing'

/**
 * Post-processing chain for the XP-800 scene (SPEC §7).
 *
 * Chain, in render order:
 *
 *   RenderPass                                   HDR scene, half-float, MSAA on `high`
 *   NormalPass                                   view-space normals, consumed by SSAO
 *   EffectPass[ SSAO, Bloom ]                    occlusion + screen/specular glow, still HDR
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
 *  2. **SSAO and Bloom share one EffectPass.** BloomEffect samples the pass *input*
 *     for its luminance prefilter, so merging means it blooms the pre-occlusion image.
 *     With the threshold set high enough that only the CRT and specular hits survive,
 *     and AO only ever darkening creases that are far below that threshold, the two
 *     images are identical where it matters — and we save a full-screen buffer swap.
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

/** Individual effect handles, exposed for tuning during the critic loop. */
export interface PostFXEffects {
  readonly smaa: SMAAEffect | null
  readonly antialias: SMAAEffect | FXAAEffect
  readonly ssao: SSAOEffect
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
  readonly normal: NormalPass
  readonly occlusionAndBloom: EffectPass
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
  resize(width: number, height: number): void
  /**
   * Switch the perf tier (SPEC §10). NÃO é grátis: mudar `multisampling` realoca o
   * buffer de entrada do composer (hitch de um quadro) — chamar por transição de
   * tier, nunca por quadro.
   */
  setQuality(quality: PostFXQuality): void
  /**
   * World-space point the depth of field focuses on. `null` freezes the focus at the
   * current distance. Defaults to the centre of the main unit.
   */
  setFocusTarget(target: Vector3 | null): void
  /** Photographic exposure applied by the AgX curve. 1.0 is neutral. */
  setExposure(exposure: number): void
  /**
   * Re-derives the camera-dependent SSAO/DoF settings. Call after changing
   * `camera.near` / `camera.far`; the world-space thresholds below are stored as
   * normalised depths and go stale when the frustum changes.
   */
  syncCamera(): void
  dispose(): void
}

interface QualityProfile {
  /** MSAA sample count on the composer's input buffer. */
  readonly multisampling: number
  readonly normalResolutionScale: number
  readonly ssaoResolutionScale: number
  readonly ssaoSamples: number
  readonly ssaoRings: number
  /** Screen-space AO radius as a fraction of buffer height (SPEC: centimetre-scale). */
  readonly ssaoRadius: number
  readonly ssaoOpacity: number
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
    normalResolutionScale: 1,
    ssaoResolutionScale: 1,
    ssaoSamples: 12,
    ssaoRings: 7,
    // 0.019 * 1080 px ≈ 21 px ≈ 5 mm of subject at a typical framing. Deliberately
    // *tighter* than a general-purpose AO radius: this term exists for the seams, the
    // vent slots, the shell-overhang line and the last few millimetres before an object
    // meets the desk. A wide radius produces the soft grey wash that made everything in
    // the previous pass look like it was hovering.
    ssaoRadius: 0.019,
    ssaoOpacity: 1,
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
    normalResolutionScale: 0.5,
    ssaoResolutionScale: 0.5,
    ssaoSamples: 6,
    ssaoRings: 5,
    // Half-resolution AO needs a slightly wider kernel or it turns to noise.
    ssaoRadius: 0.028,
    ssaoOpacity: 0.9,
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

/** Camera-frustum-dependent SSAO limits, in metres. Re-applied by `syncCamera`. */
const SSAO_WORLD = {
  /** Below this depth difference two samples are treated as the same surface. */
  proximityThreshold: 0.012,
  proximityFalloff: 0.03,
  /** Distance from the camera at which AO fades out. Well past the whole set. */
  distanceThreshold: 8,
  distanceFalloff: 4,
} as const

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

  // SSAO needs view-space normals; the composer supplies depth on its own.
  const normalPass = new NormalPass(scene, camera, {
    resolutionScale: profile.normalResolutionScale,
  })

  await yieldToMain()
  const ssao = new SSAOEffect(camera, normalPass.texture, {
    samples: profile.ssaoSamples,
    rings: profile.ssaoRings,
    radius: profile.ssaoRadius,
    // Screen-space AO on the raw HDR buffer, i.e. it darkens radiance before the
    // tone curve — which is where occlusion physically belongs.
    intensity: 1.9,
    // A near-field bias this large is what stops occlusion from ever reaching the last
    // millimetre before a contact, which is exactly where it must be darkest. Dropped
    // to the smallest value that still keeps the depth-discontinuity halo away.
    bias: 0.008,
    fade: 0.012,
    // Keeps AO off the emissive CRT and off blown speculars without killing it on
    // the lit top face of the case.
    luminanceInfluence: 0.4,
    minRadiusScale: 0.14,
    worldProximityThreshold: SSAO_WORLD.proximityThreshold,
    worldProximityFalloff: SSAO_WORLD.proximityFalloff,
    worldDistanceThreshold: SSAO_WORLD.distanceThreshold,
    worldDistanceFalloff: SSAO_WORLD.distanceFalloff,
    resolutionScale: profile.ssaoResolutionScale,
    depthAwareUpsampling: true,
  })
  ssao.blendMode.opacity.value = profile.ssaoOpacity

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
  const occlusionAndBloomPass = new EffectPass(camera, ssao, bloom)
  const depthOfFieldPass = new EffectPass(camera, depthOfField)
  const lensAndTonePass = new EffectPass(
    camera,
    chromaticAberration,
    filmGrain,
    vignette,
    toneMapping,
  )
  const antialiasPass = new EffectPass(camera, antialias)

  depthOfFieldPass.enabled = profile.depthOfField

  await yieldToMain()
  composer.addPass(renderPass)
  composer.addPass(normalPass)
  composer.addPass(occlusionAndBloomPass)
  composer.addPass(depthOfFieldPass)
  composer.addPass(lensAndTonePass)
  composer.addPass(antialiasPass)

  const effects: PostFXEffects = {
    smaa,
    antialias,
    ssao,
    bloom,
    depthOfField,
    chromaticAberration,
    filmGrain,
    vignette,
    toneMapping,
  }

  const passes: PostFXPasses = {
    render: renderPass,
    normal: normalPass,
    occlusionAndBloom: occlusionAndBloomPass,
    depthOfField: depthOfFieldPass,
    lensAndTone: lensAndTonePass,
    antialias: antialiasPass,
  }

  /**
   * The world-space SSAO thresholds are stored internally as normalised depths derived
   * from the camera frustum, so they must be re-applied whenever near/far change.
   */
  function applyCameraDependentSettings(): void {
    ssao.mainCamera = camera
    depthOfField.mainCamera = camera

    const ssaoMaterial = ssao.ssaoMaterial
    ssaoMaterial.worldProximityThreshold = SSAO_WORLD.proximityThreshold
    ssaoMaterial.worldProximityFalloff = SSAO_WORLD.proximityFalloff
    ssaoMaterial.worldDistanceThreshold = SSAO_WORLD.distanceThreshold
    ssaoMaterial.worldDistanceFalloff = SSAO_WORLD.distanceFalloff
  }

  function applyProfile(next: QualityProfile): void {
    composer.multisampling = clampMultisampling(renderer, next.multisampling)
    // O setter acima re-espelha as amostras nos DOIS buffers do ping-pong.
    stripOutputBufferMultisampling(composer)

    normalPass.resolution.scale = next.normalResolutionScale

    ssao.samples = next.ssaoSamples
    ssao.rings = next.ssaoRings
    ssao.radius = next.ssaoRadius
    ssao.resolution.scale = next.ssaoResolutionScale
    ssao.blendMode.opacity.value = next.ssaoOpacity

    bloom.mipmapBlurPass.levels = next.bloomLevels

    depthOfFieldPass.enabled = next.depthOfField
    depthOfField.bokehScale = next.bokehScale
    depthOfField.resolution.scale = next.dofResolutionScale

    chromaticAberration.scale = next.chromaticAberration

    filmGrain.blendMode.opacity.value = next.grainOpacity

    if (smaa !== null) {
      smaa.applyPreset(next.smaaPreset)
      smaa.edgeDetectionMaterial.edgeDetectionThreshold = next.smaaEdgeThreshold
    }

    // Radius and resolution changes invalidate the derived depth cutoffs.
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
    resize(width: number, height: number): void {
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
