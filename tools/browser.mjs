import { chromium } from 'playwright'

export const WEBMSX_URL = 'https://cdn.jsdelivr.net/gh/ppeccin/WebMSX@4f4009e86d3e0bb9be7dcd7f0a582b0cd411d660/release/stable/6.0/cbios/embedded/wmsx.js'
export const WEBMSX_INTEGRITY = 'sha384-ZrKfFA57c2hR6DHPG3q0c55xd7wx70ZQLpoWj87znFJaebQcxkKRDJQxZFh+B49S'

export function launchBrowser(extraArgs = []) {
  const platformArgs = process.platform === 'darwin'
    ? ['--use-gl=angle', '--use-angle=metal']
    : []
  return chromium.launch({ args: [
    ...platformArgs,
    '--enable-gpu',
    '--user-agent=OpenAI File Downloader, XaiImageApiFetch/1.0',
    ...extraArgs,
  ] })
}

/** All local tools accept --url or MSX_URL; the managed runner sets MSX_URL. */
export function targetUrl(fallback = 'http://127.0.0.1:5173/') {
  const index = process.argv.indexOf('--url')
  const raw = index === -1 ? process.env.MSX_URL ?? fallback : process.argv[index + 1]
  if (!raw || raw.startsWith('--')) throw new Error('--url requires an HTTP(S) URL')
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Expected an HTTP(S) URL')
  return url.href
}
