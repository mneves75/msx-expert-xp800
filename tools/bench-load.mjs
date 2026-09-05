#!/usr/bin/env node
/**
 * Page-load benchmark — repeatable, cold-cache, tiered.
 *
 * "How fast does the page load" is three different questions, and answering them with
 * one number is how a project convinces itself it is fast. This tool separates them:
 *
 *  1. **shell**   — TTFB and `responseEnd` of the HTML document. Read this as a
 *                   **cold-connection first visit**: every iteration runs in a fresh
 *                   context, and Chromium scopes its socket pool to the context, so the
 *                   TCP and TLS handshakes are inside TTFB rather than amortised away.
 *                   That is the honest number for a first-time visitor, but it is NOT
 *                   server processing time — against a remote edge the handshakes are
 *                   usually the majority of it. To separate the two, decompose one
 *                   request with curl:
 *                     curl -o /dev/null -w 'tcp %{time_connect} tls %{time_appconnect} ttfb %{time_starttransfer}\n' <url>
 *  2. **document** — DOMContentLoaded and the `load` event: the shell plus every
 *                   render-blocking resource. DOMContentLoaded also waits for deferred
 *                   module evaluation; neither event proves the asynchronous 3D boot.
 *  3. **scene**   — first paint, and `window.__msxReady`: the 3D scene actually built and
 *                   presented. This one is bounded by GPU work and cannot be compared to
 *                   an HTML page's load time.
 *
 * Conditions are held fixed across runs so two labels are comparable: same viewport, same
 * Chromium flags, a fresh incognito-equivalent context per iteration (cold HTTP cache and
 * cold module cache), sequential runs, and a discarded warm-up run per target that pays
 * for OS-level DNS and this process's own lazy init. The warm-up does not carry a
 * connection into the measured runs — see the shell tier above.
 *
 * Usage:
 *   node tools/bench-load.mjs                                   # local preview :4173
 *   node tools/bench-load.mjs --base https://example.workers.dev # the edge (authoritative)
 *   node tools/bench-load.mjs --runs 15 --label after-split
 *   node tools/bench-load.mjs --paths /,/nao-existe             # SPA fallback too
 *
 * Output: a table on stdout and `.scratch/bench/<label>.json` for A/B against a later run.
 */
import { launchBrowser, targetUrl } from './browser.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadavg, cpus } from 'node:os'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return fallback
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`--${name} requires a value`)
  return args[i + 1]
}
const has = (name) => args.includes(`--${name}`)
const positiveInteger = (name, fallback) => {
  const value = Number(flag(name, fallback))
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`)
  return value
}

const BASE = flag('base', targetUrl('http://127.0.0.1:4173/')).replace(/\/+$/, '')
if (!['http:', 'https:'].includes(new URL(BASE).protocol)) throw new Error('--base must be HTTP(S)')
const PATHS = flag('paths', '/,/nao-existe-spa-fallback')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)
if (!PATHS.length || PATHS.some((path) => !path.startsWith('/') || path.startsWith('//'))) {
  throw new Error('--paths must contain same-origin absolute paths')
}
const RUNS = positiveInteger('runs', '10')
const LABEL = flag('label', 'bench')
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(LABEL)) throw new Error('--label must be a filename component')
const OUT_DIR = resolve(flag('out', '.scratch/bench'))
const WIDTH = positiveInteger('width', '1440')
const HEIGHT = positiveInteger('height', '900')
const SCENE = !has('no-scene')
const SCENE_TIMEOUT = positiveInteger('scene-timeout', '30000')
const HOST_LOAD_AT_START = loadavg()

const pct = (sorted, p) => {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}
const stats = (values) => {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  return {
    n: v.length,
    min: +v[0].toFixed(2),
    median: +pct(v, 50).toFixed(2),
    p95: +pct(v, 95).toFixed(2),
    max: +v[v.length - 1].toFixed(2),
  }
}

const browser = await launchBrowser([
    '--ignore-gpu-blocklist',
    '--hide-scrollbars',
    '--mute-audio',
])

/**
 * One cold-cache navigation. Returns the timing tiers in milliseconds relative to the
 * navigation start, plus the transferred byte counts that explain them.
 */
async function measure(url) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    bypassCSP: false,
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  const transfer = { document: 0, script: 0, stylesheet: 0, other: 0, total: 0, requests: 0 }
  page.on('response', async (res) => {
    try {
      const sizes = await res.request().sizes()
      const bytes = (sizes.responseBodySize ?? 0) + (sizes.responseHeadersSize ?? 0)
      const type = res.request().resourceType()
      const bucket = type === 'document' ? 'document' : type === 'script' ? 'script' : type === 'stylesheet' ? 'stylesheet' : 'other'
      transfer[bucket] += bytes
      transfer.total += bytes
      transfer.requests += 1
    } catch {
      /* request may be gone; byte accounting is diagnostic, never a gate */
    }
  })

  let sceneReadyMs = null
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: 60000 })
    const status = response?.status() ?? 0
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`)

    if (SCENE) {
      sceneReadyMs = await page
        .evaluate(async (timeout) => {
          const deadline = performance.now() + timeout
          while (performance.now() < deadline) {
            if (window.__msxReady === true) {
              return performance.now()
            }
            await new Promise((r) => setTimeout(r, 16))
          }
          return null
        }, SCENE_TIMEOUT)
        .catch(() => null)
      if (sceneReadyMs === null) throw new Error(`scene did not become ready within ${SCENE_TIMEOUT} ms`)
      if (errors.length) throw new Error(`scene errors: ${errors.join(' | ')}`)
      if (!await page.evaluate(() => window.__msx?.engine?.isHealthy === true)) {
        throw new Error('render pipeline is not healthy')
      }
    }

    const nav = await page.evaluate(() => {
      const [entry] = performance.getEntriesByType('navigation')
      const paints = performance.getEntriesByType('paint')
      const fp = paints.find((p) => p.name === 'first-paint')
      const fcp = paints.find((p) => p.name === 'first-contentful-paint')
      if (!entry) return null
      return {
        ttfb: entry.responseStart - entry.startTime,
        responseEnd: entry.responseEnd - entry.startTime,
        domContentLoaded: entry.domContentLoadedEventEnd - entry.startTime,
        load: entry.loadEventEnd - entry.startTime,
        firstPaint: fp ? fp.startTime : null,
        firstContentfulPaint: fcp ? fcp.startTime : null,
        transferSizeDocument: entry.transferSize,
        encodedDocument: entry.encodedBodySize,
      }
    })
    if (nav === null) throw new Error('navigation timing is unavailable')

    return { ok: true, status, ...nav, sceneReady: sceneReadyMs, transfer }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  } finally {
    await context.close()
  }
}

