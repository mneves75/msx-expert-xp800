// Probes a deployed instance end to end: security headers, emulator boot under CSP,
// cartridge insertion, and console cleanliness.
//
// Point it at your deploy with the first argument or MSX_PROD_URL:
//   node tools/verify-prod.mjs https://my-deploy.example.workers.dev/
import { launchBrowser, WEBMSX_URL, WEBMSX_INTEGRITY } from './browser.mjs'
import { checkDeploymentHeaders } from './deployment-headers.mjs'
import { mkdir } from 'node:fs/promises'

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
const EXPECTED_WEBMSX_STYLE_VIOLATION =
  /(?:Refused to apply inline style|Applying inline style violates).*(?:style-src-elem|style-src)/i

const browser = await launchBrowser()
try {
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })

const errs = []
const cspViolations = []
const classify = (text) => {
  if (/Content Security Policy|Refused to/i.test(text)) {
    cspViolations.push(text)
    return
  }
  errs.push(text)
}
page.on('pageerror', (e) => classify(String(e)))
page.on('console', (m) => { if (m.type() === 'error') classify(m.text()) })

const scenario = new URL(TARGET)
scenario.searchParams.set('MACHINE', 'MSX2P')
scenario.searchParams.set('SCREEN_ELEMENT_ID', 'app')
const response = await page.goto(scenario.href, { waitUntil: 'networkidle', timeout: 60_000 })
const headers = response?.headers() ?? {}

const failures = []
const expect = (name, ok, detail) => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

expect('HTTP 200', response?.status() === 200)
for (const check of checkDeploymentHeaders(headers)) expect(check.name, check.pass, check.detail)
if (process.env.MSX_EXPECTED_VERSION) {
  const version = await page.locator('meta[name="application-version"]').getAttribute('content')
  expect('versão publicada', version === process.env.MSX_EXPECTED_VERSION, version)
}

await page.waitForFunction(() => window.__msxReady === true, null, { timeout: 60_000 })

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
expect(
  'sem violações CSP antes de carregar o WebMSX',
  cspViolations.length === 0,
  cspViolations.slice(0, 3).join(' | '),
)
const cspCountBeforeWebMsx = cspViolations.length

await page.evaluate(() => window.__msx.interactions.insertCartridge('A'))
await page
  .waitForFunction(() => window.__msx.interactions.getState().emulator === 'webmsx', null, {
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
const boundary = await page.evaluate(({ url, integrity }) => {
  const script = [...document.scripts].find((item) => item.src === url)
  return {
    pinned: script?.integrity === integrity && script.crossOrigin === 'anonymous',
    queryIgnored: window.WMSX?.MACHINE === 'MSX1A' &&
      window.WMSX?.SCREEN_ELEMENT_ID === 'gradiente-wmsx-screen' &&
      window.WMSX?.ALLOW_URL_PARAMETERS === false,
  }
}, { url: WEBMSX_URL, integrity: WEBMSX_INTEGRITY })
expect('WebMSX usa URL e SRI fixados', boundary.pinned)
expect('parâmetros da URL não sobrescrevem a configuração do WebMSX', boundary.queryIgnored)
const webMsxViolations = cspViolations.slice(cspCountBeforeWebMsx)
expect(
  'WebMSX gera somente as duas violações inline-style conhecidas',
  webMsxViolations.length === 2 &&
    webMsxViolations.every((text) => EXPECTED_WEBMSX_STYLE_VIOLATION.test(text)),
  webMsxViolations.join(' | '),
)
expect('sem erros de console inesperados', errs.length === 0, errs.slice(0, 3).join(' | '))
expect(
  'pipeline de renderização íntegro',
  await page.evaluate(() => window.__msx?.engine?.isHealthy === true),
)

await page.evaluate(() => window.__msx.cameraRig.resetPose(true))
await page.waitForTimeout(1500)
await mkdir('.scratch/verify-prod', { recursive: true })
await page.screenshot({ path: '.scratch/verify-prod/deploy-live.png' })

console.log(`\n${JSON.stringify(out)}`)
console.log(`violações de CSP esperadas (WebMSX): ${webMsxViolations.length}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} verificação(ões) falharam:\n  ${failures.join('\n  ')}`)
  process.exitCode = 1
} else {
  console.log('\nimplantação verificada.')
}
} finally {
  await browser.close()
}
