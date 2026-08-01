/**
 * Validity gates for the render capture harness.
 *
 * Round 2 of the CRT review was scored 2/100 because half of each submitted PNG
 * was a Vite HMR error overlay and the tube behind it was dead black: a broken
 * build was photographed, written to disk, and shipped to a reviewer. Nothing
 * between "the module failed to parse" and "the reviewer opens the file" ever
 * looked at the pixels.
 *
 * These helpers close that gap. They are deliberately separate from `shoot.mjs`
 * so any variant of the harness (including scratch copies) can import the same
 * gates instead of re-deriving them.
 *
 * Three independent checks, because each catches a failure the others miss:
 *
 *  1. `assertPageHealthy` — the app must have signalled ready, no error overlay
 *     may be in the DOM, and nothing may have thrown. A compile failure trips
 *     all three; a runtime failure in one module usually trips only the last.
 *  2. `measureRegion` — the subject must actually be lit. A shot where the
 *     screen is off is not a shot, and only the pixels can prove it.
 *  3. `writeSidecar` — the batch carries its own provenance, so an invalid
 *     batch is rejected in one second instead of by pixel-sampling a PNG.
 */
import { writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Thrown when a gate fails. The harness turns this into a non-zero exit. */
export class CaptureAbort extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'CaptureAbort'
    this.detail = detail
  }
}

/**
 * Fails the run if the page is not in a state worth photographing.
 *
 * `errors` is the live array the harness fills from `console` / `pageerror`
 * listeners; it is inspected rather than returned so a silent failure (overlay
 * suppressed via `server.hmr.overlay: false`) still stops the run.
 */
export async function assertPageHealthy(page, errors, { requireReady = true } = {}) {
  const state = await page.evaluate(() => {
    const overlay = document.querySelector('vite-error-overlay')
    const banner = document.querySelector('#vite-error-overlay, .vite-error-overlay')
    return {
      ready: window.__msxReady === true,
      overlay: overlay !== null || banner !== null,
      viteError:
        typeof window.__viteError === 'object' && window.__viteError !== null
          ? String(window.__viteError.message ?? window.__viteError)
          : null,
      title: document.title,
    }
  })

  if (state.overlay || state.viteError !== null) {
    throw new CaptureAbort('build error overlay present — the app did not compile', {
      viteError: state.viteError,
      errors: [...new Set(errors)].slice(0, 10),
    })
  }
  if (requireReady && !state.ready) {
    throw new CaptureAbort('window.__msxReady never became true — the scene never built', {
      errors: [...new Set(errors)].slice(0, 10),
    })
  }
  if (errors.length > 0) {
    throw new CaptureAbort(`${errors.length} console/page error(s) before capture`, {
      errors: [...new Set(errors)].slice(0, 10),
    })
  }
  return state
}

/**
 * Screen-space bounding box of a named scene object, normalised to 0..1.
 *
 * Projecting the real mesh beats a hard-coded rectangle: the ROI follows the
 * pose, so the same assertion works for the wide shot and the macro without
 * anyone maintaining per-pose coordinates.
 */
export async function objectRoi(page, objectName) {
  return page.evaluate((name) => {
    const scene = window.__msx?.scene
    const camera = window.__msx?.engine?.camera
    if (!scene || !camera) return null
    let found = null
    scene.traverse((o) => {
      if (found === null && o.name === name) found = o
    })
    if (found === null || found.geometry === undefined) return null

    found.updateWorldMatrix(true, false)
    const geometry = found.geometry
    if (geometry.boundingBox === null) geometry.computeBoundingBox()
    const bb = geometry.boundingBox
    if (!bb) return null

    let minX = 1e9
    let minY = 1e9
    let maxX = -1e9
    let maxY = -1e9
    // No import of three here — cloning the camera's own vector is the only
    // dependency-free way to get a Vector3 of the exact same build.
    const v = camera.position.clone()
    for (let i = 0; i < 8; i++) {
      v.set(
        i & 1 ? bb.max.x : bb.min.x,
        i & 2 ? bb.max.y : bb.min.y,
        i & 4 ? bb.max.z : bb.min.z,
      )
      v.applyMatrix4(found.matrixWorld).project(camera)
      const px = (v.x + 1) / 2
      const py = (1 - v.y) / 2
      minX = Math.min(minX, px)
      maxX = Math.max(maxX, px)
      minY = Math.min(minY, py)
      maxY = Math.max(maxY, py)
    }
    // Slight inset: the outermost ring of the phosphor mesh sits under the
    // bezel, and including it would average unlit plastic into the reading.
    const w = maxX - minX
    const h = maxY - minY
    return {
      x: minX + w * 0.14,
      y: minY + h * 0.14,
      width: w * 0.72,
      height: h * 0.72,
    }
  }, objectName)
}

