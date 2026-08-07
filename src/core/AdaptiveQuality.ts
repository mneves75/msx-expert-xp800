import type { Engine } from './Engine'
import type { PostFX } from './PostFX'

/**
 * Qualidade adaptativa por MEDIÇÃO, não por adivinhação de hardware.
 *
 * O caso que isto cobre é a máquina que não é um rasterizador de software (esse já é
 * detectado no boot) mas também não segura 60 fps no perfil `high` — o desktop
 * Windows de entrada com iGPU rodando WebGL via ANGLE/D3D11, onde o resolve MSAA
 * half-float e o pós-processamento em resolução cheia estouram o orçamento. Em vez
 * de heurística sobre a string do driver, mede-se o que interessa: o tempo real
 * entre quadros APRESENTADOS.
 *
 * Desenho deliberadamente monótono (só desce):
 *
 *   tier 0  perfil `high` (estado de nascimento)
 *   tier 1  perfil `low`
 *   tier 2  perfil `low` + teto de pixel ratio em 0,75 × DPR
 *   tier 3  perfil `low` + teto de pixel ratio em 0,50 × DPR
 *
 * Sem degrau de subida não existe oscilação por construção — o preço é que uma
 * máquina que melhora no meio da sessão (fecha um jogo, liga o carregador) fica um
 * degrau abaixo do possível até recarregar a página. É a troca certa aqui: transição
 * de tier muda pixels e realoca buffers, e um vaivém visível custa mais que um
 * degrau conservador.
 *
 * Interação com o render-on-demand: a amostragem só conta quadros que o Engine
 * realmente apresentou (timestamp confirmado pelo `Engine`). Cena ociosa não gera
 * amostra nenhuma — logo não gera transição nenhuma. Correto por construção.
 *
 * Contrato de captura: sob automação (`navigator.webdriver`) o controlador nasce
 * TRAVADO no tier 0 — o harness de screenshots (tools/shoot.mjs) precisa de saída
 * determinística, e um headless lento degradando qualidade no meio de um batch
 * viraria flake visual. `window.__msx.adaptiveQuality` expõe `lock()`/`unlock()`
 * para as tools e para A/B manual de degraus no console.
 */

export type AdaptiveTier = 0 | 1 | 2 | 3

export interface AdaptiveQualityHandle {
  /** Degrau atual (0 = qualidade plena). */
  readonly tier: AdaptiveTier
  /** Travado: nenhuma transição automática acontece. */
  readonly locked: boolean
  /** Trava num degrau explícito (tools, A/B manual). */
  lock(tier: AdaptiveTier): void
  /** Volta a medir e degradar a partir do estado atual. */
  unlock(): void
  dispose(): void
}

/** Janela de amostras (~1,5 s a 60 fps) sobre a qual o p75 é avaliado. */
const WINDOW = 90
/** p75 acima disto (≈ 45 fps) com a janela cheia = degrada um degrau. */
const DEGRADE_MS = 22
/**
 * Um delta de rAF mede CADÊNCIA, não custo: uma tela de 30 Hz ou o Energy Saver do
 * Chrome fixam todo delta em ~33 ms com a GPU ociosa. Cadência limitada e GPU
 * saturada são indistinguíveis olhando só os deltas, então o controlador guarda o
 * piso da sessão (o menor p10 de janela já visto — a cadência que a plataforma
 * comprovadamente alcança) e só degrada quando o p75 estoura TAMBÉM esse piso com
 * folga. Ambíguo = não degrada: falhar para o lado do status quo preserva a barra
 * visual; o custo é não adaptar num ambiente que nunca exibiu cadência melhor.
 */
const FLOOR_HEADROOM = 1.35
/** Amostras descartadas após resize / retorno de aba oculta (primeiro delta é falso). */
const DISCARD_AFTER_DISTURBANCE = 30
/** Amostras descartadas após o início — o controlador nasce depois do aquecimento. */
const DISCARD_AFTER_START = DISCARD_AFTER_DISTURBANCE
/** Delta acima disto é um stall de sistema (GC, troca de app), não um quadro típico. */
const STALL_MS = 200
/** Tempo mínimo entre transições — cada uma realoca buffers do composer. */
const COOLDOWN_MS = 2000

