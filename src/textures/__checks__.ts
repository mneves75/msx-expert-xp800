import * as THREE from 'three'

import {
  caseSurfaceMapsAsync,
  disposeTextureCache,
  dustAccumulationAsync,
  microScratchesAsync,
  silkscreenDecal,
  type SurfaceOptions,
} from './procedural.ts'

/**
 * Verificação de determinismo das texturas procedurais, chamada por
 * `tools/verify-textures.mjs`.
 *
 * Toda textura desta cena é gerada em código a partir de uma semente fixa: a mesma
 * entrada tem de dar exatamente os mesmos bytes, hoje e depois de qualquer otimização.
 * Isso não é preciosismo — é o que permite mexer no gerador (fatiar em worker, trocar
 * a ordem do laço, mudar a precisão) e provar que **nenhum pixel** mudou, sem depender
 * de olhar 15 capturas. Se um hash mudar, ou a mudança foi deliberada (e a linha de
 * base é atualizada junto, com a justificativa) ou é uma regressão visual silenciosa.
 *
 * As opções replicam as de `core/Materials.ts` (`CASE_SPEC` / `KEYCAP_SPEC`) e as
 * chamadas do pré-aquecimento: o que é medido é o que a cena realmente usa.
 */

const CASE_SPEC: SurfaceOptions = {
  size: 1024,
  grain: 1,
  scratchDensity: 0.55,
  dust: 0.5,
  roughnessRange: [0.78, 1],
}

const KEYCAP_SPEC: SurfaceOptions = {
  size: 1024,
  grain: 0.45,
  scratchDensity: 0.12,
  dust: 0.22,
  roughnessRange: [0.86, 1],
}

export interface TextureHash {
  readonly name: string
  /** FNV-1a de 32 bits sobre os bytes da imagem, em hexadecimal. */
  readonly hash: string
  readonly width: number
  readonly height: number
  readonly bytes: number
}

export interface TextureCheckResult {
  readonly hashes: readonly TextureHash[]
  /** Milissegundos de relógio para gerar o conjunto inteiro, cache frio. */
  readonly generationMs: number
}

/** FNV-1a 32 bits — barato, estável entre execuções e sensível a um único byte. */
function fnv1a(bytes: ArrayLike<number>): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] as number
    // O múltiplo primo do FNV via deslocamentos: sobrevive à falta de inteiros de 32
    // bits em JS sem passar por `Math.imul` em cada byte.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function hashTexture(name: string, tex: THREE.Texture): TextureHash {
  const image = tex.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined
  const data = image?.data
  if (!data) {
    throw new Error(`Textura "${name}" não expõe dados de pixel (image.data ausente).`)
  }
  return {
    name,
    hash: fnv1a(data),
    width: image?.width ?? 0,
    height: image?.height ?? 0,
    bytes: data.length,
  }
}

/**
 * Gera o conjunto de texturas que o boot realmente produz e devolve o hash de cada uma.
 *
 * O cache é limpo antes e depois: medir com cache quente mediria o `Map`, não o gerador.
 */
export async function verifyProceduralTextures(): Promise<TextureCheckResult> {
  disposeTextureCache()
  try {
    const started = performance.now()

    const caseMaps = await caseSurfaceMapsAsync(CASE_SPEC)
    const keycapMaps = await caseSurfaceMapsAsync(KEYCAP_SPEC)
    const metalScratches = await microScratchesAsync(1024, 0.7)
    const dust = await dustAccumulationAsync(1024, { coverage: 0.5 })

    const generationMs = performance.now() - started

    const hashes: TextureHash[] = [
      hashTexture('case.normalMap', caseMaps.normalMap),
      hashTexture('case.roughnessMap', caseMaps.roughnessMap),
      hashTexture('case.aoMap', caseMaps.aoMap),
      hashTexture('keycap.normalMap', keycapMaps.normalMap),
      hashTexture('keycap.roughnessMap', keycapMaps.roughnessMap),
      hashTexture('keycap.aoMap', keycapMaps.aoMap),
      hashTexture('metalScratches.normalMap', metalScratches.normalMap),
      hashTexture('metalScratches.roughnessMap', metalScratches.roughnessMap),
      hashTexture('dust', dust),
    ]

    const draw = (ctx: CanvasRenderingContext2D): void => ctx.fillRect(4, 4, 24, 24)
    const shared = { width: 32, height: 32, cacheKey: 'cache-check', wear: 0.2 }
    const first = silkscreenDecal(draw, { ...shared, ink: '#ffffff', seed: 1 })
    const same = silkscreenDecal(draw, { ...shared, ink: '#ffffff', seed: 1 })
    const otherInk = silkscreenDecal(draw, { ...shared, ink: '#000000', seed: 1 })
    const otherSeed = silkscreenDecal(draw, { ...shared, ink: '#ffffff', seed: 2 })
    if (first !== same || first === otherInk || first === otherSeed) {
      throw new Error('Cache de serigrafia não separa tinta e semente corretamente.')
    }

    return { hashes, generationMs }
  } finally {
    disposeTextureCache()
  }
}
