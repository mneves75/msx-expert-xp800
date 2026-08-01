#!/usr/bin/env node
/**
 * Render performance profiler.
 *
 * Boots the app in GPU-backed headless Chromium (ANGLE → Metal on macOS, the same
 * backend Chrome uses on real hardware; on Windows the equivalent path is ANGLE → D3D11)
 * and measures three independent things, because each catches a cost the others miss:
 *
 *  1. **rAF frame times** — the real cadence of the frame loop, captured with vsync and
 *     the frame-rate limiter off so a cheap frame reads as cheap instead of as 16.7 ms.
 *  2. **Per-pass GPU cost** — a synchronous A/B bench: the frame loop is stopped, each
 *     optional PostFX pass is disabled one at a time, and `composer.render` is timed
 *     over N frames with `gl.finish()` forcing completion. The delta against the full
 *     chain is what that pass costs on this GPU.
 *  3. **CPU profile** — CDP `Profiler` sampling while the loop runs, aggregated by self
 *     time, so per-frame JavaScript work (module `update()`s, spring physics, the CRT
 *     phosphor sim) is attributed to real functions.
 *
 * Usage:
 *   node tools/profile.mjs                       # -> .scratch/profile/profile.json
 *   node tools/profile.mjs --label baseline      # -> .scratch/profile/baseline.json
 *   node tools/profile.mjs --frames 300 --cpu-ms 5000
 *
 * The page contract is the same one `shoot.mjs` drives: `window.__msxReady`,
 * `window.__msxCamera(pose)`, `window.__msx.{engine,postFX,interactions}`.
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CaptureAbort, assertPageHealthy, gitSha, rendererInfo, stage } from './capture-guard.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

const URL_ = flag('url', 'http://localhost:5173/')
const WIDTH = Number(flag('width', '1920'))
const HEIGHT = Number(flag('height', '1080'))
const LABEL = flag('label', 'profile')
const OUT_DIR = resolve(flag('out', '.scratch/profile'))
const RAF_FRAMES = Number(flag('frames', '240'))
const BENCH_FRAMES = Number(flag('bench-frames', '60'))
const CPU_MS = Number(flag('cpu-ms', '4000'))

/** Same framing shoot.mjs calls `hero` — the pose users actually spend time in. */
const HERO = { azimuth: 38, elevation: 20, distance: 1.12, target: [0, 0.12, -0.06] }

await mkdir(OUT_DIR, { recursive: true })

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    // Unthrottled rAF: without these every frame reads as ~16.7 ms regardless of cost.
    '--disable-frame-rate-limit',
    '--disable-gpu-vsync',
  ],
})

const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
})

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(String(e)))

async function guard(fn) {
  try {
    return await fn()
  } catch (error) {
    console.error(`\n✗ profile aborted: ${error.message}`)
    if (error instanceof CaptureAbort && error.detail) {
      for (const [k, v] of Object.entries(error.detail)) {
        if (v === null || (Array.isArray(v) && v.length === 0)) continue
        console.error(`  ${k}: ${Array.isArray(v) ? v.join('\n    ') : v}`)
      }
    }
    await browser.close()
    process.exit(1)
  }
}

console.log(`→ ${URL_}  (${WIDTH}×${HEIGHT}, label: ${LABEL})`)
await page.goto(URL_, { waitUntil: 'networkidle', timeout: 60_000 })
await page
  .waitForFunction(() => window.__msxReady === true, { timeout: 60_000 })
  .catch(() => undefined)
await guard(() => assertPageHealthy(page, errors))

await page.evaluate((pose) => window.__msxCamera?.(pose), HERO)

/** Percentile over a sorted copy. */
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p))]
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  return {
    frames: samples.length,
    mean: Number(mean.toFixed(3)),
    p50: Number(at(0.5).toFixed(3)),
    p95: Number(at(0.95).toFixed(3)),
    max: Number(at(1).toFixed(3)),
    fps: Number((1000 / mean).toFixed(1)),
  }
}

