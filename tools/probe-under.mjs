// What is actually under the keycaps? Hide caps, look, and measure heights.
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
await page.waitForTimeout(1500)

const info = await page.evaluate(() => {
  const { scene, three } = window.__msx
  // 1. Raycast straight down at a point between two key rows (world space).
  const ray = new three.Raycaster()
  const hits = (x, z) => {
    ray.set(new three.Vector3(x, 0.2, z), new three.Vector3(0, -1, 0))
    return ray.intersectObject(scene, true).slice(0, 4).map((h) => ({
      name: h.object.name || h.object.type, y: +h.point.y.toFixed(5),
    }))
  }
  // Keyboard occupies roughly x∈[-0.21,0.16], z∈[0.17,0.35] (world). Sample:
  const betweenRows = hits(-0.045, 0.262)   // gap between G-row and B-row (approx)
  const betweenCols = hits(-0.0355, 0.255)  // gap between two caps in a row
  const onCap = hits(-0.045, 0.255)

  // 2. Hide every cap instanced mesh to reveal what's under.
  scene.traverse((o) => { if (o.isInstancedMesh && o.name?.startsWith('teclas')) o.visible = false })
  return { betweenRows, betweenCols, onCap }
})
await page.waitForTimeout(400)
await page.screenshot({ path: 'shots/probe/sem-capas.png' })
// top view without caps
await page.evaluate(() => { window.__msxCamera({ azimuth: 10, elevation: 60, distance: 0.42, target: [0, 0.015, 0.26] }) })
await page.waitForTimeout(600)
await page.screenshot({ path: 'shots/probe/sem-capas-topo.png' })
console.log(JSON.stringify(info, null, 1))
await browser.close()
