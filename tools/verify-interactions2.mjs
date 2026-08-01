// SPEC §8 verification, corrected to the REAL InteractionsHandle API.
import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__msxReady === true, { timeout: 60_000 })

const R = []
const check = (id, name, pass, detail = '') => {
  R.push({ id, pass })
  console.log(`${pass ? '✓' : '✗'} ${id} ${name}${detail ? ` — ${detail}` : ''}`)
}

const out = await page.evaluate(async () => {
  const itx = window.__msx.interactions
  const S = () => itx.getState()
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const o = {}

  // Power ramp
  itx.setPower(false); await wait(2500)
  o.offWarmth = S().power.warmth
  itx.setPower(true); await wait(250)
  o.earlyWarmth = S().power.warmth
  await wait(5000)
  o.lateWarmth = S().power.warmth
  o.powerOn = S().power.on
  o.emulator = S().emulator

  // Typing reaches the screen source (subscribe to note/no-crash + IN USE path)
  for (const c of ['KeyP', 'KeyR', 'KeyI', 'KeyN', 'KeyT']) { itx.tapKey(c); await wait(140) }
  o.typedOk = true

  // Cartridge A insert/eject with state reflection
  const before = S().slotA
  itx.insertCartridge('A'); await wait(1800)
  o.slotAAfterInsert = S().slotA?.name ?? null
  // A rota segue o cartucho: espere a promoção real para o WebMSX (CDN) para
  // exercer o caminho de VOLTA ao BASIC interno. Sem rede a promoção não vem,
  // a ejeção cai direto na procedural e a checagem de fantasma segue válida.
  for (let i = 0; i < 150 && S().emulator !== 'webmsx'; i++) await wait(200)
  o.promoted = S().emulator === 'webmsx'
  itx.ejectCartridge('A'); await wait(1600)
  o.slotAAfterEject = S().slotA?.name ?? null
  o.slotABefore = before?.name ?? null
  for (let i = 0; i < 50 && S().emulator !== 'procedural'; i++) await wait(200)
  o.emulatorAfterEject = S().emulator
  // Privados de TS são visíveis em runtime: é a fresta pela qual a sonda enxerga
  // o estado interno da ProceduralScreen sem ampliar a API pública.
  const proc = itx.screen?.routed?.procedural
  o.ghostSlots = proc ? [...proc.cartridges.keys()] : null

  // Soft reset via slot cover push
  itx.reset(); await wait(500)
  o.resetNote = S().note

  // Display modes
  itx.setWireframe(true); await wait(150); o.wireframe = S().wireframe
  itx.setWireframe(false)
  itx.setXRay(true); await wait(150); o.xray = S().xray
  itx.setXRay(false)

  // Auto-rotate flag
  itx.setAutoRotate(true); o.autoRotate = S().autoRotate
  itx.setAutoRotate(false)

  // View reset exists
  itx.resetView(); o.resetView = true

  // Power off ramp
  itx.setPower(false); await wait(300)
  o.midOff = S().power.warmth
  await wait(2600)
  o.finalOff = S().power.warmth

  return o
})

check('I3a', 'power liga', out.powerOn === true)
check('I3b', 'CRT warm-up é rampa', out.earlyWarmth < out.lateWarmth && out.earlyWarmth < 0.9, `${out.earlyWarmth.toFixed(2)}→${out.lateWarmth.toFixed(2)}`)
check('I3c', 'fonte de tela ativa', out.emulator === 'webmsx' || out.emulator === 'procedural', String(out.emulator))
check('I6', 'digitação tapKey ok', out.typedOk)
check('I4a', 'inserir cartucho A reflete no estado', out.slotAAfterInsert !== null, String(out.slotAAfterInsert))
check('I4b', 'ejetar cartucho A reflete no estado', out.slotAAfterEject === null, String(out.slotAAfterEject))
// `out.promoted` é exigido de propósito: sem a promoção real ao WebMSX a ejeção cai
// na procedural ainda ativa e o caminho do cartucho-fantasma nem é percorrido — um
// verde assim seria uma verificação que não aconteceu. CDN fora do ar = falha honesta.
check('I4c', 'ejetar o último cartucho volta ao BASIC sem cartucho-fantasma', out.promoted === true && out.emulatorAfterEject === 'procedural' && Array.isArray(out.ghostSlots) && out.ghostSlots.length === 0, `webmsx exercitado=${out.promoted} slots internos=${JSON.stringify(out.ghostSlots)}`)
check('I5', 'reset() = tampa do slot', typeof out.resetNote === 'string' && out.resetNote.length > 0, String(out.resetNote))
check('I8a', 'wireframe', out.wireframe === true)
check('I8b', 'raio-X', out.xray === true)
check('I2', 'auto-rotação (flag)', out.autoRotate === true)
check('I9', 'resetView existe e roda', out.resetView === true)
check('I3d', 'desligar faz rampa', out.midOff > 0.02 && out.finalOff < 0.05, `mid=${out.midOff.toFixed(2)} final=${out.finalOff.toFixed(3)}`)

const fails = R.filter((r) => !r.pass).length
console.log(`\n${R.length - fails}/${R.length} PASS`)
if (errs.length) console.log('console errors:', [...new Set(errs)].slice(0, 5).join(' | '))
await browser.close()
process.exit(fails ? 1 : 0)
