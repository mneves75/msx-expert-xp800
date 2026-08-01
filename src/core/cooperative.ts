/**
 * Cooperação com o main thread durante trabalho pesado de CPU.
 *
 * Os geradores procedurais de textura são `function*` que fazem `yield` a cada
 * lote de linhas. Dois drivers percorrem o MESMO gerador — a matemática
 * executada é idêntica nos dois caminhos, então o resultado é bit a bit igual:
 *
 *  - {@link drain} roda até o fim de forma síncrona (preserva a API pública
 *    existente e o comportamento de sempre);
 *  - {@link driveCooperatively} devolve o controle ao navegador sempre que o
 *    orçamento da fatia estoura, mantendo cada tarefa curta o bastante para
 *    não contar como "long task" (TBT ≈ 0) mesmo sob CPU 4× mais lenta.
 */

/** Orçamento de uma fatia, em ms reais. 8 ms aqui ≈ 32 ms num celular 4× mais lento. */
const SLICE_BUDGET_MS = 8

interface SchedulerLike {
  readonly yield?: () => Promise<void>
}

const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null
const pending: Array<() => void> = []
if (channel !== null) {
  channel.port1.onmessage = () => pending.shift()?.()
}

/**
 * Uma macrotask adiante. Prefere `scheduler.yield()` (retoma com prioridade);
 * o fallback usa MessageChannel porque `setTimeout` aninhado sofre clamp de
 * ~4 ms e centenas de fatias virariam segundos de espera.
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler
  if (scheduler?.yield !== undefined) return scheduler.yield()
  if (channel !== null) {
    return new Promise((resolve) => {
      pending.push(resolve)
      channel.port2.postMessage(null)
    })
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Resolve depois que o navegador apresentou um quadro — dois rAF garantem que
 * o paint aconteceu, o timeout devolve o controle já fora do ciclo de render.
 * Usado para pintar o véu de boot antes de qualquer trabalho pesado: sem isto
 * o primeiro paint disputa com a criação do contexto WebGL e perde.
 */
export function afterFirstPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setTimeout(resolve, 0))
    })
  })
}

/** Percorre o gerador até o fim, de forma síncrona. */
export function drain<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done === true) return next.value
  }
}

/** Percorre o gerador cedendo o main thread quando a fatia estoura o orçamento. */
export async function driveCooperatively<T>(steps: Generator<void, T>): Promise<T> {
  let sliceStart = performance.now()
  for (;;) {
    const next = steps.next()
    if (next.done === true) return next.value
    if (performance.now() - sliceStart >= SLICE_BUDGET_MS) {
      await yieldToMain()
      sliceStart = performance.now()
    }
  }
}
