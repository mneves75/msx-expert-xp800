#!/usr/bin/env node
/**
 * Sonda do Super Cósmico: joga o jogo no WebMSX real e verifica cada estado
 * lendo pixels do canvas do emulador. Sai não-zero em qualquer falha.
 *
 * Duas lições de calibração pagas por esta sonda, mantidas aqui para não se
 * repetirem: (1) teclas vão por `interactions.tapKey` — um press() do host solta
 * a tecla antes de a varredura de matriz do MSX vê-la; (2) as métricas contam
 * "tinta" (pixels diferentes da cor modal do quadro), nunca luma absoluto — o
 * C-BIOS sem cartucho tem fundo claro e estoura qualquer limiar de brilho. O
 * boot também pode vencer a corrida contra a inserção (a máquina sobe sem o
 * cartucho), então o começo do jogo re-insere e tenta de novo em vez de assumir.
 */
import { launchBrowser, targetUrl } from './browser.mjs'

const URL_ = targetUrl(process.argv[2]?.startsWith('http') ? process.argv[2] : undefined)

const browser = await launchBrowser(['--ignore-gpu-blocklist'])
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(URL_, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForFunction(() => window.__msxReady === true, null, { timeout: 60_000 })
await page.evaluate(() => {
  window.__msx.cameraRig.setAutoRotate(false)
  window.__msx.interactions.setAutoRotate?.(false)
  // O painel do HUD aparece com atividade do ponteiro e fica NA FRENTE do canvas
  // — sem escondê-lo, o arrasto do manche 3D (passo 7) acerta DOM, não a cena.
  window.__msx.hud?.setChromeVisible(false)
  window.__msx.interactions.setPower(true)
})

const insert = () =>
  page.evaluate(() => window.__msx.interactions.insertCartridge('A', 'arcade-vermelho'))
/**
 * Segura a tecla por 250 ms via eventos de teclado do host (o caminho capturado
 * pela camada de interação). O `tapKey` de 90 ms entrega ~50 ms de tecla ao MSX
 * — marginal para o decode do C-BIOS e fonte de flakiness medida; um usuário
 * real segurando a tecla fica sempre acima disso.
 */
const tap = async (code) => {
  await page.keyboard.down(code)
  await page.waitForTimeout(250)
  await page.keyboard.up(code)
}

// A rota WebMSX só sobe quando há trabalho para ela: inserir primeiro.
await insert()
await page.waitForFunction(
  () => window.__msx.interactions.getState().emulator === 'webmsx',
  null,
  { timeout: 30_000 },
)

/**
 * Lê o canvas do WebMSX e devolve contagens de "tinta" por linha e por coluna:
 * pixels que diferem da cor modal do quadro (o fundo) em >40 num canal.
 */
async function scan() {
  return page.evaluate(() => {
    const wmsx = document.querySelector('#gradiente-wmsx-screen #wmsx-screen-canvas')
    if (!wmsx) return null
    const probe = document.createElement('canvas')
    probe.width = wmsx.width
    probe.height = wmsx.height
    const ctx = probe.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(wmsx, 0, 0)
    const data = ctx.getImageData(0, 0, probe.width, probe.height).data
    // Cor modal (quantizada a 4 bits/canal) = fundo.
    const hist = new Map()
    for (let k = 0; k < data.length; k += 16 * 4) {
      const key = ((data[k] >> 4) << 8) | ((data[k + 1] >> 4) << 4) | (data[k + 2] >> 4)
      hist.set(key, (hist.get(key) ?? 0) + 1)
    }
    let modal = 0
    let best = -1
    for (const [key, n] of hist) {
      if (n > best) {
        best = n
        modal = key
      }
    }
    const mr = ((modal >> 8) & 15) << 4
    const mg = ((modal >> 4) & 15) << 4
    const mb = (modal & 15) << 4
    const rows = new Array(probe.height).fill(0)
    const cols = new Array(probe.width).fill(0)
    for (let y = 0; y < probe.height; y++) {
      for (let x = 0; x < probe.width; x++) {
        const k = (y * probe.width + x) * 4
        if (
          Math.abs(data[k] - mr) > 40 ||
          Math.abs(data[k + 1] - mg) > 40 ||
          Math.abs(data[k + 2] - mb) > 40
        ) {
          rows[y] += 1
          cols[x] += 1
        }
      }
    }
    return { width: probe.width, height: probe.height, rows, cols }
  })
}

const ink = (s) => s.rows.reduce((a, b) => a + b, 0)
/**
 * Linhas com mais de 30% da largura em tinta — assinatura das paredes de '#'
 * (fileira cheia ≈ 37%); a linha de texto mais longa da splash fica em ~28%.
 */
const wallRows = (s) => s.rows.filter((n) => n > s.width * 0.3).length
const diffOf = (x, y, list) =>
  x[list].map((n, i) => Math.abs(n - y[list][i])).reduce((p, q) => p + q, 0)

async function waitState(name, predicate, timeoutMs, pollMs = 300) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const s = await scan()
    if (s && predicate(s)) return s
    if (Date.now() > deadline) return null
    await page.waitForTimeout(pollMs)
  }
}

