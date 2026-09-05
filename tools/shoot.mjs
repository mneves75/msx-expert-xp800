#!/usr/bin/env node
/**
 * Render capture harness.
 *
 * Boots the app in headless Chromium with a real GPU-backed WebGL context, drives the
 * camera to a set of fixed inspection poses, and writes PNGs. This is what lets critic
 * agents actually *see* the model instead of guessing from source code.
 *
 * Usage:
 *   node tools/shoot.mjs                      # all poses -> shots/
 *   node tools/shoot.mjs --pose hero,keyboard # subset
 *   node tools/shoot.mjs --out shots/round3   # custom dir
 *   node tools/shoot.mjs --width 2560 --height 1440
 *   node tools/shoot.mjs --dpr 2
 *   node tools/shoot.mjs --hud                # keep the HUD chrome in frame
 *   node tools/shoot.mjs --power off          # capture the machine switched off
 *   node tools/shoot.mjs --no-verify          # skip the lit-subject assertion
 *
 * The page must expose `window.__msxReady` (boolean) and `window.__msxCamera(pose)`.
 * Optional, used when present: `window.__msxHud.setChromeVisible(false)` to strip the
 * overlay, and `window.__msxInteractions.setPower(true)` to light the CRT.
 *
 * Validity gates (see `capture-guard.mjs`): the run aborts *before* writing anything if
 * the app did not compile, did not signal ready, or logged an error; and aborts *after*
 * each frame if the CRT should be lit and measurably is not. Every batch also writes a
 * `capture.json` sidecar with the commit, the compile verdict and the measured screen
 * luminance, so an invalid batch is rejected in one second instead of by pixel-sampling.
 * Start the dev server with `MSX_CAPTURE=1 pnpm dev` to suppress the HMR overlay so a
 * stale one can never composite into a frame — the error gates still stop the run.
 */
import { launchBrowser, targetUrl } from './browser.mjs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  CaptureAbort,
  assertPageHealthy,
  assertScreenEvidence,
  gitSha,
  measureRegion,
  objectRoi,
  rendererInfo,
  stage,
  writeSidecar,
} from './capture-guard.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return fallback
  const value = args[i + 1]
  if (!value || value.startsWith('--')) {
    console.error(`✗ --${name} requires a value`)
    process.exit(2)
  }
  return value
}
const has = (name) => args.includes(`--${name}`)
const numberFlag = (name, fallback, { min = Number.MIN_VALUE, integer = false } = {}) => {
  const raw = flag(name, fallback)
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    console.error(`✗ --${name} must be ${integer ? 'an integer' : 'a number'} >= ${min} (got "${raw}")`)
    process.exit(2)
  }
  return value
}

const OUT = resolve(flag('out', 'shots'))
const URL_ = targetUrl()
const WIDTH = numberFlag('width', '1920', { min: 1, integer: true })
const HEIGHT = numberFlag('height', '1080', { min: 1, integer: true })
const DPR = numberFlag('dpr', '1', { min: 0.1 })
const SETTLE = numberFlag('settle', '1400', { min: 0 })
const SHOW_HUD = has('hud')
const POWER_ON = flag('power', 'on') !== 'off'
const VERIFY = !has('no-verify')
/**
 * A lit CRT has to clear both bars: a mean well above the black-plastic floor
 * *and* a broad highlight. Mean alone passes a uniformly grey mush; maximum alone
 * passes a single stuck pixel. Round 2's dead screen measured mean ≈ 9, p99 ≈ 12.
 */
const SCREEN_MIN_MEAN = 60
// Com o bloom contido e o tubo 40 % maior, poses frontais legítimas medem p99
// ≥ 125; a tela morta da rodada 2 media ~12. O percentil rejeita um pixel isolado.
const SCREEN_MIN_P99 = 100
/** Below this the screen is a detail in the frame, not the subject — don't gate on it. */
const SCREEN_MIN_COVERAGE = 0.04
/**
 * Comma-separated top-level scene object names to hide, e.g.
 * `--hide monitor-crt,teclado`. Needed for the back-panel elevation: the CRT
 * stands directly behind the console and would otherwise occlude half the
 * panel, which is exactly how the r1 back shot lost eight ports.
 */
