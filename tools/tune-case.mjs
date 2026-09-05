#!/usr/bin/env node
/**
 * Calibração do casco do console contra a fotografia de referência.
 *
 * `tune-exposure.mjs` ancora as CAPAS na SPEC §3.2. Esta ferramenta ancora o CASCO, que é
 * a leitura de assinatura do objeto: na foto (`reference/raw/CF3000_and_XP800.jpg`) o
 * tampo do Expert é um grafite escuro e quente; num render lavado ele vira bege e o
 * objeto deixa de ser reconhecível — que é exatamente o teste de aceitação da SPEC §11.
 *
 * O que é medido é uma **razão**, não um valor absoluto: tampo do console dividido pelo
 * casco do teclado, dentro da mesma imagem. Razão cancela a exposição, o perfil da foto e
 * a intensidade do estúdio; é a única comparação honesta entre uma fotografia de 2007 com
 * flash e um render tonemapeado com AgX.
 *
 * Alvo medido na fotografia (ROI do tampo ÷ ROI do casco do teclado, mesma imagem):
 *
 *     R 0.362   G 0.279   B 0.253      → escuro, e QUENTE (R > G > B)
 *
 * Uso:
 *   node tools/tune-case.mjs                       # mede o estado atual
 *   node tools/tune-case.mjs --sweep 1,0.8,0.6,0.5 # varre multiplicadores de albedo
 *   node tools/tune-case.mjs --env 0.2,0.4,0.6     # varre envMapIntensity do casco
 */
import { launchBrowser, targetUrl } from './browser.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const list = (name) => {
  const raw = flag(name, '')
  return raw ? raw.split(',').map(Number).filter((n) => Number.isFinite(n)) : []
}

const URL_ = targetUrl()
const SWEEP = list('sweep')
const ENV_SWEEP = list('env')

/** Alvo medido na fotografia de referência. Ver cabeçalho. */
const TARGET = { r: 0.362, g: 0.279, b: 0.253 }

/** A pose `top` de `shoot.mjs`, literal — o tampo e o teclado no mesmo quadro. */
const POSE = { azimuth: 25, elevation: 78, distance: 1.35, target: [0, 0.02, 0.08] }

/**
 * ROIs em fração do quadro. A do console cobre o miolo do tampo (longe das quinas, onde
 * o filete de 2 mm e o realce especular mentem); a do teclado cobre o casco prateado à
 * esquerda do campo de teclas.
 */
const ROI = {
  console: [0.42, 0.1, 0.16, 0.18],
  teclado: [0.31, 0.531, 0.06, 0.012],
}

const browser = await launchBrowser(['--ignore-gpu-blocklist', '--hide-scrollbars'])
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))

/**
 * Lê o RGB médio de cada ROI.
 *
 * A leitura passa por `screenshot`, não por `drawImage` do canvas: o renderer nasce com
 * `preserveDrawingBuffer: false`, então copiar o canvas depois do quadro composto devolve
 * preto — o que esta ferramenta mediu na primeira versão.
 */
async function measure() {
  const shot = (await page.screenshot({ type: 'png' })).toString('base64')
  return page.evaluate(async ({ roi, shot }) => {
    const img = new Image()
    img.src = `data:image/png;base64,${shot}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const read = ([fx, fy, fw, fh]) => {
      const x = Math.round(fx * c.width)
      const y = Math.round(fy * c.height)
      const w = Math.max(1, Math.round(fw * c.width))
      const h = Math.max(1, Math.round(fh * c.height))
      const d = ctx.getImageData(x, y, w, h).data
      let r = 0, g = 0, b = 0
      const n = d.length / 4
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2] }
      return [r / n, g / n, b / n]
    }
    return { console: read(roi.console), teclado: read(roi.teclado) }
  }, { roi: ROI, shot })
}

/** Aplica um multiplicador ao albedo do casco e/ou uma nova intensidade de env. */
async function apply(albedoScale, envIntensity) {
  await page.evaluate(
    ({ albedoScale, envIntensity }) => {
      const seen = new Set()
      window.__msx.scene.traverse((obj) => {
        const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : []
        for (const m of mats) {
          if (!m || seen.has(m.uuid)) continue
          if (typeof m.name !== 'string' || !m.name.startsWith('case-graphite')) continue
          seen.add(m.uuid)
          const base = m.userData.__tuneBaseColor ?? (m.userData.__tuneBaseColor = m.color.clone())
          if (albedoScale !== null) {
            m.color.copy(base).multiplyScalar(albedoScale)
          }
          if (envIntensity !== null) {
            m.userData.__tuneBaseEnv ??= m.envMapIntensity
            m.envMapIntensity = envIntensity
          }
          m.needsUpdate = true
        }
      })
      window.__msx.engine.requestRender(3)
    },
    { albedoScale: albedoScale ?? null, envIntensity: envIntensity ?? null }
  )
  await page.waitForTimeout(320)
}

const fmt = (v) => v.toFixed(3).padStart(6)
const report = (label, m) => {
  const r = m.console[0] / m.teclado[0]
  const g = m.console[1] / m.teclado[1]
  const b = m.console[2] / m.teclado[2]
  const dist = Math.hypot(r - TARGET.r, g - TARGET.g, b - TARGET.b)
  const warm = m.console[0] > m.console[2]
  console.log(
    `${label.padEnd(22)} razão R${fmt(r)} G${fmt(g)} B${fmt(b)}   Δalvo ${dist.toFixed(3)}   ${warm ? 'quente ✓' : 'frio ✗'}   console rgb(${m.console.map((v) => Math.round(v)).join(',')})`
  )
  return dist
}

try {
  await page.goto(URL_, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__msxReady === true, null, { timeout: 60000 })
  await page.evaluate((pose) => window.__msxCamera(pose), POSE)
  await page.evaluate(() => {
    window.__msx.hud?.setChromeVisible?.(false)
    window.__msx.engine.requestRender(3)
  })
  await page.waitForTimeout(600)

  console.log(`\nalvo da fotografia:    razão R${fmt(TARGET.r)} G${fmt(TARGET.g)} B${fmt(TARGET.b)}   (escuro e quente)\n`)
  report('estado atual', await measure())

  if (SWEEP.length > 0) {
    console.log('\nvarredura de albedo (multiplicador sobre a cor atual do material):')
    for (const scale of SWEEP) {
      await apply(scale, undefined)
      report(`albedo ×${scale}`, await measure())
    }
    await apply(1, undefined)
  }

  if (ENV_SWEEP.length > 0) {
    console.log('\nvarredura de envMapIntensity:')
    for (const env of ENV_SWEEP) {
      await apply(undefined, env)
      report(`env ${env}`, await measure())
    }
  }

  if (errors.length > 0) {
    console.error(`\nErros no console: ${[...new Set(errors)].join(' | ')}`)
    process.exitCode = 1
  }
} catch (error) {
  console.error(`✗ calibração do casco falhou: ${String(error)}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