let failures = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures += 1
}

// 1. Splash do cartucho: texto sem paredes. O boot pode vencer a corrida contra a
// inserção (C-BIOS sobe sem cartucho) — re-inserir é a recuperação, não um erro.
let splash = await waitState('splash', (s) => ink(s) > 1500 && wallRows(s) === 0, 10_000)
if (splash === null) {
  console.log('  · splash não apareceu — re-inserindo o cartucho')
  await insert()
  splash = await waitState('splash', (s) => ink(s) > 1500 && wallRows(s) === 0, 12_000)
}
check('splash do jogo visível', splash !== null, splash ? `ink=${ink(splash)}` : 'timeout')
if (splash === null) {
  await browser.close()
  process.exit(1)
}

// 2. Começar: espaço → campo com as paredes horizontais. Se a tela não transita,
// o que estava visível não era a splash — re-insere e tenta mais uma vez.
await tap('Space')
let field = await waitState('field', (s) => wallRows(s) >= 2, 4_000)
if (field === null) {
  console.log('  · campo não apareceu — re-inserindo e tentando de novo')
  await insert()
  await waitState('splash2', (s) => ink(s) > 1500 && wallRows(s) === 0, 12_000)
  await tap('Space')
  field = await waitState('field', (s) => wallRows(s) >= 2, 4_000)
}
check('campo com paredes', field !== null, field ? `wallRows=${wallRows(field)}` : 'timeout')
if (field === null) {
  await browser.close()
  process.exit(1)
}

// 3. Movimento autônomo: a sonda anda para a DIREITA — métrica por coluna
// (somas por linha são cegas a deslocamento horizontal).
const a = await scan()
await page.waitForTimeout(400)
const b = await scan()
check('sonda se move sozinha', diffOf(a, b, 'cols') > 0, `colDiff=${diffOf(a, b, 'cols')}`)

// 4. Sem input ela morre na parede direita: a tela congela mantendo as paredes.
await page.waitForTimeout(3000)
const over1 = await scan()
await page.waitForTimeout(1200)
const over2 = await scan()
check('fim de jogo congela a tela', diffOf(over1, over2, 'rows') === 0, `diff=${diffOf(over1, over2, 'rows')}`)
check('fim de jogo mantém as paredes', wallRows(over2) >= 2, `wallRows=${wallRows(over2)}`)

// 5. Reinício: tecla → campo redesenhado (a linha de FIM DE JOGO some).
await tap('Space')
const restarted = await waitState(
  'restart',
  (s) => wallRows(s) >= 2 && diffOf(s, over2, 'rows') > 0,
  4_000,
)
check('reinicia a partida', restarted !== null)

