// RGB exibido de faces limpas, separado do recorte histórico que inclui vãos e biséis.
// #B8B5AC é albedo do material, não um alvo absoluto para pixels iluminados/tonemapeados.
// CRT desligado: o conteúdo e a promoção do emulador não alteram a luz durante a varredura.
import { mkdir, writeFile } from 'node:fs/promises'
import { launchBrowser, targetUrl } from './browser.mjs'
const URL_ = targetUrl()
const OUTPUT = '.scratch/calibration'
const POSE = { azimuth: 12, elevation: 55, distance: 0.45, target: [0, 0.015, 0.26] }
const ROI = {
  mixedHistorical: [540, 360, 80, 50],
  J: [480, 355, 10, 7],
  K: [529, 378, 12, 7],
  L: [580, 389, 15, 7],
  shell: [700, 170, 50, 20],
}
// Retângulos [x,y,w,h] e médias no JPEG original de 2592×1944, sem redimensionamento.
const REFERENCE = {
  image: 'reference/raw/Gradiente_expert_XP-800_keyboard_correct.jpg',
  J: { roi: [990, 1015, 30, 20], rgb: [142.055, 145.53667, 130.205] },
  K: { roi: [1120, 1015, 30, 20], rgb: [142.13333, 145.23333, 130.17] },
  shell: { roi: [980, 490, 120, 35], rgb: [127.88143, 131.61333, 125.16024] },
  keyShellRatio: { J: [1.111, 1.106, 1.040], K: [1.111, 1.103, 1.040] },
}
const measurements = []
const errors = []
const browser = await launchBrowser()
let page

async function measure(exposure) {
  const screenshot = `${OUTPUT}/tune-exposure-${exposure}.png`
  const buf = await page.screenshot({ path: screenshot })
  const rgb = await page.evaluate(async ({ b64, roi }) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D indisponível')
    ctx.drawImage(img, 0, 0)
    return Object.fromEntries(Object.entries(roi).map(([name, [x, y, w, h]]) => {
      const d = ctx.getImageData(x, y, w, h).data
      let r = 0, g = 0, b = 0
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2] }
      return [name, [r / (w * h), g / (w * h), b / (w * h)]]
    }))
  }, { b64: buf.toString('base64'), roi: ROI })
  const keyShellRatio = Object.fromEntries(['J', 'K', 'L'].map((key) =>
    [key, rgb[key].map((channel, i) => channel / rgb.shell[i])]))
  measurements.push({ exposure, screenshot, rgb, keyShellRatio })
  console.log(`exposure ${exposure}: ${Object.entries(rgb).map(([name, channels]) =>
    `${name} rgb(${channels.map(Math.round).join(', ')})`).join(' | ')}`)
  console.log(`  tecla/casco: ${Object.entries(keyShellRatio).map(([key, channels]) =>
    `${key} ${channels.map((v) => v.toFixed(3)).join('/')}`).join(' | ')}`)
}

try {
  await mkdir(OUTPUT, { recursive: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(URL_, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__msxReady === true, null, { timeout: 60_000 })
  await page.evaluate((pose) => {
    window.__msx.cameraRig.setAutoRotate(false)
    window.__msxHud.setChromeVisible(false)
    window.__msx.interactions.setPower(false)
    window.__msxCamera(pose)
    window.__msx.engine.requestRender(3)
  }, POSE)
  await page.waitForTimeout(5500)

  console.log('Referência fotográfica: J/casco 1.111/1.106/1.040; K/casco 1.111/1.103/1.040.')
  console.log('Comparação de aparência sRGB; exposição, flash e tone mapping impedem inferir albedo ou um alvo absoluto.')
  for (const exp of [1.0, 0.85, 0.72, 0.6]) {
    await page.evaluate((e) => {
      window.__msx.postFX.setExposure(e)
      // Mutação externa precisa reapresentar o quadro quando a cena está parada.
      window.__msx.engine.requestRender(2)
    }, exp)
    await page.waitForTimeout(700)
    await measure(exp)
  }
  await writeFile(`${OUTPUT}/tune-exposure.json`, JSON.stringify({
    url: URL_, pose: POSE, power: 'off', viewport: [1280, 720], roi: ROI, reference: REFERENCE,
    method: 'Displayed sRGB; mixedHistorical includes gaps/bevels. Material albedo is not a pixel target.',
    measurements, errors,
  }, null, 2))
  if (errors.length > 0) {
    console.error(`Erros no console: ${[...new Set(errors)].join(' | ')}`)
    process.exitCode = 1
  }
} catch (error) {
  console.error(`✗ calibração da exposição falhou: ${String(error)}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