const HIDE = flag('hide', '')
/** Override the vertical FOV in degrees — long lens for spec-verification shots. */
const FOV = numberFlag('fov', '0', { min: 0 })

/**
 * Inspection poses. Named so critic agents can request specific scrutiny.
 * Each is [azimuth°, elevation°, distance(m), target(x,y,z)].
 */
const POSES = {
  // Target raised/pulled back so the enlarged CRT (scale 1.624) sits whole in frame.
  hero: [38, 20, 1.12, [0, 0.32, -0.06]],
  front: [0, 10, 1.9, [0, 0.23, -0.12]],
  // 3/4 from behind, not dead-on: the CRT stands directly behind the console, so an
  // azimuth-180 camera far enough out to frame the 0.40 m back panel would have to sit
  // inside the tube. 138° puts it ~0.19 m clear of the cabinet's right flank and still
  // reads the whole silkscreened panel.
  back: [138, 24, 0.76, [-0.02, 0.045, -0.12]],
  // Back elevation for spec verification: dead-on, long lens, deep DOF, whole
  // plate edge to edge. Shoot with `--hide monitor-crt,teclado,joystick --fov 16`.
  'back-flat': [180, 7, 1.35, [0, 0.05, -0.075]],
  // Left connector cluster at macro distance — SPEAKER LEVEL through RGB.
  'back-macro-left': [176, 6, 0.42, [0.1, 0.045, -0.075]],
  // Right power block — FUSE, SWITCHED OUTLET, AC INPUT, cord.
  'back-macro-right': [184, 6, 0.42, [-0.11, 0.05, -0.075]],
  top: [25, 78, 1.35, [0, 0.02, 0.08]],
  keyboard: [12, 55, 0.45, [0, 0.015, 0.26]],
  'keyboard-macro': [8, 32, 0.22, [-0.08, 0.02, 0.25]],
  slots: [4, 18, 0.3, [0.02, 0.05, 0.15]],
  screen: [2, 10, 0.58, [0, 0.35, -0.38]],
  'screen-macro': [0, 4, 0.34, [0, 0.27, -0.38]],
  raking: [72, 6, 0.8, [0, 0.05, 0]],
  silhouette: [115, 12, 1.1, [0, 0.06, 0]],
  cartridge: [30, 35, 0.35, [-0.3, 0.04, 0.1]],
}

const requested = flag('pose', '')
const poseNames = requested ? requested.split(',').map((s) => s.trim()) : Object.keys(POSES)
const unknownPoses = poseNames.filter((name) => !Object.hasOwn(POSES, name))
if (unknownPoses.length > 0) {
  console.error(`✗ unknown pose(s): ${unknownPoses.join(', ')}`)
  process.exit(2)
}

await mkdir(OUT, { recursive: true })
await writeSidecar(OUT, { verdict: 'incomplete', capturedAt: new Date().toISOString() })

const browser = await launchBrowser(['--ignore-gpu-blocklist'])

const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: DPR,
})

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(String(e)))

/**
 * Runs a validity gate. A failed gate closes the browser and exits non-zero
 * *without* writing a PNG — the whole point is that a broken build can never
 * reach the shots directory in the first place.
 */
async function guard(fn) {
  try {
    return await fn()
  } catch (error) {
    console.error(`\n✗ capture aborted: ${error.message}`)
    if (error instanceof CaptureAbort && error.detail) {
      for (const [k, v] of Object.entries(error.detail)) {
        if (v === null || (Array.isArray(v) && v.length === 0)) continue
        console.error(`  ${k}: ${Array.isArray(v) ? v.join('\n    ') : v}`)
      }
    }
    console.error('  Batch aborted. Any frames already written are incomplete.')
    await browser.close()
    process.exit(1)
  }
}

console.log(`→ ${URL_}  (${WIDTH}×${HEIGHT})`)
await page.goto(URL_, { waitUntil: 'networkidle', timeout: 60_000 })

