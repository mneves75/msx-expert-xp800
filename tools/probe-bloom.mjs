// Isolate the QWERTY wash: screenshot with bloom on vs off at identical pose.
import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__msxReady === true, { timeout: 60_000 })
await page.evaluate(() => {
  window.__msx.cameraRig.setAutoRotate?.(false)
  window.__msxHud?.setChromeVisible(false)
  window.__msx.interactions.setPower(true)
  window.__msxCamera({ azimuth: 12, elevation: 55, distance: 0.45, target: [0, 0.015, 0.26] })
})
await page.waitForTimeout(4500)
await page.screenshot({ path: 'shots/probe/bloom-on.png' })
await page.evaluate(() => { window.__msx.postFX.effects.bloom.blendMode.setOpacity(0) })
await page.waitForTimeout(500)
await page.screenshot({ path: 'shots/probe/bloom-off.png' })
// Also kill SSAO to check its contribution separately? No — restore and kill key light instead.
await page.evaluate(() => { window.__msx.postFX.effects.bloom.blendMode.setOpacity(1) })
await page.waitForTimeout(300)
const rig = await page.evaluate(() => {
  const L = window.__msx.engine ?? {}
  const lighting = window.__msx.lighting ?? null
  return lighting === null ? 'no lighting handle' : 'has handle'
})
console.log(rig)
await browser.close()
