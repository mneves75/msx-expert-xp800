#!/usr/bin/env node
/**
 * Determinismo das texturas procedurais.
 *
 * Carrega `src/textures/__checks__.ts` direto pelo servidor de desenvolvimento (sem o
 * bootstrap da aplicação, como `verify-keymap.mjs` faz), gera o conjunto de mapas que o
 * boot realmente usa e compara o hash de cada um com `tools/texture-baseline.json`.
 *
 * Por que isto existe: o gerador procedural é o maior custo do boot, então ele vai ser
 * otimizado — fatiado, movido para worker, reordenado. Toda otimização precisa provar que
 * **nenhum pixel mudou**, e comparar 15 capturas a olho não prova isso. Um hash prova.
 *
 * Uso:
 *   node tools/verify-textures.mjs                 # compara com a linha de base
 *   node tools/verify-textures.mjs --write         # regrava a linha de base (mudança deliberada)
 *   node tools/verify-textures.mjs --url http://localhost:5173
 */
import { launchBrowser, targetUrl } from './browser.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const BASE_URL = targetUrl()
const BASELINE = resolve(dirname(fileURLToPath(import.meta.url)), 'texture-baseline.json')

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})

try {
  await page.goto(new URL('/src/textures/__checks__.ts', BASE_URL).href, { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(async () => {
    const checks = await import('/src/textures/__checks__.ts')
    return checks.verifyProceduralTextures()
  })

  if (errors.length > 0) {
    throw new Error(`Erros no console: ${[...new Set(errors)].join(' | ')}`)
  }

  if (WRITE) {
    const payload = {
      note: 'Hashes FNV-1a dos bytes de cada textura procedural. Só regrave junto de uma mudança visual deliberada, e diga qual no CHANGELOG.',
      hashes: Object.fromEntries(result.hashes.map((h) => [h.name, h.hash])),
      dimensions: Object.fromEntries(result.hashes.map((h) => [h.name, `${h.width}x${h.height}`])),
    }
    await writeFile(BASELINE, `${JSON.stringify(payload, null, 2)}\n`)
    console.log(`linha de base regravada com ${result.hashes.length} texturas → ${BASELINE}`)
    console.log(`geração (cache frio): ${result.generationMs.toFixed(0)} ms`)
    process.exitCode = 0
  } else {
    const baseline = JSON.parse(await readFile(BASELINE, 'utf8'))
    let failed = 0
    for (const h of result.hashes) {
      const expected = baseline.hashes[h.name]
      const ok = expected === h.hash
      if (!ok) failed += 1
      const detail = ok ? h.hash : `esperado ${expected ?? '(ausente na linha de base)'}, veio ${h.hash}`
      console.log(`${ok ? '✓' : '✗'} ${h.name} (${h.width}×${h.height}) — ${detail}`)
    }
    const missing = Object.keys(baseline.hashes).filter(
      (name) => !result.hashes.some((h) => h.name === name),
    )
    for (const name of missing) {
      failed += 1
      console.log(`✗ ${name} — presente na linha de base, ausente na geração`)
    }
    console.log(`\n${result.hashes.length - failed}/${result.hashes.length + missing.length} idênticas`)
    console.log(`geração (cache frio): ${result.generationMs.toFixed(0)} ms`)
    process.exitCode = failed === 0 ? 0 : 1
  }
} catch (error) {
  console.error(`✗ verificação de texturas falhou: ${String(error)}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