export function createAdaptiveQuality(
  engine: Engine,
  postFX: PostFX | null,
): AdaptiveQualityHandle {
  let tier: AdaptiveTier = 0
  let locked = typeof navigator !== 'undefined' && navigator.webdriver === true
  let disposed = false

  const samples: number[] = []
  let discard = DISCARD_AFTER_START
  let cooldownUntil = 0
  let lastSampledPresentation = 0
  /** Menor p10 de janela já observado — a cadência que a plataforma alcança. */
  let sessionFloorMs = Number.POSITIVE_INFINITY
  /**
   * Pixel ratio EFETIVO no momento em que a escada entra nos degraus de resolução —
   * já composto com `maxPixelRatio` do Engine (num DPR 3 com teto 2, 0,75 × DPR
   * seria 2,25: um degrau no-op que gastaria rung, cooldown e realocação sem
   * reduzir carga nenhuma). Reamostrado a cada entrada vinda de tier ≤ 1.
   */
  let resolutionBase: number | null = null

  function applyTier(next: AdaptiveTier): void {
    if (next >= 2 && resolutionBase === null) resolutionBase = engine.renderer.getPixelRatio()
    if (next < 2) resolutionBase = null
    tier = next
    postFX?.setQuality(next === 0 ? 'high' : 'low')
    // Teto ABSOLUTO derivado do ratio efetivo do momento da transição; não persegue
    // mudanças de tela depois disso — quem arrasta a janela para outro monitor no
    // meio de uma sessão já degradada fica com o teto antigo até recarregar.
    const base = resolutionBase ?? engine.renderer.getPixelRatio()
    engine.setAdaptivePixelRatioCap(next >= 2 ? base * (next === 2 ? 0.75 : 0.5) : null)
  }

  function reset(discardNext: number): void {
    samples.length = 0
    discard = Math.max(discard, discardNext)
  }

  function percentileOfWindow(fraction: number): number {
    const sorted = [...samples].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
  }

  engine.onFrame(() => {
    if (disposed) return
    const presentedAt = engine.lastPresentedAt
    if (presentedAt <= 0 || presentedAt === lastSampledPresentation) return

    // Relógio próprio: o dt do Engine é clampado em 1/15 s e mascararia a
    // severidade real de um quadro de 200 ms. `lastPresentedAt` só avança depois
    // de render bem-sucedido, então ticks pulados pelo teto de 60 Hz não entram.
    const now = performance.now()
    const delta = lastSampledPresentation > 0 ? presentedAt - lastSampledPresentation : 0
    lastSampledPresentation = presentedAt

    const candidate =
      !locked &&
      delta > 0 &&
      delta < STALL_MS &&
      now >= cooldownUntil &&
      document.visibilityState === 'visible'

    if (!candidate) return
    if (discard > 0) {
      discard -= 1
      return
    }

    samples.push(delta)
    if (samples.length < WINDOW) return

    const p75 = percentileOfWindow(0.75)
    const p10 = percentileOfWindow(0.1)
    sessionFloorMs = Math.min(sessionFloorMs, p10)
    const threshold = Math.max(DEGRADE_MS, sessionFloorMs * FLOOR_HEADROOM)
    // Janela quase uniforme = cadência travada (throttle/vsync), não GPU sofrendo:
    // carga real produz jitter; um rAF limitado produz deltas idênticos. Cobre o
    // Energy Saver que liga NO MEIO da sessão, quando o piso de 60 Hz já não vale.
    const cadenceLocked = p75 - p10 < 3

    if (p75 > threshold && !cadenceLocked && tier < 3) {
      const next = (tier + 1) as AdaptiveTier
      console.info(
        `[AdaptiveQuality] p75 ${p75.toFixed(1)} ms > ${threshold.toFixed(1)} ms — ` +
          `degrau ${tier} → ${next}.`,
      )
      applyTier(next)
      cooldownUntil = now + COOLDOWN_MS
      reset(DISCARD_AFTER_DISTURBANCE)
    } else {
      // Janela saudável, cadência ambígua (piso alto) ou piso da escada: descarta
      // e mede a próxima.
      samples.length = 0
    }
  })

  engine.onResize(() => {
    // Janela arrastada para outro monitor muda cadência E DPR: o piso da tela
    // anterior deixa de valer como referência.
    sessionFloorMs = Number.POSITIVE_INFINITY
    reset(DISCARD_AFTER_DISTURBANCE)
  })
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') reset(DISCARD_AFTER_DISTURBANCE)
  }
  document.addEventListener('visibilitychange', onVisibility)

  return {
    get tier(): AdaptiveTier {
      return tier
    },
    get locked(): boolean {
      return locked
    },
    lock(wanted: AdaptiveTier = tier): void {
      locked = true
      // Chamadores sem tipo (console, tools via page.evaluate) podem passar nada ou
      // lixo: `lock()` congela o estado ATUAL — entrada inválida nunca troca de
      // degrau (nem para cima: subir realoca buffers e muda pixels do mesmo jeito).
      const n = Number(wanted)
      const clamped = (
        Number.isFinite(n) ? Math.min(3, Math.max(0, Math.floor(n))) : tier
      ) as AdaptiveTier
      if (clamped !== tier) applyTier(clamped)
    },
    unlock(): void {
      locked = false
      reset(DISCARD_AFTER_DISTURBANCE)
    },
    dispose(): void {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
