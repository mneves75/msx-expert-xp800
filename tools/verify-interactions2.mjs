// SPEC §8 verification, corrected to the REAL InteractionsHandle API.
import { launchBrowser, targetUrl, WEBMSX_URL } from './browser.mjs'
const OFFLINE = process.argv.includes('--offline') || process.env.MSX_OFFLINE === '1'
const SOFTWARE = process.env.MSX_SOFTWARE_RENDERER === '1'
const ANIMATION_TIMEOUT = SOFTWARE ? 120_000 : 30_000
const browser = await launchBrowser(SOFTWARE ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])
try {
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const errs = []
const collectErrors = (target) => {
  target.on('pageerror', (error) => errs.push(String(error)))
  target.on('console', (message) => {
    const blockedScript = OFFLINE && message.location().url === WEBMSX_URL && /ERR_FAILED/.test(message.text())
    if (message.type() === 'error' && !blockedScript) errs.push(message.text())
  })
}
collectErrors(page)
let blockedCdn = 0
if (OFFLINE) await page.route(WEBMSX_URL, (route) => { blockedCdn += 1; return route.abort('failed') })
console.log(`Mode: ${OFFLINE ? 'offline — CDN blocked; fallback required' : 'online — real CDN promotion required'}`)
await page.goto(targetUrl(), { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__msxReady === true, null, { timeout: 60_000 })
// Functional CI keeps the real GPU pipeline and CSS viewport, at a smaller buffer.
// Default-resolution visual/performance evidence belongs to shoot.mjs/profile.mjs.
if (SOFTWARE) {
  const graphics = await page.evaluate(() => {
    const { engine } = window.__msx
    engine.capPixelRatio(0.25)
    const gl = engine.renderer.getContext()
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    return { renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown',
      width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, dpr: engine.renderer.getPixelRatio() }
  })
  if (!/swiftshader/i.test(graphics.renderer)) throw new Error('Requested SwiftShader renderer was not selected')
  console.log(`Functional software graphics: ${JSON.stringify(graphics)}`)
}

const R = []
const check = (id, name, pass, detail = '') => {
  R.push({ id, pass })
  console.log(`${pass ? '✓' : '✗'} ${id} ${name}${detail ? ` — ${detail}` : ''}`)
}

const out = await page.evaluate(async ({ offline, animationTimeout }) => {
  const itx = window.__msx.interactions
  const S = () => itx.getState()
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (predicate, label) => {
    const deadline = performance.now() + animationTimeout
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error(`Timed out: ${label}`)
      await wait(50)
    }
  }
  const o = {}

  // Power ramp
  itx.setPower(false)
  await until(() => S().power.warmth === 0, 'initial tube cooldown')
  o.offWarmth = S().power.warmth
  itx.setPower(true)
  await until(() => S().power.warmth > 0.02, 'warm-up begins')
  o.earlyWarmth = S().power.warmth
  await until(() => S().power.warmth > 0.95 && S().emulator !== null, 'warm-up finishes')
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
    for (const code of typedCodes) {
      itx.tapKey(code)
      await until(() => typedEvents.some(([key, down]) => key === code && !down),
        `${code} tap completes`)
    }
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
    await until(() => physicalEvents.some(([code, down]) => code === 'Space' && down),
      'Space contact closes')
    textEntry.dispatchEvent(new KeyboardEvent('keyup', {
      code: 'Space', key: ' ', bubbles: true, cancelable: true,
    }))
    textEntry.remove()
    await until(() => physicalEvents.some(([code, down]) => code === 'Space' && !down),
      'Space contact opens')
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
  if (!picker || !itx.voltageSelector) throw new Error('Cancellation test requires the real picker and voltage selector')
  {
    const hit = {
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
    const arm = () => {
      picker.activeHit = hit
      picker.activePointerId = 77
      picker.activeDragged = false
    }
    arm()
    picker.onPointerUp(new PointerEvent('pointerup', { pointerId: 77 }))
    o.voltagePositiveControl = itx.voltage240 !== voltageBeforeCancel
    arm()
    picker.onPointerUp(new PointerEvent('pointerup', { pointerId: 77 }))
    arm()
    picker.onPointerCancel(new PointerEvent('pointercancel', { pointerId: 77 }))
  }
  o.cancelPreservedVoltage = itx.voltage240 === voltageBeforeCancel

  // Cartridge A insert/eject with state reflection
  const before = S().slotA
  itx.insertCartridge('A')
  await until(() => itx.slots.get('A').phase === 'inserido', 'cartridge physically seated')
  o.slotAAfterInsert = S().slotA?.name ?? null
  await until(() => offline ? itx.screen.fallbackReason !== null : S().emulator === 'webmsx',
    offline ? 'blocked CDN activates fallback' : 'real WebMSX promotion')
  o.promoted = S().emulator === 'webmsx'
  o.fallbackWithCartridge = S().emulator === 'procedural' && S().slotA !== null
  itx.ejectCartridge('A')
  await until(() => itx.slots.get('A').phase === 'vazio' && S().emulator === 'procedural',
    'cartridge ejected and BASIC restored')
  o.slotAAfterEject = S().slotA?.name ?? null
  o.slotABefore = before?.name ?? null
  o.emulatorAfterEject = S().emulator
  // Privados de TS são visíveis em runtime: é a fresta pela qual a sonda enxerga
  // o estado interno da ProceduralScreen sem ampliar a API pública.
  const proc = itx.screen?.routed?.procedural
  o.ghostSlots = proc ? [...proc.cartridges.keys()] : null

  // Soft reset via slot cover push
  const resetSource = itx.screen
  if (!resetSource) throw new Error('Reset test requires a running screen')
  const originalReset = resetSource.reset
  let resetCalls = 0
  resetSource.reset = function () { resetCalls += 1; return originalReset.call(this) }
  try {
    itx.reset(); await wait(500)
    o.resetCalls = resetCalls
  } finally { resetSource.reset = originalReset }

  // Display modes
  itx.setWireframe(true); await wait(150); o.wireframe = S().wireframe
  itx.setWireframe(false)
  itx.setXRay(true); await wait(150); o.xray = S().xray
  itx.setXRay(false)

  // Auto-rotate flag
  itx.setAutoRotate(true); o.autoRotate = S().autoRotate
  itx.setAutoRotate(false)

  const camera = window.__msx.cameraRig
  const initialPose = camera.getPose()
  camera.jumpTo({ ...initialPose, azimuth: initialPose.azimuth + 25, distance: initialPose.distance * 1.2 })
  o.cameraChanged = JSON.stringify(camera.getPose()) !== JSON.stringify(initialPose)
  itx.resetView()
  o.resetView = JSON.stringify(camera.getPose()) === JSON.stringify(initialPose)

  // Power off ramp
  const beforeOff = S().power.warmth
  itx.setPower(false)
  await until(() => S().power.warmth < beforeOff, 'cooldown begins')
  o.midOff = S().power.warmth
  await until(() => S().power.warmth === 0, 'cooldown finishes')
  o.finalOff = S().power.warmth

  return o
}, { offline: OFFLINE, animationTimeout: ANIMATION_TIMEOUT })

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
check('I7', 'pointerup aciona seletor; pointercancel preserva a voltagem', out.voltagePositiveControl === true && out.cancelPreservedVoltage === true)
check('I4a', 'inserir cartucho A reflete no estado', out.slotAAfterInsert !== null, String(out.slotAAfterInsert))
check('I4b', 'ejetar cartucho A reflete no estado', out.slotAAfterEject === null, String(out.slotAAfterEject))
// `out.promoted` é exigido de propósito: sem a promoção real ao WebMSX a ejeção cai
// na procedural ainda ativa e o caminho do cartucho-fantasma nem é percorrido — um
// verde assim seria uma verificação que não aconteceu. CDN fora do ar = falha honesta.
if (OFFLINE) {
  check('I4offline', 'CDN bloqueada mantém fallback utilizável e ejeção limpa', blockedCdn > 0 && out.fallbackWithCartridge && !out.promoted && out.emulatorAfterEject === 'procedural' && Array.isArray(out.ghostSlots) && out.ghostSlots.length === 0, `requisições bloqueadas=${blockedCdn}`)
} else {
  check('I4c', 'ejetar o último cartucho volta do WebMSX ao BASIC sem cartucho-fantasma', out.promoted === true && out.emulatorAfterEject === 'procedural' && Array.isArray(out.ghostSlots) && out.ghostSlots.length === 0, `webmsx exercitado=${out.promoted} slots internos=${JSON.stringify(out.ghostSlots)}`)
}
check('I5', 'empurrar tampa chama reset da fonte uma vez', out.resetCalls === 1, `calls=${out.resetCalls}`)
check('I8a', 'wireframe', out.wireframe === true)
check('I8b', 'raio-X', out.xray === true)
check('I2', 'auto-rotação (flag)', out.autoRotate === true)
check('I9', 'resetView restaura uma pose realmente alterada', out.cameraChanged && out.resetView)
check('I3d', 'desligar faz rampa', out.midOff > 0.02 && out.finalOff < 0.05, `mid=${out.midOff.toFixed(2)} final=${out.finalOff.toFixed(3)}`)

// A rejected action must preserve the real state in both the readout and the HUD handle.
await page.selectOption('select[aria-label="Escolher o cartucho do slot A"]', 'arcade-vermelho')
await page.getByRole('button', { name: 'Inserir cartucho no slot A', exact: true }).click()
await page.waitForFunction(() => window.__msx.interactions.getState().slotA?.id === 'arcade-vermelho', null, { timeout: 5000 })
await page.selectOption('select[aria-label="Escolher o cartucho do slot B"]', 'arcade-vermelho')
const rejectedHud = await page.evaluate(() => {
  const { interactions, hud } = window.__msx
  const button = document.querySelector('button[aria-label="Inserir cartucho no slot B"]')
  if (!(button instanceof HTMLButtonElement) || !hud || typeof hud.render !== 'function') {
    throw new Error('HUD rejection test requires the actual controls and renderer')
  }
  const original = hud.render
  let renders = 0
  let publications = -1 // subscribe delivers the current snapshot immediately
  const unsubscribe = interactions.subscribe(() => { publications += 1 })
  hud.render = function (...args) { renders += 1; return original.apply(this, args) }
  try {
    button.click()
    const state = interactions.getState()
    const readout = [...document.querySelectorAll('.hud__readouts dt')]
      .find((element) => element.textContent === 'Slot B')?.nextElementSibling?.textContent
    return { slotA: state.slotA?.id, slotB: state.slotB, hudSlotB: hud.getState().slotB, readout, renders, publications }
  } finally {
    hud.render = original
    unsubscribe()
  }
})
check('I12', 'cartucho já usado é recusado sem inventar ocupação no HUD',
  rejectedHud.slotA === 'arcade-vermelho' && rejectedHud.slotB === null &&
  rejectedHud.hudSlotB === null && rejectedHud.readout === 'Sem cartucho', JSON.stringify(rejectedHud))
check('I12a', 'cada publicação redesenha o HUD uma única vez', rejectedHud.publications > 0 && rejectedHud.renders === rejectedHud.publications)
await page.evaluate(() => window.__msx.cameraRig.setAutoRotate(false))
await page.waitForFunction(() => {
  const { engine, cameraRig, interactions } = window.__msx
  return interactions.getState().power.warmth === 0 && cameraRig.isSettled &&
    interactions.slots.get('A').phase === 'inserido' && engine.framesRequested === 0 &&
    [...interactions.slots.values()].every((slot) => !slot.insertion.moving &&
      !slot.flap.moving && slot.approach.isSettled(1e-4))
}, null, { timeout: ANIMATION_TIMEOUT })
const idleFrames = await page.evaluate(async (animationTimeout) => {
  const { engine } = window.__msx
  const deadline = performance.now() + animationTimeout
  let before = engine.renderer.info.render.frame
  while (performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const after = engine.renderer.info.render.frame
    if (after === before) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return engine.renderer.info.render.frame - after
    }
    before = after
  }
  throw new Error(`Powered-off scene did not settle within ${animationTimeout} ms`)
}, ANIMATION_TIMEOUT)
check('I12b', 'cartucho assentado com energia desligada deixa o render descansar', idleFrames === 0, `submissões=${idleFrames}`)
await page.getByRole('button', { name: 'Ejetar o cartucho do slot A', exact: true }).click()

// Keycap travel replaces the four incident-specific key probes. Measure real instances.
const keyHeights = () => page.evaluate(() => {
  const { scene, three } = window.__msx
  const matrix = new three.Matrix4()
  const heights = []
  scene.traverse((object) => {
    if (!object.isInstancedMesh || !object.name.startsWith('teclas')) return
    for (let i = 0; i < object.count; i++) {
      object.getMatrixAt(i, matrix)
      heights.push(matrix.elements[13])
    }
  })
  return heights
})
const travelResult = (before, during, after) => {
  if (!before.length || before.length !== during.length || before.length !== after.length) return false
  const deltas = during.map((y, i) => y - before[i])
  return deltas.some((dy) => dy < -0.001) && deltas.every((dy) => dy < 0.00001) &&
    after.every((y, i) => Math.abs(y - before[i]) < 0.00001)
}
const waitForKeyHeights = async (before, pressed) => {
  const deadline = Date.now() + (SOFTWARE ? ANIMATION_TIMEOUT : 15_000)
  while (Date.now() < deadline) {
    const heights = await keyHeights()
    if (before.length && heights.length === before.length && (pressed
      ? heights.some((y, i) => y - before[i] < -0.001)
      : heights.every((y, i) => Math.abs(y - before[i]) < 0.00001))) return heights
    await page.waitForTimeout(50)
  }
  throw new Error(`Key geometry did not ${pressed ? 'depress' : 'return to its seat'}`)
}
for (const code of ['KeyG', 'Space', 'Enter', 'ArrowUp', 'ArrowLeft', 'F1', 'Numpad7', 'NumpadEqual', 'ShiftLeft', 'Escape', 'ControlLeft', 'CapsLock']) {
  const before = await keyHeights()
  await page.evaluate((key) => window.__msx.interactions.pressKey(key), code)
  const during = await waitForKeyHeights(before, true)
  await page.evaluate((key) => window.__msx.interactions.releaseKey(key), code)
  const after = await waitForKeyHeights(before, false)
  check(`I13:${code}`, 'capa afunda e retorna ao assento', travelResult(before, during, after))
}

// Positive pointer proof: project the real G proxy, then drive actual mouse events.
await page.evaluate(() => {
  window.__msx.hud.setChromeVisible(false)
  window.__msxCamera({ azimuth: 10, elevation: 42, distance: 0.24, target: [-0.02, 0.01, 0.25] })
})
await page.waitForFunction(() => window.__msx.cameraRig.isSettled, null, { timeout: 15_000 })
const keyPoint = await page.evaluate(() => {
  const { scene, engine, three } = window.__msx
  let key = null
  scene.traverse((object) => { if (!key && object.userData?.keyCode === 'KeyG') key = object })
  if (!key) throw new Error('G key proxy missing')
  const point = key.getWorldPosition(new three.Vector3()).project(engine.camera)
  return { x: (point.x + 1) * innerWidth / 2, y: (1 - point.y) * innerHeight / 2 }
})
const pointerBefore = await keyHeights()
await page.mouse.move(keyPoint.x, keyPoint.y)
await page.mouse.down()
const pointerDuring = await waitForKeyHeights(pointerBefore, true)
const pickedKey = await page.evaluate(() => window.__msx.interactions.picker.activeHit?.keyCode)
await page.mouse.up()
const pointerAfter = await waitForKeyHeights(pointerBefore, false)
check('I14', 'ponteiro real pressiona G e solta sua capa', pickedKey === 'KeyG' && travelResult(pointerBefore, pointerDuring, pointerAfter))
await page.evaluate(() => { window.__msx.cameraRig.resetPose(true); window.__msx.hud.setChromeVisible(true) })

// O painel mobile precisa continuar fechável depois de rolar: o cabeçalho fica visível,
// tocar fora fecha e o grip aceita um gesto curto para baixo.
const mobilePage = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
})
collectErrors(mobilePage)
await mobilePage.goto(targetUrl(), { waitUntil: 'networkidle' })
await mobilePage.waitForFunction(() => window.__msxReady === true, null, { timeout: 60_000 })
if (SOFTWARE) await mobilePage.evaluate(() => window.__msx.engine.capPixelRatio(0.25))
await mobilePage.click('.hud__sheet-toggle')
await mobilePage.waitForFunction(() => {
  const panel = document.querySelector('.hud__console')
  if (!(panel instanceof HTMLElement)) return false
  const rect = panel.getBoundingClientRect()
  return rect.top >= 0 && rect.bottom <= innerHeight + 1 &&
    panel.getAnimations().every((animation) => animation.playState === 'finished')
}, null, { timeout: 15_000 })
const mobileSheet = await mobilePage.evaluate(() => {
  const panel = document.querySelector('.hud__console')
  const close = document.querySelector('.hud__sheet-close')
  if (!(panel instanceof HTMLElement) || !(close instanceof HTMLElement)) return null
  panel.scrollTop = 800
  const rect = close.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return {
    scrollTop: panel.scrollTop,
    closeVisible: rect.bottom > 0 && rect.top < innerHeight,
    closeTargetable: hit === close || close.contains(hit),
    backdropExists: document.querySelector('.hud__sheet-backdrop') instanceof HTMLElement,
  }
})
check(
  'I11a',
  'fechar permanece visível após rolar o painel mobile',
  mobileSheet?.scrollTop > 0 &&
    mobileSheet.closeVisible === true &&
    mobileSheet.closeTargetable === true,
  JSON.stringify(mobileSheet),
)
check('I11b', 'painel mobile oferece fundo tocável para fechar', mobileSheet?.backdropExists === true)

