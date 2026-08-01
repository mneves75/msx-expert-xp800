// Visual + numeric key-travel probe against PRODUCTION.
import { chromium } from 'playwright'
// Point it at your deploy with the first argument or MSX_PROD_URL.
const URL_ = process.argv[2] ?? process.env.MSX_PROD_URL
if (!URL_) {
  console.error('Usage: node tools/probe-key-prod.mjs <deployed-url>  (or set MSX_PROD_URL)')
  process.exit(2)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
await page.goto(URL_, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__msxReady === true, { timeout: 60_000 })
await page.evaluate(() => {
  window.__msx.cameraRig.setAutoRotate?.(false)
  window.__msxHud?.setChromeVisible?.(false)
  // Tight macro on G/H/J from a low angle where 2.6mm reads clearly.
  window.__msxCamera({ azimuth: 5, elevation: 18, distance: 0.13, target: [-0.045, 0.012, 0.26] })
})
await page.waitForTimeout(1800)
await page.screenshot({ path: 'shots/probe/prod-rest.png' })

const num = await page.evaluate(async () => {
  const { scene, interactions, three } = window.__msx
  const meshes = []
  scene.traverse((o) => { if (o.isInstancedMesh && o.name?.startsWith('teclas')) meshes.push(o) })
  const m = new three.Matrix4(), p = new three.Vector3(), q = new three.Quaternion(), s = new three.Vector3()
  const snap = () => {
    const rows = []
    for (const mesh of meshes) for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m); m.decompose(p, q, s); rows.push(p.y)
    }
    return rows
  }
  const before = snap()
  interactions.pressKey('KeyG')
  await new Promise((r) => setTimeout(r, 450))
  const during = snap()
  let dy = 0
  for (let k = 0; k < before.length; k++) if (Math.abs(during[k] - before[k]) > 1e-5) dy = during[k] - before[k]
  return { dy }
})
await page.screenshot({ path: 'shots/probe/prod-held.png' })
await page.evaluate(async () => {
  window.__msx.interactions.releaseKey('KeyG')
  await new Promise((r) => setTimeout(r, 600))
})
await page.screenshot({ path: 'shots/probe/prod-released.png' })

// Also: physical keyboard event path (what the user actually does).
await page.keyboard.down('KeyH')
await page.waitForTimeout(450)
await page.screenshot({ path: 'shots/probe/prod-phys-held.png' })
await page.keyboard.up('KeyH')
await page.waitForTimeout(600)
await page.screenshot({ path: 'shots/probe/prod-phys-released.png' })

console.log(JSON.stringify({ url: URL_, dyOnPress: num.dy, consoleErrors: [...new Set(errs)].slice(0, 5) }))
await browser.close()