/**
 * Luminance statistics inside a normalised rect of a captured PNG.
 *
 * The decode happens in the page (`createImageBitmap` + a 2D canvas) so the
 * harness needs no image decoding dependency. Values are 0..255 sRGB LSB, the
 * same scale a reviewer reads with a colour picker.
 */
export async function measureRegion(page, pngBuffer, rect) {
  const base64 = pngBuffer.toString('base64')
  return page.evaluate(
    async ({ b64, roi }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(bitmap, 0, 0)

      const x0 = Math.max(0, Math.round(roi.x * bitmap.width))
      const y0 = Math.max(0, Math.round(roi.y * bitmap.height))
      const x1 = Math.min(bitmap.width, Math.round((roi.x + roi.width) * bitmap.width))
      const y1 = Math.min(bitmap.height, Math.round((roi.y + roi.height) * bitmap.height))
      const w = x1 - x0
      const h = y1 - y0
      if (w <= 1 || h <= 1) return { pixels: 0, coverage: 0, mean: 0, max: 0, p99: 0 }

      const data = ctx.getImageData(x0, y0, w, h).data
      const hist = new Uint32Array(256)
      let sum = 0
      let max = 0
      const n = w * h
      for (let i = 0; i < n; i++) {
        const k = i * 4
        // Rec.709 luma on the encoded values: what the eye and the reviewer see.
        const l = Math.round(0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2])
        hist[l] += 1
        sum += l
        if (l > max) max = l
      }
      let acc = 0
      let p99 = 0
      const target = n * 0.99
      for (let l = 0; l < 256; l++) {
        acc += hist[l]
        if (acc >= target) {
          p99 = l
          break
        }
      }
      // Read the dimensions *before* closing: a closed ImageBitmap reports 0×0,
      // which turned the coverage figure into Infinity and then `null` in JSON.
      const frame = bitmap.width * bitmap.height
      bitmap.close()
      return { pixels: n, coverage: frame > 0 ? n / frame : 0, mean: sum / n, max, p99 }
    },
    { b64: base64, roi: rect },
  )
}

/**
 * (Re)applies the stage settings and reports what actually stuck.
 *
 * Idempotent, and called before *every* frame rather than once at boot — a dev
 * server that recompiles mid-run reloads the page, which silently resets the
 * power switch and brings the HUD back. That is how a batch of "screen" shots
 * came out with the machine switched off and the whole overlay in frame, with no
 * console error to explain it: the harness had configured a page that no longer
 * existed.
 */
export async function stage(page, { powerOn, showHud }) {
  return page.evaluate(
    ({ wantPower, wantHud }) => {
      const api = window.__msx ?? {}
      api.cameraRig?.setAutoRotate?.(false)
      api.interactions?.setAutoRotate?.(false)

      const hud = api.hud ?? window.__msxHud
      const hudOk =
        hud !== undefined && hud !== null && typeof hud.setChromeVisible === 'function'
      if (hudOk) hud.setChromeVisible(wantHud)

      const target = api.interactions ?? window.__msxInteractions
      const powerOk =
        target !== undefined && target !== null && typeof target.setPower === 'function'
      if (powerOk) target.setPower(wantPower)

      // Read the state back instead of assuming the write took: this is the whole
      // point of calling `stage` again right before each frame.
      const state = powerOk && typeof target.getState === 'function' ? target.getState() : null
      return {
        hudReachable: hudOk,
        powerReachable: powerOk,
        powerState: state === null ? null : state.power.on,
        warmth: state === null ? null : state.power.warmth,
        emulator: state === null ? null : state.emulator,
      }
    },
    { wantPower: powerOn, wantHud: showHud },
  )
}

/** Renderer / GPU identification, for the sidecar. */
export async function rendererInfo(page) {
  return page.evaluate(() => {
    try {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl2')
      if (gl === null) return null
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      return {
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
      }
    } catch {
      return null
    }
  })
}

/** Short git SHA, or null when the tree has no commits yet. */
export async function gitSha() {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--short', 'HEAD'])
    return stdout.trim()
  } catch {
    return null
  }
}

/**
 * Writes `<out>/capture.json`: commit, compile status, measured screen stats,
 * GPU string. A reviewer opens this before the PNGs.
 */
export async function writeSidecar(outDir, batch) {
  await writeFile(`${outDir}/capture.json`, `${JSON.stringify(batch, null, 2)}\n`, 'utf8')
}
