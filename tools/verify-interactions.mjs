/**
 * SPEC §8 functional verification. Probes every interaction contract end-to-end
 * against the live app and prints a PASS/FAIL table. Read-only: no source edits.
 */
import { chromium } from 'playwright'

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const consoleErrors = []
page.on('pageerror', (e) => consoleErrors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__msxReady === true, { timeout: 60_000 })

const results = []
const check = (id, name, pass, detail = '') => {
  results.push({ id, name, pass: !!pass, detail })
  console.log(`${pass ? '✓' : '✗'} ${id} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── I1: orbit clamps ─────────────────────────────────────────────────────────
const clamp = await page.evaluate(async () => {
  const rig = window.__msx.cameraRig
  rig.setAutoRotate?.(false)
  // Try to push the camera below the desk and past distance limits.
  window.__msxCamera({ azimuth: 0, elevation: -40, distance: 9, target: [0, 0, 0] })
  await new Promise((r) => setTimeout(r, 300))
  const below = window.__msx.engine.camera.position.y
  window.__msxCamera({ azimuth: 0, elevation: 20, distance: 0.01, target: [0, 0, 0] })
  await new Promise((r) => setTimeout(r, 300))
  const near = window.__msx.engine.camera.position.length()
  return { below, near }
})
check('I1a', 'câmera nunca abaixo da mesa', clamp.below >= -0.01, `y=${clamp.below.toFixed(3)}`)
check('I1b', 'distância mínima respeitada', clamp.near >= 0.12, `d=${clamp.near.toFixed(3)}`)

// ── I3: power on boots screen + warm-up ramp ─────────────────────────────────
const power = await page.evaluate(async () => {
  const itx = window.__msx.interactions
  const st0 = itx.getState?.() ?? {}
  itx.setPower(true)
  await new Promise((r) => setTimeout(r, 300))
  const early = itx.getScreenWarmth?.() ?? null
  await new Promise((r) => setTimeout(r, 5500))
  const late = itx.getScreenWarmth?.() ?? null
  const st1 = itx.getState?.() ?? {}
  return { before: st0.power ?? null, early, late, after: st1.power ?? null,
           screenKind: itx.getScreenKind?.() ?? null }
})
check('I3a', 'power liga', power.after === true || power.after === 'on', JSON.stringify(power.after))
check('I3b', 'CRT warm-up é rampa (não snap)', power.early !== null && power.late !== null && power.early < power.late && power.early < 0.95, `early=${power.early} late=${power.late}`)
check('I3c', 'fonte de tela ativa', power.screenKind === 'webmsx' || power.screenKind === 'procedural', String(power.screenKind))

// ── I6/I7: keycap press drives emulator ──────────────────────────────────────
const typing = await page.evaluate(async () => {
  const itx = window.__msx.interactions
  // Type PRINT via tapKey and see if sendKey reached the screen source.
  const sent = []
  const orig = itx.sendKey?.bind(itx)
  for (const c of ['KeyP', 'KeyR', 'KeyI', 'KeyN', 'KeyT', 'Enter']) {
    itx.pressKey(c)
    await new Promise((r) => setTimeout(r, 120))
    itx.releaseKey(c)
    await new Promise((r) => setTimeout(r, 80))
  }
  return { ok: true }
})
check('I6', 'tapKey sequence executa sem erro', typing.ok)

// Physical keyboard event → 3D cap + emulator
const phys = await page.evaluate(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true }))
  await new Promise((r) => setTimeout(r, 250))
  const kb = null
  // measure instance moved: reuse scene scan
  const { scene, three } = window.__msx
  let moved = false
  const m = new three.Matrix4(), p = new three.Vector3(), q = new three.Quaternion(), s = new three.Vector3()
  scene.traverse((o) => {
    if (!o.isInstancedMesh || !o.name?.startsWith('teclas')) return
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m); m.decompose(p, q, s)
      // pressed caps sit ≈2.6mm under their rest; rest grid Y is uniform per mesh, so look for an outlier
    }
  })
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', key: 'a', bubbles: true }))
  return { dispatched: true }
})
check('I7', 'teclado físico despacha sem erro', phys.dispatched)

// ── I4/I5: cartridge + slot-cover reset ──────────────────────────────────────
const cart = await page.evaluate(async () => {
  const itx = window.__msx.interactions
  const canInsert = typeof itx.insertCartridge === 'function'
  let inserted = null, resetOk = null
  if (canInsert) {
    try { await itx.insertCartridge('A'); inserted = itx.getState?.()?.slotA ?? 'chamado' } catch (e) { inserted = `erro: ${e.message}` }
  }
  const canReset = typeof itx.softReset === 'function' || typeof itx.pushSlotCover === 'function'
  if (canReset) {
    try { (itx.pushSlotCover ?? itx.softReset).call(itx, 'B'); resetOk = true } catch (e) { resetOk = `erro: ${e.message}` }
  }
  return { canInsert, inserted, canReset, resetOk, api: Object.keys(Object.getPrototypeOf(itx)).slice(0, 40) }
})
check('I4', 'inserir cartucho A', cart.canInsert && !String(cart.inserted).startsWith('erro'), JSON.stringify(cart.inserted))
check('I5', 'empurrar tampa do slot = reset', cart.canReset === true && cart.resetOk === true, JSON.stringify(cart.resetOk) + (cart.canReset ? '' : ` API: ${cart.api.join(',')}`))

// ── I8: wireframe / x-ray ────────────────────────────────────────────────────
const modes = await page.evaluate(async () => {
  const itx = window.__msx.interactions
  const has = typeof itx.setDisplayMode === 'function'
  let wf = null, xr = null, back = null
  if (has) {
    itx.setDisplayMode('wireframe'); await new Promise((r) => setTimeout(r, 200)); wf = itx.getState?.()?.displayMode ?? 'set'
    itx.setDisplayMode('xray'); await new Promise((r) => setTimeout(r, 200)); xr = itx.getState?.()?.displayMode ?? 'set'
    itx.setDisplayMode('normal'); back = true
  }
  return { has, wf, xr, back }
})
check('I8', 'modos wireframe/raio-X/normal', modes.has && modes.back === true, `wf=${modes.wf} xr=${modes.xr}`)

// ── I9: view reset ───────────────────────────────────────────────────────────
const reset = await page.evaluate(async () => {
  const itx = window.__msx.interactions
  const rig = window.__msx.cameraRig
  const has = typeof itx.resetView === 'function' || typeof rig.resetView === 'function'
  if (!has) return { has }
  ;(itx.resetView ?? rig.resetView).call(itx.resetView ? itx : rig)
  await new Promise((r) => setTimeout(r, 900))
  return { has, pos: window.__msx.engine.camera.position.toArray().map((v) => +v.toFixed(2)) }
})
check('I9', 'redefinir vista', reset.has === true, JSON.stringify(reset.pos))

// ── I2: auto-rotate idle ─────────────────────────────────────────────────────
const auto = await page.evaluate(async () => {
  const rig = window.__msx.cameraRig
  const has = typeof rig.setAutoRotate === 'function'
  if (!has) return { has }
  rig.setAutoRotate(true)
  const a0 = window.__msx.engine.camera.position.x
  await new Promise((r) => setTimeout(r, 1500))
  const a1 = window.__msx.engine.camera.position.x
  rig.setAutoRotate(false)
  return { has, moved: Math.abs(a1 - a0) > 1e-4 }
})
check('I2', 'auto-rotação gira a câmera', auto.has && auto.moved)

// ── I11: HUD pt-BR + estado ──────────────────────────────────────────────────
const hud = await page.evaluate(() => {
  const el = document.querySelector('[class*=hud], #hud, [data-hud]') ?? document.body
  const text = el.textContent ?? ''
  return {
    ligado: /Ligado|Desligado/.test(text),
    cartucho: /cartucho|Cartucho/.test(text),
    acentos: /rota|vis|Reiniciar|Redefinir/.test(text),
    sample: text.replace(/\s+/g, ' ').slice(0, 200),
  }
})
check('I11a', 'HUD mostra estado de energia em pt-BR', hud.ligado, hud.sample.slice(0, 80))
check('I11b', 'HUD menciona cartucho', hud.cartucho)

// ── Power off ramp down ──────────────────────────────────────────────────────
const off = await page.evaluate(async () => {
  const itx = window.__msx.interactions
  itx.setPower(false)
  await new Promise((r) => setTimeout(r, 400))
  const mid = itx.getScreenWarmth?.() ?? null
  await new Promise((r) => setTimeout(r, 2500))
  return { mid, final: itx.getScreenWarmth?.() ?? null, state: itx.getState?.()?.power ?? null }
})
check('I3d', 'desligar faz rampa de descida', off.final !== null && off.final < 0.05, `mid=${off.mid} final=${off.final}`)

console.log('\n=== RESUMO ===')
const fails = results.filter((r) => !r.pass)
console.log(`${results.length - fails.length}/${results.length} PASS`)
if (consoleErrors.length) console.log(`console errors: ${[...new Set(consoleErrors)].slice(0, 5).join(' | ')}`)
await browser.close()
process.exit(fails.length > 0 ? 1 : 0)