const results = {}
/** Invalid samples are reported and fail the run instead of improving the median. */
let failedTargets = 0
for (const path of PATHS) {
  const url = `${BASE}${path}`
  // Warm-up: pays OS-level DNS and this process's lazy init, then is discarded.
  await measure(url)

  const samples = []
  const rejected = []
  for (let i = 0; i < RUNS; i += 1) {
    const sample = await measure(url)
    if (!sample.ok) {
      console.error(`  ! ${url} run ${i + 1}: ${sample.error}`)
      rejected.push({ run: i + 1, error: sample.error })
      continue
    }
    samples.push(sample)
  }

  if (!samples.length) {
    // Sem isto, um servidor fora do ar sai com status 0 e um wrapper de CI lê a
    // medição como bem-sucedida — o modo de falha mais caro de uma ferramenta de
    // benchmark, porque some justamente quando algo já está quebrado.
    results[path] = { url, error: 'every run failed', rejected }
    failedTargets += 1
    continue
  }

  const first = samples[0]
  if (rejected.length) failedTargets += 1
  results[path] = {
    url,
    status: first.status,
    runs: samples.length,
    rejected,
    shell: {
      ttfb: stats(samples.map((s) => s.ttfb)),
      responseEnd: stats(samples.map((s) => s.responseEnd)),
    },
    document: {
      domContentLoaded: stats(samples.map((s) => s.domContentLoaded)),
      load: stats(samples.map((s) => s.load)),
    },
    scene: {
      firstPaint: stats(samples.map((s) => s.firstPaint)),
      firstContentfulPaint: stats(samples.map((s) => s.firstContentfulPaint)),
      msxReady: stats(samples.map((s) => s.sceneReady)),
    },
    bytes: {
      document: Math.round(first.transfer.document),
      script: Math.round(first.transfer.script),
      stylesheet: Math.round(first.transfer.stylesheet),
      other: Math.round(first.transfer.other),
      total: Math.round(first.transfer.total),
      requests: first.transfer.requests,
    },
  }
}

await browser.close()

const report = {
  label: LABEL,
  base: BASE,
  runs: RUNS,
  viewport: `${WIDTH}x${HEIGHT}`,
  measuredAt: new Date().toISOString(),
  sceneRequired: SCENE,
  host: { platform: process.platform, logicalCpus: cpus().length, loadAverageAtStart: HOST_LOAD_AT_START, loadAverageAtEnd: loadavg() },
  results,
}

await mkdir(OUT_DIR, { recursive: true })
const outPath = resolve(OUT_DIR, `${LABEL}.json`)
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`)

const row = (name, s) => (s ? `${name.padEnd(22)} med ${String(s.median).padStart(8)} ms   p95 ${String(s.p95).padStart(8)} ms   min ${String(s.min).padStart(8)} ms` : `${name.padEnd(22)} —`)

console.log(`\nbench-load · ${LABEL} · ${BASE} · ${RUNS} cold runs each\n`)
for (const [path, r] of Object.entries(results)) {
  if (r.error) {
    console.log(`${path}  ✗ ${r.error}`)
    continue
  }
  console.log(`${path}  (HTTP ${r.status})`)
  console.log(`  ${row('shell TTFB', r.shell.ttfb)}`)
  console.log(`  ${row('shell responseEnd', r.shell.responseEnd)}`)
  console.log(`  ${row('DOMContentLoaded', r.document.domContentLoaded)}`)
  console.log(`  ${row('load event', r.document.load)}`)
  console.log(`  ${row('first paint', r.scene.firstPaint)}`)
  console.log(`  ${row('first contentful', r.scene.firstContentfulPaint)}`)
  console.log(`  ${row('__msxReady (scene)', r.scene.msxReady)}`)
  console.log(
    `  bytes  doc ${r.bytes.document}  js ${r.bytes.script}  css ${r.bytes.stylesheet}  other ${r.bytes.other}  total ${r.bytes.total} over ${r.bytes.requests} requests`
  )
  console.log('')
}
console.log(`  shell = conexão fria: TTFB inclui os apertos de mão TCP/TLS, não é tempo de servidor.`)
console.log(`→ ${outPath}\n`)

if (failedTargets > 0) {
  console.error(`✗ ${failedTargets} de ${PATHS.length} alvos tiveram amostras inválidas.`)
  process.exitCode = 1
}
