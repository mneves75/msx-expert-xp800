// Reproduce the "levitating keycap" bug: hold G + Space, capture macro shots,
// and dump the live instance matrix Y of the pressed cap vs its seat.
import { chromium } from 'playwright'

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
page.on('pageerror', (e) => console.error('pageerror:', String(e)))
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForFunction(() => window.__msxReady === true, { timeout: 60_000 })

await page.evaluate(() => {
  window.__msx?.cameraRig?.setAutoRotate?.(false)
  window.__msxHud?.setChromeVisible(false)
  window.__msxCamera({ azimuth: 8, elevation: 30, distance: 0.2, target: [-0.02, 0.02, 0.25] })
})
await page.waitForTimeout(1200)
await page.screenshot({ path: 'shots/probe/key-rest.png' })

// Hold two keys and read back the runtime state.
const state = await page.evaluate(async () => {
  const itx = window.__msx?.interactions
  itx?.pressKey?.('KeyG')
  itx?.pressKey?.('Space')
  await new Promise((r) => setTimeout(r, 400)) // let the spring settle at full stroke
  const kb = window.__msx?.modules?.keyboard ?? null
  return { hasKb: kb !== null }
})
console.log('runtime:', JSON.stringify(state))
await page.waitForTimeout(200)
await page.screenshot({ path: 'shots/probe/key-pressed.png' })

// Release, settle, capture again.
await page.evaluate(() => {
  const itx = window.__msx?.interactions
  itx?.releaseKey?.('KeyG')
  itx?.releaseKey?.('Space')
})
await page.waitForTimeout(600)
await page.screenshot({ path: 'shots/probe/key-released.png' })

await browser.close()
console.log('done → shots/probe/')
