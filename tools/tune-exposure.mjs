// Screenshot → data URL → decode in-page → ROI mean. No native deps, WebGL-safe.
import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__msxReady === true, { timeout: 60_000 })
await page.evaluate(() => {
  window.__msx.cameraRig.setAutoRotate?.(false)
  window.__msxHud?.setChromeVisible(false)
  window.__msx.interactions.setPower(true)
  window.__msxCamera({ azimuth: 12, elevation: 55, distance: 0.45, target: [0, 0.015, 0.26] })
})
await page.waitForTimeout(4500)

const measure = async () => {
  const buf = await page.screenshot({ clip: { x: 540, y: 360, width: 80, height: 50 } })
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let r = 0, g = 0, b = 0
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2] }
    const n = d.length / 4
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
  }, buf.toString('base64'))
}

for (const exp of [1.0, 0.85, 0.72, 0.6]) {
  await page.evaluate((e) => {
    window.__msx.postFX.setExposure(e)
    // Mutação externa que o loop não enxerga: com render-on-demand a cena parada
    // não reapresentaria o quadro com a exposição nova.
    window.__msx.engine.requestRender?.(2)
  }, exp)
  await page.waitForTimeout(700)
  const rgb = await measure()
  console.log(`exposure ${exp}: rgb(${rgb.join(', ')})  alvo rgb(184, 181, 172)`)
}
await browser.close()