// 6. Morrer com a seta AINDA pressionada — o caso comum. O auto-repeat da BIOS
// reenfileira caracteres depois de um KILBUF isolado; a ROM espera o direcional
// ser solto antes de armar o CHGET, então o placar precisa ficar parado na tela
// enquanto a tecla estiver presa.
await page.keyboard.down('ArrowDown')
await page.waitForTimeout(2500) // mergulha até a parede de baixo, ainda segurando
const held1 = await scan()
await page.waitForTimeout(1200)
const held2 = await scan()
check(
  'placar não é pulado com seta presa',
  diffOf(held1, held2, 'rows') === 0 && wallRows(held2) >= 2,
  `diff=${diffOf(held1, held2, 'rows')} wallRows=${wallRows(held2)}`,
)
await page.keyboard.up('ArrowDown')
await page.waitForTimeout(300)
await tap('Space')
const afterHold = await waitState(
  'restart-pos-segurada',
  (s) => wallRows(s) >= 2 && diffOf(s, held2, 'rows') > 0,
  4_000,
)
check('reinicia após soltar a seta', afterHold !== null)

// 7. O manche 3D pilota o jogo: arrastar o stick para baixo vira a sonda para
// baixo. Rumo horizontal não muda somas por LINHA (baseline zero), então
// qualquer rowDiff após o arrasto prova movimento vertical vindo do joystick.
const stick = await page.evaluate(() => {
  let found = null
  window.__msx.scene.traverse((o) => {
    if (found === null && o.userData?.partId === 'joystick-stick') found = o
  })
  if (found === null) return null
  found.updateWorldMatrix(true, false)
  const v = window.__msx.engine.camera.position.clone()
  v.setFromMatrixPosition(found.matrixWorld)
  window.__msxCamera({
    azimuth: 0,
    elevation: 55,
    distance: 0.45,
    target: [v.x, v.y, v.z],
  })
  found.updateWorldMatrix(true, false)
  v.setFromMatrixPosition(found.matrixWorld).project(window.__msx.engine.camera)
  return { x: (v.x + 1) / 2, y: (1 - v.y) / 2 }
})
if (stick === null) {
  check('manche 3D encontrado', false)
} else {
  const stickInView = stick.x >= 0 && stick.x <= 1 && stick.y >= 0 && stick.y <= 1
  check(
    'manche 3D visível para o arrasto',
    stickInView,
    `x=${stick.x.toFixed(3)} y=${stick.y.toFixed(3)}`,
  )
  if (!stickInView) {
    await browser.close()
    process.exit(1)
  }
  // O passo é auto-suficiente contra corridas: espera a partida corrente morrer
  // (vida máxima ~2,1 s até a parede direita), reinicia com o mouse JÁ sobre o
  // manche e engata o arrasto imediatamente — a medição cai no início da vida.
  const px = stick.x * 1280
  const py = stick.y * 720
  await page.waitForTimeout(3500) // garante fim da partida do passo anterior
  const preJoy = await scan()
  await page.mouse.move(px, py)
  await tap('Space') // reinicia
  const fresh = await waitState(
    'joy-restart',
    (s) => wallRows(s) >= 2 && diffOf(s, preJoy, 'rows') > 0,
    4_000,
  )
  check('partida nova para o teste do manche', fresh !== null)
  await page.mouse.down()
  await page.mouse.move(px, py + 100, { steps: 10 }) // 90 px = deflexão cheia
  await page.waitForTimeout(250)
  const j1 = await scan()
  await page.waitForTimeout(300)
  const j2 = await scan()
  await page.mouse.up()
  check(
    'manche 3D vira a sonda (setas via GTSTCK)',
    diffOf(j1, j2, 'rows') > 0,
    `rowDiff=${diffOf(j1, j2, 'rows')}`,
  )
}

if (errors.length > 0) {
  console.error('page errors:', errors.slice(0, 5))
  failures += 1
}
await browser.close()
console.log(failures === 0 ? '\n✓ jogo verificado no WebMSX real' : `\n✗ ${failures} falha(s)`)
process.exit(failures === 0 ? 0 : 1)
