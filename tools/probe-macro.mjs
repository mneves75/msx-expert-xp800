// Capture the exact grazing macro the defect was seen at, on dev.
import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__msxReady === true, { timeout: 60_000 })
await page.evaluate(() => {
  window.__msx.cameraRig.setAutoRotate?.(false)
  window.__msxHud?.setChromeVisible?.(false)
  window.__msxCamera({ azimuth: 5, elevation: 18, distance: 0.13, target: [-0.045, 0.012, 0.26] })
})
await page.waitForTimeout(1800)
await page.screenshot({ path: 'shots/probe/macro-depois.png' })
await browser.close()
console.log('ok')