if (mobileSheet?.backdropExists === true) await mobilePage.mouse.click(195, 150)
const backdropResult = await mobilePage.evaluate(() => ({
  sheet: document.querySelector('.hud')?.getAttribute('data-sheet'),
  focusReturned: document.activeElement?.matches('.hud__sheet-toggle') === true,
}))
check(
  'I11c',
  'toque fora fecha o painel mobile e devolve o foco',
  backdropResult.sheet === 'closed' && backdropResult.focusReturned,
  JSON.stringify(backdropResult),
)

if (backdropResult.sheet !== 'closed') {
  await mobilePage.evaluate(() => {
    const close = document.querySelector('.hud__sheet-close')
    if (close instanceof HTMLButtonElement) close.click()
  })
}
await mobilePage.click('.hud__sheet-toggle')
const closedBySwipe = await mobilePage.evaluate(() => {
  const panel = document.querySelector('.hud__console')
  const head = document.querySelector('.hud__sheet-head')
  if (!(panel instanceof HTMLElement) || !(head instanceof HTMLElement)) return false
  panel.scrollTop = 0
  head.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true,
    button: 0,
    clientX: 195,
    clientY: 320,
    isPrimary: true,
    pointerId: 11,
    pointerType: 'touch',
  }))
  head.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true,
    button: 0,
    clientX: 195,
    clientY: 390,
    isPrimary: true,
    pointerId: 11,
    pointerType: 'touch',
  }))
  return document.querySelector('.hud')?.getAttribute('data-sheet') === 'closed'
})
check('I11d', 'arrastar o grip para baixo fecha o painel mobile', closedBySwipe === true)
await mobilePage.click('.hud__sheet-toggle')
await mobilePage.keyboard.press('Shift+Tab')
const reverseFocus = await mobilePage.evaluate(() => ({
  inside: document.querySelector('.hud__console').contains(document.activeElement),
  last: document.activeElement?.getAttribute('aria-pressed') !== null &&
    document.activeElement?.textContent.includes('Rotação automática'),
}))
await mobilePage.keyboard.press('Tab')
const forwardFocus = await mobilePage.evaluate(() => document.activeElement?.matches('.hud__sheet-close'))
check('I11e', 'Tab e Shift+Tab mantêm o foco dentro do painel modal', reverseFocus.inside && reverseFocus.last && forwardFocus)
await mobilePage.keyboard.press('Escape')
check('I11f', 'Escape fecha e restaura o foco', await mobilePage.evaluate(() =>
  document.querySelector('.hud')?.getAttribute('data-sheet') === 'closed' &&
  document.activeElement?.matches('.hud__sheet-toggle')))
await mobilePage.close()

// Native buttons own Space/Enter; the emulator must not consume those strokes.
const powerBeforeKeyboardClick = await page.evaluate(() => window.__msx.interactions.getState().power.on)
await page.locator('.hud__btn--primary').focus()
await page.keyboard.press('Space')
const powerAfterKeyboardClick = await page.evaluate(() => window.__msx.interactions.getState().power.on)
check('I15', 'Espaço ativa o botão focado sem ir para o MSX', powerAfterKeyboardClick !== powerBeforeKeyboardClick)
await page.keyboard.press('Space')

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
process.exitCode = fails ? 1 : 0
} finally {
  await browser.close()
}
