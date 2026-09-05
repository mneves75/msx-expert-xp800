import { launchBrowser, targetUrl } from './browser.mjs'

const browser = await launchBrowser()
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(new URL('/src/interaction/__checks__.ts', targetUrl()).href)
  const result = await page.evaluate(async () => {
    const checks = await import('/src/interaction/__checks__.ts')
    return checks.verifyCartridgeRest()
  })
  for (const check of result.checks) console.log(`${check.pass ? '✓' : '✗'} ${check.name} — ${check.detail}`)
  console.log(`${result.passed}/${result.checked} PASS`)
  if (!result.checked || result.passed !== result.checked || errors.length) {
    throw new Error(`Physics verification failed. ${errors.join(' | ')}`)
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
