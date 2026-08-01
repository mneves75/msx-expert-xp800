// Probes a deployed instance end to end: security headers, emulator boot under CSP,
// cartridge insertion, and console cleanliness.
//
// Point it at your deploy with the first argument or MSX_PROD_URL:
//   node tools/verify-prod.mjs https://my-deploy.example.workers.dev/
import { chromium } from 'playwright'

const TARGET = process.argv[2] ?? process.env.MSX_PROD_URL
if (!TARGET) {
  console.error('Usage: node tools/verify-prod.mjs <deployed-url>  (or set MSX_PROD_URL)')
  process.exit(2)
}

/**
 * WebMSX injects two <style> elements of its own. `style-src 'self'` blocks them on
 * purpose: we only sample its canvas into a texture and never show its DOM, and an A/B
 * against a permissive policy measured no visible difference. These are expected, so
 * they must not be counted as failures — but anything else must.
 */
const EXPECTED_CSP_VIOLATION = /style-src/i

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })

const errs = []
const expectedViolations = []
const classify = (text) => {
  if (/Content Security Policy|Refused to/i.test(text)) {
    if (EXPECTED_CSP_VIOLATION.test(text)) expectedViolations.push(text)
    else errs.push(text)
    return
  }
  errs.push(text)
}
page.on('pageerror', (e) => classify(String(e)))
page.on('console', (m) => { if (m.type() === 'error') classify(m.text()) })

const response = await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 60_000 })
const headers = response?.headers() ?? {}

const failures = []
const expect = (name, ok, detail) => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const csp = headers['content-security-policy'] ?? ''
const styleSrc = csp.split('style-src')[1]?.split(';')[0] ?? ''
expect('CSP presente', csp.length > 0)
expect("style-src sem 'unsafe-inline'", csp.length > 0 && !styleSrc.includes('unsafe-inline'), styleSrc.trim())
expect("script-src sem 'unsafe-inline'", !(csp.split('script-src')[1]?.split(';')[0] ?? '').includes('unsafe-inline'))
expect("object-src 'none'", csp.includes("object-src 'none'"))
expect("frame-ancestors 'none'", csp.includes("frame-ancestors 'none'"))
expect('HSTS', (headers['strict-transport-security'] ?? '').includes('max-age='))
expect('X-Content-Type-Options: nosniff', headers['x-content-type-options'] === 'nosniff')
expect('X-Frame-Options: DENY', (headers['x-frame-options'] ?? '').toUpperCase() === 'DENY')

await page.waitForFunction(() => window.__msxReady === true, { timeout: 60_000 })

// Duas fases, porque a rota segue o cartucho (SPEC §9): slots vazios abrem o BASIC
// interno e só a inserção promove para o WebMSX real. Conferir as duas prova mais do
// que a checagem antiga, que só olhava o estado inicial.
const idle = await page.evaluate(async () => {
  const itx = window.__msx.interactions
  window.__msx.cameraRig.setAutoRotate?.(false)
  window.__msxHud?.setChromeVisible?.(false)
  itx.setPower(true)
  await new Promise((r) => setTimeout(r, 9000))
  const s = itx.getState()
  return { emulator: s.emulator, warmth: s.power.warmth }
})

expect('slots vazios abrem o BASIC interno', idle.emulator === 'procedural', `emulator = ${idle.emulator}`)
expect('tubo aqueceu', idle.warmth > 0.5, `warmth = ${idle.warmth}`)

await page.evaluate(() => window.__msx.interactions.insertCartridge('A'))
await page
  .waitForFunction(() => window.__msx.interactions.getState().emulator === 'webmsx', {
    timeout: 60_000,
  })
  .catch(() => {})
await page.waitForTimeout(4000)
const out = await page.evaluate(() => {
  const s = window.__msx.interactions.getState()
  return { emulator: s.emulator, warmth: s.power.warmth, slotA: s.slotA?.name ?? null }
})

expect('cartucho promove para o WebMSX real sob a CSP', out.emulator === 'webmsx', `emulator = ${out.emulator}`)
expect('cartucho inserido', out.slotA !== null, `slotA = ${out.slotA}`)
expect('sem erros de console inesperados', errs.length === 0, errs.slice(0, 3).join(' | '))

await page.evaluate(() => { window.__msxCamera({ azimuth: 38, elevation: 20, distance: 1.12, target: [0, 0.12, -0.06] }) })
await page.waitForTimeout(1500)
await page.screenshot({ path: 'shots/prod-live.png' })
await browser.close()

console.log(`\n${JSON.stringify(out)}`)
console.log(`violações de CSP esperadas (WebMSX): ${expectedViolations.length}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} verificação(ões) falharam:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('\nprodução verificada.')