// Wait for the app to signal that the scene is built and the first frame is presented.
// A timeout here is not a warning: if the scene never built there is nothing to shoot,
// and capturing "anyway" is exactly how a Vite error overlay got submitted for review.
await page
  .waitForFunction(() => window.__msxReady === true, null, { timeout: 60_000 })
  .catch(() => undefined)
await guard(() => assertPageHealthy(page, errors))

// Auto-rotate off (it would drift the azimuth between poses), HUD chrome per the flag,
// power per the flag. Re-applied before every frame — see `stage()` for why.
const staged = await stage(page, { powerOn: POWER_ON, showHud: SHOW_HUD })
await guard(() => {
  if (!staged.hudReachable || !staged.powerReachable || staged.powerState !== POWER_ON) {
    throw new CaptureAbort('HUD/power capture contract was not applied', staged)
  }
})

if (HIDE) {
  const hiddenNames = await page.evaluate((names) => {
    const wanted = new Set(names.split(',').map((s) => s.trim()).filter(Boolean))
    const scene = window.__msx?.scene
    if (!scene) return []
    const done = []
    for (const child of scene.children) {
      if (wanted.has(child.name)) {
        child.visible = false
        done.push(child.name)
      }
    }
    if (done.length > 0) {
      // O atlas de sombra é congelado (Engine, shadowMap.autoUpdate=false) e
      // `visible = false` não passa por nenhuma mola: sem isto as poses back-*
      // ganham sombras-fantasma do CRT/teclado escondidos, e o quadro congelado
      // nem seria reapresentado.
      const engine = window.__msx?.engine
      if (engine) {
        engine.renderer.shadowMap.needsUpdate = true
        engine.requestRender?.(3)
      }
    }
    return done
  }, HIDE)
  console.log(`  · hidden: ${hiddenNames.join(', ') || '(none matched)'}`)
}

if (FOV > 0) {
  const applied = await page.evaluate((fov) => {
    const cam = window.__msx?.engine?.camera
    if (!cam) return false
    cam.fov = fov
    cam.updateProjectionMatrix()
    return true
  }, FOV)
  await guard(() => { if (!applied) throw new CaptureAbort('camera FOV override was not applied') })
}

// CRT warm-up is a deliberate ramp (SPEC §8) and the emulator is fetched lazily.
if (POWER_ON && staged.powerReachable) await page.waitForTimeout(6000)

await page.waitForTimeout(SETTLE)

// Nothing has been written yet. Last check before the first frame lands on disk.
await guard(() => assertPageHealthy(page, errors))

const shots = []
const failures = []

