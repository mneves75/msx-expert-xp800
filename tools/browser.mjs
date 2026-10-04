import { chromium } from 'playwright'

export const WEBMSX_URL = 'https://cdn.jsdelivr.net/gh/ppeccin/WebMSX@4f4009e86d3e0bb9be7dcd7f0a582b0cd411d660/release/stable/6.0/cbios/embedded/wmsx.js'
export const WEBMSX_INTEGRITY = 'sha384-ZrKfFA57c2hR6DHPG3q0c55xd7wx70ZQLpoWj87znFJaebQcxkKRDJQxZFh+B49S'

export function launchBrowser(extraArgs = []) {
  const platformArgs = process.platform === 'darwin'
    ? ['--use-gl=angle', '--use-angle=metal']
    : []
  // Opt-in for hosts where the bundled headless shell is unusable (e.g. `chrome`).
  // CI keeps the bundled build, which remains the authoritative gate.
  const channel = process.env.MSX_BROWSER_CHANNEL?.trim() || undefined
  if (channel) console.log(`Browser channel: ${channel} (MSX_BROWSER_CHANNEL)`)
  return chromium.launch({ ...(channel ? { channel } : {}), args: [
    ...platformArgs,
    '--enable-gpu',
    ...extraArgs,
  ] })
}

/**
 * Checks that open a raw Vite module (no HTML, so no declared icon) make full Chrome
 * request /favicon.ico; that 404 is harness noise, not an application error.
 */
export function isFaviconRequestError(message) {
  const path = new URL(message.location().url || 'about:blank', 'http://x').pathname
  return message.type() === 'error' && path === '/favicon.ico' && /\b404\b/.test(message.text())
}

/**
 * All local tools accept --url or MSX_URL; the managed runner sets MSX_URL. An explicit
 * `override` (a tool's positional URL) wins over both.
 */
export function targetUrl(fallback = 'http://127.0.0.1:5173/', override = undefined) {
  const index = process.argv.indexOf('--url')
  const raw = override ?? (index === -1 ? process.env.MSX_URL ?? fallback : process.argv[index + 1])
  if (!raw || raw.startsWith('--')) throw new Error('--url requires an HTTP(S) URL')
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Expected an HTTP(S) URL')
  return url.href
}
