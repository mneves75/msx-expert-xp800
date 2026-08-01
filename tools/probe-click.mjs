// Reproduce the user's actual gesture: hover + mousedown on a keycap, hold, screenshot.
import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
page.on('pageerror', (e) => console.error('pageerror:', String(e)))
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__msxReady === true, { timeout: 60_000 })
await page.evaluate(() => {
  window.__msx.cameraRig.setAutoRotate?.(false)
  window.__msxHud?.setChromeVisible(false)
  window.__msxCamera({ azimuth: 10, elevation: 42, distance: 0.24, target: [-0.02, 0.01, 0.25] })
})
await page.waitForTimeout(1500)

// Project the G key's world position to screen coords so the click lands exactly on it.
const pt = await page.evaluate(() => {
  const { scene, engine, three } = window.__msx
  let hit = null
  scene.traverse((o) => {
    if (hit) return
    if (o.name?.startsWith('teclas-') || o.name === 'teclado-proxy') return
    const ud = o.userData
    if (ud?.partId === 'keyboard-key' && ud?.keyCode === 'KeyG') hit = o
  })
  // Fallback: find any object tagged KeyG (proxy meshes included)
  if (!hit) scene.traverse((o) => { if (!hit && o.userData?.keyCode === 'KeyG') hit = o })
  if (!hit) return null
  const v = new three.Vector3()
  hit.getWorldPosition(v)
  v.project(engine.camera)
  return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, name: hit.name }
})
console.log('target:', JSON.stringify(pt))
if (!pt) { await browser.close(); process.exit(1) }

await page.mouse.move(pt.x, pt.y)
await page.waitForTimeout(400)
await page.screenshot({ path: 'shots/probe/click-hover.png' })
await page.mouse.down()
await page.waitForTimeout(450)
await page.screenshot({ path: 'shots/probe/click-held.png' })
await page.mouse.up()
await page.waitForTimeout(600)
await page.screenshot({ path: 'shots/probe/click-after.png' })
await browser.close()
console.log('done')