for (const name of poseNames) {
  const pose = POSES[name]
  const ok = await page.evaluate(
    ([az, el, dist, target]) =>
      typeof window.__msxCamera === 'function'
        ? (window.__msxCamera({ azimuth: az, elevation: el, distance: dist, target }), true)
        : false,
    pose,
  )
  await guard(() => { if (!ok) throw new CaptureAbort('window.__msxCamera missing — pose not applied') })

  // Re-assert the stage. A dev-server recompile reloads the page and silently
  // undoes the power switch and the HUD hide; without this the batch comes out
  // with the machine off and the whole overlay in frame, and nothing says why.
  const frameStage = await stage(page, { powerOn: POWER_ON, showHud: SHOW_HUD })
  await guard(() => {
    if (!frameStage.hudReachable || !frameStage.powerReachable || frameStage.powerState !== POWER_ON) {
      throw new CaptureAbort('capture stage lost its HUD/power contract', frameStage)
    }
  })
  if (POWER_ON && frameStage.warmth < 0.995) {
    await page.waitForFunction(() => window.__msx.interactions.getState().power.warmth >= 0.995, null, { timeout: 10_000 })
  }

  // Let TAA/progressive effects converge before capturing.
  await page.waitForTimeout(SETTLE)
  await guard(() => assertPageHealthy(page, errors))
  const file = `${OUT}/${name}.png`
  const buffer = await page.screenshot({ path: file })

  // Measure the subject, not the frame: the ROI is the projected screen mesh, so
  // the same threshold works for the wide shot and the macro.
  const roi = await objectRoi(page, 'crt-screen')
  const stats = roi === null ? null : await measureRegion(page, buffer, roi)
  // Atrás do hemisfério frontal o tubo é ocluído pelo próprio gabinete — o ROI
  // projeta escuro por geometria, não por defeito. Só faz sentido exigir fósforo
  // aceso quando a câmera realmente enxerga a face do monitor.
  const azimuthDeg = ((pose[0] % 360) + 360) % 360
  const facingScreen = azimuthDeg <= 100 || azimuthDeg >= 260
  let gated = false
  let lit = true
  // The full-hardware front pose measures 2.99% inset phosphor at 1920×1080.
  // Keep its wide framing; 2% still supplies over 40k pixels for the light test.
  const minCoverage = name === 'front' ? 0.02 : SCREEN_MIN_COVERAGE
  try {
    gated = assertScreenEvidence(stats, {
      enabled: VERIFY && POWER_ON && facingScreen && !HIDE.split(',').includes('monitor-crt'),
      required: ['hero', 'front', 'screen', 'screen-macro'].includes(name),
      minCoverage,
      minMean: SCREEN_MIN_MEAN,
      minP99: SCREEN_MIN_P99,
    })
  } catch (error) {
    lit = false
    gated = true
    failures.push(`${name}: ${error.message}`)
  }

  shots.push({
    pose: name,
    file: `${name}.png`,
    camera: { azimuth: pose[0], elevation: pose[1], distance: pose[2], target: pose[3] },
    screenRoi: roi,
    minScreenCoverage: minCoverage,
    stage: frameStage,
    screenLuminance:
      stats === null
        ? null
        : {
            mean: Number(stats.mean.toFixed(2)),
            max: stats.max,
            p99: stats.p99,
            coverage: Number(stats.coverage.toFixed(4)),
          },
    gated,
    verdict: gated ? (lit ? 'lit' : 'dark') : 'not-gated',
  })
  console.log(
    `  ${gated && !lit ? '✗' : '✓'} ${name}` +
      (stats === null ? '' : `  (tela: média ${stats.mean.toFixed(1)}, p99 ${stats.p99})`),
  )
}

const gpu = await rendererInfo(page)
const actualViewport = await page.evaluate(() => ({
  width: window.innerWidth,
  height: window.innerHeight,
  deviceScaleFactor: window.devicePixelRatio,
  rendererPixelRatio: window.__msx?.engine.renderer.getPixelRatio() ?? null,
  drawingBufferWidth: window.__msx?.engine.renderer.domElement.width ?? null,
  drawingBufferHeight: window.__msx?.engine.renderer.domElement.height ?? null,
}))
await browser.close()

// Provenance travels with the batch: a reviewer opens this before the PNGs.
await writeSidecar(OUT, {
  capturedAt: new Date().toISOString(),
  gitSha: await gitSha(),
  url: URL_,
  viewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: DPR },
  actualViewport,
  power: POWER_ON ? 'on' : 'off',
  compiled: true,
  consoleErrors: [...new Set(errors)].slice(0, 20),
  gpu,
  thresholds: {
    screenMinMean: SCREEN_MIN_MEAN,
    screenMinP99: SCREEN_MIN_P99,
    screenMinCoverage: SCREEN_MIN_COVERAGE,
  },
  shots,
  verdict: failures.length === 0 && errors.length === 0 ? 'valid' : 'invalid',
})

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} shot(s) failed the lit-subject gate:`)
  for (const f of failures) console.error(`  ${f}`)
  console.error('  A shot where the subject is off is not a shot. Batch marked invalid.')
  process.exit(1)
}
if (errors.length) {
  console.error(`\n✗ ${errors.length} console error(s):`)
  for (const e of [...new Set(errors)].slice(0, 20)) console.error(`  ${e}`)
  process.exit(1)
}
console.log(`\n✓ shots written to ${OUT}  (+ capture.json)`)
