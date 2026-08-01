// Press each special-profile key class and measure ALL instance Y deltas.
import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
page.on('pageerror', (e) => console.error('pageerror:', String(e)))
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__msxReady === true, { timeout: 60_000 })

const CODES = ['Enter', 'ArrowUp', 'ArrowLeft', 'F1', 'Numpad7', 'ShiftLeft', 'Escape', 'ControlLeft', 'CapsLock']
const out = await page.evaluate(async (codes) => {
  const { scene, interactions, three } = window.__msx
  const meshes = []
  scene.traverse((o) => { if (o.isInstancedMesh && o.name?.startsWith('teclas')) meshes.push(o) })
  const m = new three.Matrix4()
  const pos = new three.Vector3(), quat = new three.Quaternion(), scl = new three.Vector3()
  const snap = () => {
    const rows = []
    for (const mesh of meshes) for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m); m.decompose(pos, quat, scl)
      rows.push({ mesh: mesh.name, i, y: pos.y, qx: quat.x, qz: quat.z })
    }
    return rows
  }
  const results = []
  for (const code of codes) {
    const before = snap()
    interactions.pressKey(code)
    await new Promise((r) => setTimeout(r, 350))
    const during = snap()
    interactions.releaseKey(code)
    await new Promise((r) => setTimeout(r, 500))
    const after = snap()
    const deltas = []
    for (let k = 0; k < before.length; k++) {
      const dy = during[k].y - before[k].y
      const dyAfter = after[k].y - before[k].y
      if (Math.abs(dy) > 1e-5 || Math.abs(dyAfter) > 1e-5)
        deltas.push({ mesh: during[k].mesh, i: during[k].i, dy: +dy.toFixed(5), dyAfter: +dyAfter.toFixed(5) })
    }
    results.push({ code, deltas })
  }
  return results
}, CODES)
console.log(JSON.stringify(out, null, 1))
await browser.close()
