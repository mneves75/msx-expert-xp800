#!/usr/bin/env node
/**
 * Calibração do casco do console contra a fotografia de referência.
 *
 * `tune-exposure.mjs` mede as CAPAS. Esta ferramenta mede o CASCO, que é
 * a leitura de assinatura do objeto: na foto (`reference/raw/CF3000_and_XP800.jpg`) o
 * tampo do Expert é um grafite escuro e quente; num render lavado ele vira bege e o
 * objeto deixa de ser reconhecível — que é exatamente o teste de aceitação da SPEC §11.
 *
 * Compara RGB exibido: tampo do console dividido pelo casco superior do teclado.
 * Razões em sRGB não cancelam universalmente exposição, tone mapping ou luz local;
 * a faixa observada é referência de aparência, não medida de albedo/iluminação.
 * A antiga amostra fotográfica [1400,960,90,30] incluía o logotipo branco.
 *
 * Uso:
 *   node tools/tune-case.mjs                       # mede o estado atual
 *   node tools/tune-case.mjs --sweep 1,0.8,0.6,0.5 # varre multiplicadores de albedo
 *   node tools/tune-case.mjs --env 0.2,0.4,0.6     # varre envMapIntensity do casco
 */
import { launchBrowser, targetUrl } from './browser.mjs'
import { mkdir, writeFile } from 'node:fs/promises'

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

/** Retângulos [x,y,w,h] no JPEG original de 2592×1944, sem redimensionamento. */
const REFERENCE = {
  image: 'reference/raw/CF3000_and_XP800.jpg',
  console: { roi: [1550, 420, 550, 210], rgb: [46.17966, 36.52072, 33.03345] },
  shell: [
    { roi: [1600, 960, 140, 20], rgb: [92.94893, 92.78857, 92.31893] },
    { roi: [1740, 965, 180, 15], rgb: [79.33741, 78.17704, 76.16037] },
  ],
  ratioRange: { min: [0.497, 0.394, 0.358], max: [0.582, 0.467, 0.434] },
}
const OUTPUT = '.scratch/calibration'
const measurements = []

/** A pose `top` de `shoot.mjs`, literal — o tampo e o teclado no mesmo quadro. */
const POSE = { azimuth: 25, elevation: 78, distance: 1.35, target: [0, 0.02, 0.08] }

/**
 * Pixels no quadro fixo de 1920×1080. Superfícies sem legendas, teclas ou quinas.
 * A antiga ROI do teclado [595,573,115,13] cruzava o recesso e as teclas de função.
 */
const ROI = {
  console: [850, 140, 220, 120],
  teclado: [795, 638, 25, 10],
}

const browser = await launchBrowser(['--ignore-gpu-blocklist', '--hide-scrollbars'])
let page
const errors = []

/**
 * Lê o RGB médio de cada ROI.
 *
 * A leitura passa por `screenshot`, não por `drawImage` do canvas: o renderer nasce com
 * `preserveDrawingBuffer: false`, então copiar o canvas depois do quadro composto devolve
 * preto — o que esta ferramenta mediu na primeira versão.
 */
async function measure(label) {
  const screenshot = `${OUTPUT}/tune-case-${label}.png`
  const shot = (await page.screenshot({ type: 'png', path: screenshot })).toString('base64')
  const rgb = await page.evaluate(async ({ roi, shot }) => {
    const img = new Image()
    img.src = `data:image/png;base64,${shot}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D indisponível')
    ctx.drawImage(img, 0, 0)
    const read = ([x, y, w, h]) => {
      const d = ctx.getImageData(x, y, w, h).data
      let r = 0, g = 0, b = 0
      const n = d.length / 4
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2] }
      return [r / n, g / n, b / n]
    }
    return { console: read(roi.console), teclado: read(roi.teclado) }
  }, { roi: ROI, shot })
  const ratio = rgb.console.map((channel, i) => channel / rgb.teclado[i])
  measurements.push({ label, screenshot, rgb, ratio })
  return rgb
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
  const warm = m.console[0] > m.console[2]
  console.log(
    `${label.padEnd(22)} razão R${fmt(r)} G${fmt(g)} B${fmt(b)}   ${warm ? 'R > B' : 'R ≤ B'}   console rgb(${m.console.map((v) => Math.round(v)).join(',')})   teclado rgb(${m.teclado.map((v) => Math.round(v)).join(',')})`
  )
}

try {
  await mkdir(OUTPUT, { recursive: true })
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(URL_, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__msxReady === true, null, { timeout: 60000 })
  await page.evaluate((pose) => {
    window.__msx.cameraRig.setAutoRotate(false)
    window.__msxHud.setChromeVisible(false)
    window.__msx.interactions.setPower(false)
    window.__msxCamera(pose)
    window.__msx.engine.requestRender(3)
  }, POSE)
  await page.waitForTimeout(5500)

  console.log('\nFaixa observada na foto: R 0.497–0.582 G 0.394–0.467 B 0.358–0.434 (aparência sRGB; não é um alvo físico).\n')
  report('estado atual', await measure('current'))

  if (SWEEP.length > 0) {
    console.log('\nvarredura de albedo (multiplicador sobre a cor atual do material):')
    for (const scale of SWEEP) {
      await apply(scale, undefined)
      report(`albedo ×${scale}`, await measure(`albedo-${scale}`))
    }
    await apply(1, undefined)
  }

  if (ENV_SWEEP.length > 0) {
    console.log('\nvarredura de envMapIntensity:')
    for (const env of ENV_SWEEP) {
      await apply(undefined, env)
      report(`env ${env}`, await measure(`env-${env}`))
    }
  }

  await writeFile(`${OUTPUT}/tune-case.json`, JSON.stringify({
    url: URL_, pose: POSE, power: 'off', viewport: [1920, 1080], roi: ROI, reference: REFERENCE,
    method: 'Displayed sRGB ratios; exposure, tone mapping and local illumination are not cancelled.',
    measurements, errors,
  }, null, 2))

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
