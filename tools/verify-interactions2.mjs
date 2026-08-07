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
  // Force the narrow boundary that the coarse 2% publication cadence used to miss.
  // TS-private fields are intentionally inspected elsewhere in this probe too.
  itx.crt.warmth = 0.99
  itx.publish()
  itx.crt.warmth = 0.996
  itx.update(0)
  o.readyWarmth = S().power.warmth
  o.directReadyWarmth = itx.crt.power.warmth
  o.powerOn = S().power.on
  o.emulator = S().emulator

  // Typing must reach the active screen source as real down/up pairs.
  const typedCodes = ['KeyP', 'KeyR', 'KeyI', 'KeyN', 'KeyT']
  const typedEvents = []
  const typedScreen = itx.screen
  const originalTypedSendKey = typedScreen?.sendKey
  if (typedScreen && typeof originalTypedSendKey === 'function') {
    typedScreen.sendKey = function (code, down) {
      typedEvents.push([code, down])
      return originalTypedSendKey.call(this, code, down)
    }
  }
  try {
    for (const code of typedCodes) { itx.tapKey(code); await wait(140) }
    await wait(100)
  } finally {
    if (typedScreen && typeof originalTypedSendKey === 'function') {
      typedScreen.sendKey = originalTypedSendKey
    }
  }
  o.typedEvents = typedEvents

  // A physical key is owned once: repeats stay inside the bridge, while Ctrl shortcuts
  // that were never captured remain available to the browser.
  const physicalEvents = []
  const downstream = []
  const physicalScreen = itx.screen
  const originalPhysicalSendKey = physicalScreen?.sendKey
  const observe = (event) => downstream.push([event.type, event.code])
  document.addEventListener('keydown', observe)
  document.addEventListener('keyup', observe)
  if (physicalScreen && typeof originalPhysicalSendKey === 'function') {
    physicalScreen.sendKey = function (code, down) {
      physicalEvents.push([code, down])
      return originalPhysicalSendKey.call(this, code, down)
    }
  }
  try {
    const down = new KeyboardEvent('keydown', {
      code: 'Space', key: ' ', bubbles: true, cancelable: true,
    })
    const repeat = new KeyboardEvent('keydown', {
      code: 'Space', key: ' ', repeat: true, bubbles: true, cancelable: true,
    })
    const textEntry = document.createElement('input')
    document.body.append(textEntry)
    document.body.dispatchEvent(down)
    textEntry.dispatchEvent(repeat)
    await wait(80)
    textEntry.dispatchEvent(new KeyboardEvent('keyup', {
      code: 'Space', key: ' ', bubbles: true, cancelable: true,
    }))
    textEntry.remove()
    await wait(180)
    document.body.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyA', key: 'a', ctrlKey: true, bubbles: true, cancelable: true,
    }))
    document.body.dispatchEvent(new KeyboardEvent('keyup', {
      code: 'KeyA', key: 'a', bubbles: true, cancelable: true,
    }))
    o.physicalDefaultsPrevented = down.defaultPrevented && repeat.defaultPrevented
  } finally {
    document.removeEventListener('keydown', observe)
    document.removeEventListener('keyup', observe)
    if (physicalScreen && typeof originalPhysicalSendKey === 'function') {
      physicalScreen.sendKey = originalPhysicalSendKey
    }
  }
  o.physicalEvents = physicalEvents
  o.downstreamKeys = downstream

  // Reset releases the emulated key immediately, but the browser stroke may still be
  // held. Repeats stay captured; a fresh non-repeat can replace the tombstone.
  const lifecycleDownstream = []
  const observeLifecycle = (event) => lifecycleDownstream.push([event.type, event.code])
  document.addEventListener('keydown', observeLifecycle)
  document.addEventListener('keyup', observeLifecycle)
  const lifecycleDown = new KeyboardEvent('keydown', {
    code: 'ArrowDown', key: 'ArrowDown', bubbles: true, cancelable: true,
  })
  const lifecycleRepeat = new KeyboardEvent('keydown', {
    code: 'ArrowDown', key: 'ArrowDown', repeat: true, bubbles: true, cancelable: true,
  })
  const lifecycleFresh = new KeyboardEvent('keydown', {
    code: 'ArrowDown', key: 'ArrowDown', bubbles: true, cancelable: true,
  })
  document.body.dispatchEvent(lifecycleDown)
  itx.fireReset()
  const tombstoned = itx.physicalKeys.get('ArrowDown')?.released === true
  document.body.dispatchEvent(lifecycleRepeat)
  document.body.dispatchEvent(lifecycleFresh)
  const renewed = itx.physicalKeys.get('ArrowDown')?.released === false
  document.body.dispatchEvent(new KeyboardEvent('keyup', {
    code: 'ArrowDown', key: 'ArrowDown', bubbles: true, cancelable: true,
  }))
  document.removeEventListener('keydown', observeLifecycle)
  document.removeEventListener('keyup', observeLifecycle)
  o.lifecycleOwnership = {
    tombstoned,
    renewed,
    cleared: !itx.physicalKeys.has('ArrowDown'),
    defaultsPrevented:
      lifecycleDown.defaultPrevented &&
      lifecycleRepeat.defaultPrevented &&
      lifecycleFresh.defaultPrevented,
    downstream: lifecycleDownstream,
  }

  // Browser/OS cancellation releases the gesture but must not turn into a click.
  const picker = itx.picker
  const voltageBeforeCancel = itx.voltage240
  if (picker && itx.voltageSelector) {
    picker.activeHit = {
      object: itx.voltageSelector,
      partId: 'voltage-selector',
      label: 'Seletor de voltagem',
      cursor: 'pointer',
      keyCode: undefined,
      instanceId: undefined,
      point: new window.__msx.three.Vector3(),
      distance: 0,
      userData: itx.voltageSelector.userData,
    }
    picker.activePointerId = 77
    picker.activeDragged = false
    picker.onPointerCancel(new PointerEvent('pointercancel', { pointerId: 77 }))
  }
  o.cancelPreservedVoltage = itx.voltage240 === voltageBeforeCancel

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
check('I3e', 'CRT publica estado pronto', out.readyWarmth >= 0.995, `publicado=${out.readyWarmth.toFixed(3)} direto=${out.directReadyWarmth.toFixed(3)}`)
check('I3c', 'fonte de tela ativa', out.emulator === 'webmsx' || out.emulator === 'procedural', String(out.emulator))
const expectedTypedEvents = ['KeyP', 'KeyR', 'KeyI', 'KeyN', 'KeyT']
  .flatMap((code) => [[code, true], [code, false]])
