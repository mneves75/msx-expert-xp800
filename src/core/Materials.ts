/**
 * Biblioteca PBR compartilhada — Gradiente Expert XP-800.
 *
 * Todos os módulos de cena pegam plástico, metal, borracha e vidro daqui. Isso
 * garante que as peças respondam à luz de forma idêntica: nada de "cada parte
 * parece vinda de uma cena diferente".
 *
 * Alvos de valor vêm da SPEC §3.2 (cores) e §4 (PBR). Nenhum material tem
 * iluminação assada no albedo; rugosidade, normal e AO são independentes.
 *
 * Suposição de UV: as peças usam UVs de face 0..1 (BoxGeometry e afins). O
 * `repeat` padrão foi calibrado para a face maior de cada peça; para partes
 * muito menores ou maiores, use `retile()` em vez de mexer nas texturas
 * compartilhadas.
 */

import * as THREE from 'three'
import type { MaterialLibrary } from './types'
import {
  caseSurfaceMaps,
  caseSurfaceMapsAsync,
  disposeTextureCache,
  microScratches,
  microScratchesAsync,
  setDefaultAnisotropy,
  type SurfaceMaps,
  type SurfaceOptions,
} from '../textures/procedural'

/**
 * Cores da SPEC §3.2, em sRGB (o ColorManagement do three converte para linear).
 *
 * `caseGraphite` e `caseFascia` foram re-amostradas da fotografia de referência
 * (`CF3000_and_XP800.jpg`); a SPEC §3.2 registra os valores e a medição:
 *
 *  - Tampo superior medido em (42.8, 33.5, 30.0); com o branco corrigido pela
 *    lajota do piso (81.0, 77.7, 72.7 → 1.00 / 0.96 / 0.90) sobra (42.8, 34.9,
 *    33.4). O casco é um **grafite marrom quente**, com R ~28 % acima de B — não
 *    o antigo neutro `#3A3733`, que renderiza azulado assim que a luz de
 *    preenchimento fria encosta nele.
 *  - A faixa frontal é quase preta: o contraste casco-claro / painel-escuro é a
 *    leitura de assinatura do objeto (SPEC §2) e some se os dois valores se
 *    aproximarem.
 */
export const PALETTE = {
  caseGraphite: 0x4a3b33,
  caseFascia: 0x232120,
  caseSilver: 0xa8a49b,
  panelBlack: 0x232323,
  keycapMain: 0xb8b5ac,
  keycapModifier: 0x8a887f,
  keycapStop: 0xc4342a,
  keycapGra: 0x5a9e5c,
  keycapCursor: 0x3e7fa8,
  msxRed: 0xcc2229,
  rubberFoot: 0x171513,
  chrome: 0xbfc2c4,
  brass: 0xb08d4f,
  connectorShell: 0x8f9295,
} as const

/** Rugosidade base (pico) de cada família — o mapa só reduz a partir daqui. */
const ROUGHNESS = {
  graphite: 0.72,
  fascia: 0.7,
  silver: 0.68,
  panel: 0.8,
  // 0,42 da SPEC lavava o centro do bloco QWERTY num clarão especular sob o softbox
  // de 1,2 m (achado do crítico r1 + verificação em shots/pos-ajuste). ABS de teclado
  // de 1985 é mais fosco que ABS novo; 0,55 mantém o brilho nas quinas sem o clarão.
  keycap: 0.55,
  keycapWorn: 0.36,
  rubber: 0.95,
} as const

/** IOR do ABS. Dá F0 ≈ 0.044, um pouco acima do padrão 1.5 do three. */
const ABS_IOR = 1.52

/** Biblioteca com ciclo de vida — `MaterialLibrary` mais utilitários. */
export interface ManagedMaterialLibrary extends MaterialLibrary {
  /**
   * Gera os conjuntos de texturas caros de forma cooperativa (tarefas curtas),
   * antes de os módulos construírem. As chamadas síncronas que vierem depois
   * acham tudo em cache e não bloqueiam o main thread. Opcional: sem o
   * pré-aquecimento tudo continua funcionando, só que em tarefas longas.
   */
  prewarm(): Promise<void>
  /**
   * Cópia do material com outra densidade de tiling. As texturas são clonadas
   * (compartilham a mesma `Source`, portanto não custam memória de GPU extra).
   * Use quando a peça for muito menor/maior que a face para a qual o material
   * foi calibrado — por exemplo um pé de borracha de 18 mm.
   */
  retile(material: THREE.MeshPhysicalMaterial, repeatU: number, repeatV: number): THREE.MeshPhysicalMaterial
  /** Libera materiais e texturas procedurais. */
  dispose(): void
}

