import { chromium } from 'playwright'

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors = []

page.on('pageerror', (error) => errors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})

try {
  // Carrega um módulo diretamente para obter a origem do Vite sem executar o
  // bootstrap/HMR da aplicação, que não faz parte desta verificação unitária.
  await page.goto('http://localhost:5173/src/emulator/__checks__.ts', {
    waitUntil: 'domcontentloaded',
  })
  const result = await page.evaluate(async () => {
    const keyboard = await import('/src/models/Keyboard.ts')
    const checks = await import('/src/emulator/__checks__.ts')
    return checks.verifyEmulatorKeymaps(keyboard.modeledKeyboardKeyCodes())
  })

  for (const check of result.checks) {
    console.log(`${check.pass ? '✓' : '✗'} ${check.code} — ${check.detail}`)
  }
  console.log(`\n${result.passed}/${result.checked} PASS`)

  if (errors.length > 0) {
    console.error(`Erros no console: ${[...new Set(errors)].join(' | ')}`)
  }
  process.exitCode = result.passed === result.checked && errors.length === 0 ? 0 : 1
} catch (error) {
  console.error(`✗ verificação do mapa de teclas falhou: ${String(error)}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
