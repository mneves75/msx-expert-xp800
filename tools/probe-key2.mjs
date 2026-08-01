// Numeric ground truth for the keycap press direction, straight from the scene graph.
import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__msxReady === true, { timeout: 60_000 })

const out = await page.evaluate(async () => {
  const { scene, interactions } = window.__msx
  // Find every InstancedMesh under the keyboard group and record world-space Y of each
  // instance of interest before/during/after a press.
  const meshes = []
  scene.traverse((o) => { if (o.isInstancedMesh) meshes.push(o) })

  const snapshot = () => {
    const m = new (Object.getPrototypeOf(meshes[0].matrixWorld).constructor)()
    const rows = []
    for (const mesh of meshes) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m)
        rows.push({ mesh: mesh.name || mesh.uuid.slice(0, 6), i, y: m.elements[13] })
      }
    }
    return rows
  }

  const before = snapshot()
  interactions.pressKey('KeyG')
  interactions.pressKey('Space')
  await new Promise((r) => setTimeout(r, 500))
  const during = snapshot()
  interactions.releaseKey('KeyG')
  interactions.releaseKey('Space')
  await new Promise((r) => setTimeout(r, 700))
  const after = snapshot()

  // Report only instances whose Y changed.
  const changed = []
  for (let k = 0; k < before.length; k++) {
    const dyDuring = during[k].y - before[k].y
    const dyAfter = after[k].y - before[k].y
    if (Math.abs(dyDuring) > 1e-5 || Math.abs(dyAfter) > 1e-5) {
      changed.push({ mesh: before[k].mesh, i: before[k].i,
        rest: +before[k].y.toFixed(5), dyDuring: +dyDuring.toFixed(5), dyAfter: +dyAfter.toFixed(5) })
    }
  }
  return { instancedMeshes: meshes.length, changed }
})
console.log(JSON.stringify(out, null, 2))
await browser.close()