function cloneTiled(tex: THREE.Texture | null, ru: number, rv: number): THREE.Texture | null {
  if (tex === null) return null
  const t = tex.clone()
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  t.repeat.set(ru, rv)
  return t
}

export function createMaterialLibrary(renderer: THREE.WebGLRenderer): ManagedMaterialLibrary {
  // Anisotropia alta é barata e é o que mantém o grão legível em ângulo rasante.
  setDefaultAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()))

  const materials = new Map<string, THREE.Material>()
  const derived: THREE.Texture[] = []
  let disposed = false

  function assertActive(): void {
    if (disposed) {
      throw new Error('MaterialLibrary: não é possível criar recursos após o descarte.')
    }
  }

  function cached<T extends THREE.Material>(key: string, build: () => T): T {
    assertActive()
    const hit = materials.get(key)
    if (hit !== undefined) return hit as T
    const made = build()
    materials.set(key, made)
    return made
  }

  // ---- conjuntos de mapas, criados sob demanda -----------------------------

  // Especificações compartilhadas entre o caminho síncrono e o pré-aquecimento:
  // uma divergência aqui quebraria o cache (chaves diferentes = trabalho dobrado).
  const CASE_SPEC: SurfaceOptions = {
    size: 1024,
    grain: 1,
    scratchDensity: 0.55,
    dust: 0.5,
    roughnessRange: [0.78, 1],
  }
  // Keycap: grão muito mais discreto, quase sem risco, pouca poeira.
  const KEYCAP_SPEC: SurfaceOptions = {
    size: 1024,
    grain: 0.45,
    scratchDensity: 0.12,
    dust: 0.22,
    roughnessRange: [0.86, 1],
  }

  let caseMapsCache: SurfaceMaps | null = null
  function caseMaps(): SurfaceMaps {
    caseMapsCache ??= caseSurfaceMaps(CASE_SPEC)
    return caseMapsCache
  }

  let keycapMapsCache: SurfaceMaps | null = null
  function keycapMaps(): SurfaceMaps {
    keycapMapsCache ??= caseSurfaceMaps(KEYCAP_SPEC)
    return keycapMapsCache
  }

  /** Aplica um conjunto de mapas a um material, com o tiling pedido. */
  function applySurface(
    material: THREE.MeshPhysicalMaterial,
    maps: SurfaceMaps,
    repeat: number,
    normalScale: number,
    aoIntensity: number,
  ): void {
    const n = cloneTiled(maps.normalMap, repeat, repeat)
    const r = cloneTiled(maps.roughnessMap, repeat, repeat)
    const a = cloneTiled(maps.aoMap, repeat, repeat)
    if (n !== null) derived.push(n)
    if (r !== null) derived.push(r)
    if (a !== null) derived.push(a)
    material.normalMap = n
    material.normalScale = new THREE.Vector2(normalScale, normalScale)
    material.roughnessMap = r
    // `aoMap` usa o canal UV 0 desde o three r152 — não exige um segundo set de UVs.
    material.aoMap = a
    material.aoMapIntensity = aoIntensity
    material.needsUpdate = true
  }

  interface PlasticSpec {
    readonly name: string
    readonly color: number
    readonly roughness: number
    readonly repeat: number
    readonly normalScale: number
    readonly maps: SurfaceMaps
    readonly specularIntensity?: number
    readonly aoIntensity?: number
  }

  function plastic(spec: PlasticSpec): THREE.MeshPhysicalMaterial {
    const m = new THREE.MeshPhysicalMaterial({
      name: spec.name,
      color: new THREE.Color(spec.color),
      roughness: spec.roughness,
      metalness: 0,
      ior: ABS_IOR,
      specularIntensity: spec.specularIntensity ?? 1,
      clearcoat: 0,
      sheen: 0,
      envMapIntensity: 1,
      dithering: true,
    })
    applySurface(m, spec.maps, spec.repeat, spec.normalScale, spec.aoIntensity ?? 0.75)
    return m
  }

  const library: ManagedMaterialLibrary = {
    prewarm: async () => {
      assertActive()
      caseMapsCache ??= await caseSurfaceMapsAsync(CASE_SPEC)
      if (disposed) return
      keycapMapsCache ??= await caseSurfaceMapsAsync(KEYCAP_SPEC)
      if (disposed) return
      // Popula o memo usado por `metal()` — mesma chamada, mesma chave.
      await microScratchesAsync(1024, 0.7)
    },

    caseGraphite: () =>
      cached('case-graphite', () =>
        plastic({
          name: 'case-graphite',
          color: PALETTE.caseGraphite,
          roughness: ROUGHNESS.graphite,
          repeat: 6,
          normalScale: 0.45,
          maps: caseMaps(),
        }),
      ),

    caseFascia: () =>
      cached('case-fascia', () =>
        plastic({
          name: 'case-fascia',
          color: PALETTE.caseFascia,
          roughness: ROUGHNESS.fascia,
          repeat: 7,
          normalScale: 0.38,
          maps: caseMaps(),
        }),
      ),

    caseSilver: () =>
      cached('case-silver', () =>
        plastic({
          name: 'case-silver',
          color: PALETTE.caseSilver,
          roughness: ROUGHNESS.silver,
          repeat: 6,
          normalScale: 0.42,
          maps: caseMaps(),
        }),
      ),

    panelBlack: () =>
      cached('panel-black', () =>
        plastic({
          name: 'panel-black',
          color: PALETTE.panelBlack,
          roughness: ROUGHNESS.panel,
          repeat: 9,
          normalScale: 0.22,
          // "Especular quase nulo": preto fosco texturizado devolve muito pouco.
          specularIntensity: 0.3,
          aoIntensity: 0.6,
          maps: caseMaps(),
        }),
      ),

    keycap: (hex: number, worn = false) =>
      cached(`keycap-${hex.toString(16)}-${worn ? 'worn' : 'fresh'}`, () => {
        const m = plastic({
          name: `keycap-${hex.toString(16)}${worn ? '-worn' : ''}`,
          color: hex,
          // SPEC §4: 0,55 nas teclas normais, 0,36 na barra de espaço e no Enter.
          roughness: worn ? ROUGHNESS.keycapWorn : ROUGHNESS.keycap,
          repeat: 0.6,
          // Polimento de dedo também achata o micro-relevo do ABS.
          normalScale: worn ? 0.11 : 0.2,
          aoIntensity: 0.45,
          maps: keycapMaps(),
        })
        if (worn) {
          // Óleo da pele fecha os poros: reflexo especular um pouco mais forte.
          m.specularIntensity = 1.08
          m.envMapIntensity = 1.15
        }
        return m
      }),

    metal: (hex: number, roughness = 0.35) =>
      cached(`metal-${hex.toString(16)}-${roughness}`, () => {
        const scratches = microScratches(1024, 0.7)
        const n = cloneTiled(scratches.normalMap, 4, 4)
        const r = cloneTiled(scratches.roughnessMap, 4, 4)
        if (n !== null) derived.push(n)
        if (r !== null) derived.push(r)
        const m = new THREE.MeshPhysicalMaterial({
          name: `metal-${hex.toString(16)}`,
          color: new THREE.Color(hex),
          metalness: 1,
          roughness,
          envMapIntensity: 1.25,
          dithering: true,
        })
        m.normalMap = n
        m.normalScale = new THREE.Vector2(0.5, 0.5)
        m.roughnessMap = r
        return m
      }),

    rubber: () =>
      cached('rubber', () => {
        const m = plastic({
          name: 'rubber-foot',
          color: PALETTE.rubberFoot,
          roughness: ROUGHNESS.rubber,
          repeat: 12,
          normalScale: 0.6,
          specularIntensity: 0.45,
          aoIntensity: 0.9,
          maps: caseMaps(),
        })
        m.ior = 1.5
        return m
      }),

    screenEmissive: (map: THREE.Texture) =>
      cached(`screen-${map.uuid}`, () => {
        // Framebuffer do emulador é conteúdo sRGB. Só definimos se ainda estiver
        // no padrão, para não sobrescrever a escolha de quem produz a textura.
        if (map.colorSpace === THREE.NoColorSpace) map.colorSpace = THREE.SRGBColorSpace
        return new THREE.MeshBasicMaterial({
          name: 'crt-screen',
          map,
          color: new THREE.Color(0xffffff),
          toneMapped: true,
          fog: false,
          side: THREE.FrontSide,
        })
      }),

    retile: (material, repeatU, repeatV) => {
      assertActive()
      const clone = material.clone()
      clone.name = `${material.name}-x${repeatU}x${repeatV}`
      for (const slot of ['normalMap', 'roughnessMap', 'aoMap', 'metalnessMap', 'map'] as const) {
        const t = cloneTiled(material[slot], repeatU, repeatV)
        if (t !== null) {
          derived.push(t)
          clone[slot] = t
        }
      }
      clone.needsUpdate = true
      return clone
    },

    dispose: () => {
      if (disposed) return
      disposed = true
      for (const m of materials.values()) m.dispose()
      materials.clear()
      for (const t of derived) t.dispose()
      derived.length = 0
      caseMapsCache = null
      keycapMapsCache = null
      disposeTextureCache()
    },
  }

  return library
}