/** Sample rAF-to-rAF deltas in the live loop. */
async function sampleFrameTimes(frames) {
  const samples = await page.evaluate(
    (n) =>
      new Promise((done) => {
        const deltas = []
        let last = performance.now()
        const tick = () => {
          const now = performance.now()
          deltas.push(now - last)
          last = now
          if (deltas.length >= n) done(deltas.slice(5))
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    frames,
  )
  return stats(samples)
}

/** Draw calls / triangles for one full composer frame (autoReset off, manual reset). */
async function frameCounters() {
  return page.evaluate(() => {
    const api = window.__msx
    if (!api) return null
    const { engine, postFX } = api
    const info = engine.renderer.info
    const wasAuto = info.autoReset
    info.autoReset = false
    // The app freezes the shadow atlas by default (Engine: shadowMap.autoUpdate =
    // false), so an idle frame never redraws it. Force one redraw for the first
    // measurement — otherwise both counters read the frozen cost and the A/B that
    // this tool exists to reproduce (shadow redraw = ~94 draws) measures zero.
    engine.renderer.shadowMap.needsUpdate = true
    info.reset()
    if (postFX) postFX.render(1 / 60)
    else engine.renderer.render(engine.scene, engine.camera)
    const out = {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? null,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    }
    // Same frame with the shadow atlas frozen (needsUpdate was consumed by the
    // render above): the difference is what re-rendering every shadow map costs in
    // draw calls on a scene that hasn't moved.
    info.reset()
    if (postFX) postFX.render(1 / 60)
    else engine.renderer.render(engine.scene, engine.camera)
    out.drawCallsShadowsFrozen = info.render.calls

    // Onde os desenhos realmente nascem. Sem esta quebra, o total lido acima é fácil de
    // ler errado como "a cena tem N objetos demais": não tem. Desligando um passe por vez
    // e medindo o quadro inteiro, o que sobra no fim é a cena de verdade, e cada degrau é
    // o preço do passe que saiu. O SPEC §10 orça `< 150` sem dizer qual destes números é o
    // orçado — a quebra é o que permite responder isso com medida em vez de opinião.
    if (postFX) {
      const step = (label) => {
        info.reset()
        postFX.render(1 / 60)
        return { label, drawCalls: info.render.calls }
      }
      const previous = Object.fromEntries(
        ['normal', 'occlusionAndBloom', 'depthOfField', 'lensAndTone', 'antialias'].map((key) => [
          key,
          postFX.passes[key]?.enabled ?? null,
        ]),
      )
      const ladder = [step('cadeia completa (sombras congeladas)')]
      for (const key of ['normal', 'occlusionAndBloom', 'depthOfField', 'lensAndTone', 'antialias']) {
        const pass = postFX.passes[key]
        if (!pass) continue
        pass.enabled = false
        ladder.push(step(`sem ${key}`))
      }
      for (const [key, enabled] of Object.entries(previous)) {
        const pass = postFX.passes[key]
        if (pass && enabled !== null) pass.enabled = enabled
      }
      out.drawCallLadder = ladder
      const last = ladder[ladder.length - 1]
      out.drawCallsSceneOnly = last ? last.drawCalls : null
    }

    info.reset()
    info.autoReset = wasAuto
    return out
  })
}

/**
 * A/B bench of PostFX pass configurations against the *live* frame loop.
 *
 * Each configuration toggles `postFX.passes[key].enabled` and then samples real
 * rAF-to-rAF deltas with vsync off, so the number includes everything a user pays for
 * that pass: JS per-pass overhead, submission, and GPU time under pipelining.
 *
 * Two discarded approaches, so nobody re-derives them: a *sequential* synchronous
 * `composer.render` loop bracketed by `gl.finish()` produced physically impossible
 * results (disabling a pass "cost" +15 ms), first from clock/thermal drift between
 * configs and then because `gl.finish()` under ANGLE Metal in headless Chromium is not
 * a reliable completion barrier. Interleaving rounds did not save it. The live-loop
 * rAF measure is slower to run but reproduces what a user's frame actually costs.
 *
 * Configurations are measured in interleaved rounds (A,B,C, A,B,C, …) and reduced to
 * the per-config median-of-rounds mean, cancelling residual monotonic drift.
 */
async function benchPassConfigs(configs, { rounds, framesPerRound }) {
  const samples = Object.fromEntries(configs.map((c) => [c.name, []]))
  for (let round = 0; round < rounds; round++) {
    for (const cfg of configs) {
      const mean = await page.evaluate(
        ({ disabled, frames }) =>
          new Promise((done) => {
            const api = window.__msx
            if (!api?.postFX) {
              done(null)
              return
            }
            const passes = api.postFX.passes
            const previous = {}
            for (const key of Object.keys(passes)) previous[key] = passes[key].enabled
            for (const key of disabled) {
              if (passes[key]) passes[key].enabled = false
            }
            const deltas = []
            let last = performance.now()
            const tick = () => {
              const now = performance.now()
              deltas.push(now - last)
              last = now
              if (deltas.length >= frames) {
                for (const key of Object.keys(previous)) passes[key].enabled = previous[key]
                // First frames pay the toggle (recompile/lazy buffers) — discard.
                const settled = deltas.slice(8)
                done(settled.reduce((a, b) => a + b, 0) / settled.length)
              } else {
                requestAnimationFrame(tick)
              }
            }
            requestAnimationFrame(tick)
          }),
        { disabled: cfg.disabled, frames: framesPerRound },
      )
      if (mean !== null) samples[cfg.name].push(mean)
    }
  }
  const out = {}
  for (const cfg of configs) {
    const sorted = samples[cfg.name].sort((a, b) => a - b)
    out[cfg.name] =
      sorted.length === 0 ? null : Number(sorted[Math.floor(sorted.length / 2)].toFixed(3))
  }
  return out
}

/** CPU sampling profile of the live loop, aggregated by self time. */
async function cpuProfile(ms) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
  await cdp.send('Profiler.start')
  await page.waitForTimeout(ms)
  const { profile } = await cdp.send('Profiler.stop')
  await cdp.detach()

  const nodesById = new Map(profile.nodes.map((n) => [n.id, n]))
  const selfTime = new Map()
  const interval = profile.timeDeltas ?? []
  const samples = profile.samples ?? []
  for (let i = 0; i < samples.length; i++) {
    const node = nodesById.get(samples[i])
    if (!node) continue
    const frame = node.callFrame
    const name = frame.functionName || '(anonymous)'
    const url = frame.url ? frame.url.split('/').slice(-1)[0] : ''
    const key = url ? `${name} @ ${url}` : name
    selfTime.set(key, (selfTime.get(key) ?? 0) + (interval[i] ?? 0))
  }
  const totalUs = [...selfTime.values()].reduce((a, b) => a + b, 0)
  const top = [...selfTime.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([name, us]) => ({
      name,
      ms: Number((us / 1000).toFixed(1)),
      pct: Number(((us / totalUs) * 100).toFixed(1)),
    }))
  return { windowMs: ms, sampledMs: Number((totalUs / 1000).toFixed(1)), top }
}

// ── Sequence ────────────────────────────────────────────────────────────────────

const result = {
  label: LABEL,
  capturedAt: new Date().toISOString(),
  gitSha: await gitSha(),
  url: URL_,
  viewport: { width: WIDTH, height: HEIGHT },
  gpu: await rendererInfo(page),
}

// Power OFF, camera idle — the state the page boots into and idles in.
await stage(page, { powerOn: false, showHud: false })
await page.waitForTimeout(1200)
result.counters = await frameCounters()
console.log(
  `  counters: ${result.counters?.drawCalls} draw calls ` +
    `(${result.counters?.drawCallsShadowsFrozen} c/ sombras congeladas), ` +
    `${result.counters?.triangles} triangles, ${result.counters?.programs} programs`,
)
if (result.counters?.drawCallLadder) {
  let previous = null
  for (const rung of result.counters.drawCallLadder) {
    const delta = previous === null ? '' : `  (−${previous - rung.drawCalls})`
    console.log(`    ${String(rung.drawCalls).padStart(5)} draws  ${rung.label}${delta}`)
    previous = rung.drawCalls
  }
  console.log(
    `    cena sozinha: ${result.counters.drawCallsSceneOnly} draws — orçamento SPEC §10: < 150`,
  )
}
result.idleOff = await sampleFrameTimes(RAF_FRAMES)
console.log(`  idle/off : mean ${result.idleOff.mean} ms  p95 ${result.idleOff.p95} ms  (${result.idleOff.fps} fps)`)

// Power ON — CRT warming, emulator (or procedural fallback) live.
await stage(page, { powerOn: true, showHud: false })
await page.waitForTimeout(6000)
await guard(() => assertPageHealthy(page, errors))
result.poweredOn = await sampleFrameTimes(RAF_FRAMES)
console.log(`  power/on : mean ${result.poweredOn.mean} ms  p95 ${result.poweredOn.p95} ms  (${result.poweredOn.fps} fps)`)

// CPU profile of the live loop, powered on.
result.cpu = await cpuProfile(CPU_MS)
console.log(`  cpu      : ${result.cpu.sampledMs} ms sampled over ${result.cpu.windowMs} ms window`)

// Per-pass A/B against the live loop (see benchPassConfigs for why not gl.finish).
const benches = await benchPassConfigs(
  [
    { name: 'fullChain', disabled: [] },
    { name: 'minus:normal', disabled: ['normal'] },
    { name: 'minus:occlusionAndBloom', disabled: ['occlusionAndBloom'] },
    { name: 'minus:depthOfField', disabled: ['depthOfField'] },
    { name: 'minus:lensAndTone', disabled: ['lensAndTone'] },
    { name: 'minus:antialias', disabled: ['antialias'] },
    // SSAO needs the normal pass; disabling the pair is the honest "no AO" number.
    { name: 'minus:normal+occlusionAndBloom', disabled: ['normal', 'occlusionAndBloom'] },
    {
      name: 'renderPassOnly',
      disabled: ['normal', 'occlusionAndBloom', 'depthOfField', 'lensAndTone', 'antialias'],
    },
  ],
  { rounds: 5, framesPerRound: Math.max(30, BENCH_FRAMES) },
)
result.gpuBench = benches

console.log('  gpu bench (ms/frame, live-loop rAF A/B):')
for (const [name, ms] of Object.entries(benches)) {
  const delta = name === 'fullChain' || ms === null ? '' : `  (Δ ${(benches.fullChain - ms).toFixed(2)})`
  console.log(`    ${name.padEnd(32)} ${ms}${delta}`)
}

await guard(() => assertPageHealthy(page, errors))
await browser.close()

const file = `${OUT_DIR}/${LABEL}.json`
await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(`\n✓ profile written to ${file}`)