check(
  'I6',
  'tapKey envia pares reais ao emulador',
  JSON.stringify(out.typedEvents) === JSON.stringify(expectedTypedEvents),
  JSON.stringify(out.typedEvents),
)
check(
  'I6a',
  'tecla física captura repetição uma única vez',
  out.physicalDefaultsPrevented === true &&
    JSON.stringify(out.physicalEvents) === JSON.stringify([['Space', true], ['Space', false]]),
  JSON.stringify(out.physicalEvents),
)
check(
  'I6b',
  'atalho Ctrl não capturado continua no navegador',
  JSON.stringify(out.downstreamKeys) === JSON.stringify([['keydown', 'KeyA'], ['keyup', 'KeyA']]),
  JSON.stringify(out.downstreamKeys),
)
check(
  'I6c',
  'reset preserva posse física até keyup ou novo keydown',
  out.lifecycleOwnership?.tombstoned === true &&
    out.lifecycleOwnership?.renewed === true &&
    out.lifecycleOwnership?.cleared === true &&
    out.lifecycleOwnership?.defaultsPrevented === true &&
    out.lifecycleOwnership?.downstream?.length === 0,
  JSON.stringify(out.lifecycleOwnership),
)
check('I7', 'pointercancel não aciona clique', out.cancelPreservedVoltage === true)
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

// Última sonda: destrutiva apenas para esta página descartável. Um PostFX quebrado
// precisa parar o motor e marcar a saúde como falsa, nunca virar render direto silencioso.
const renderFailure = await page.evaluate(async () => {
  const { engine, postFX } = window.__msx
  postFX.render = () => { throw new Error('__verify_render_failure__') }
  engine.requestRender(1)
  await new Promise((resolve) => setTimeout(resolve, 150))
  return { healthy: engine.isHealthy }
})
check('I10', 'falha do PostFX fecha o render', renderFailure.healthy === false)

const unexpectedErrors = errs.filter((error) => !error.includes('__verify_render_failure__'))
check(
  'I0',
  'sem erros inesperados no console',
  unexpectedErrors.length === 0,
  [...new Set(unexpectedErrors)].slice(0, 3).join(' | '),
)

const fails = R.filter((r) => !r.pass).length
console.log(`\n${R.length - fails}/${R.length} PASS`)
await browser.close()
process.exit(fails ? 1 : 0)
