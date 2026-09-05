import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const online = process.argv.includes('--online')
const port = Number(process.env.MSX_PORT ?? 0)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('MSX_PORT must be 0–65535')
let child = null
let server = null
const run = (command, args, env = process.env) => new Promise((resolve, reject) => {
  console.log(`\n→ ${command} ${args.join(' ')}`)
  child = spawn(command, args, { cwd: root, stdio: 'inherit', env })
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    child = null
    console.log(`exit: ${code ?? signal}`)
    if (code === 0) resolve()
    else reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal})`))
  })
})
const stop = async () => {
  child?.kill('SIGTERM')
  await server?.close()
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void stop().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
})

try {
  if (!online) {
    await run('pnpm', ['lint'])
    await run('pnpm', ['build'])
    await run(process.execPath, ['--test', 'tools/guards.test.mjs'])
  }
  server = await createServer({ root, server: { host: '127.0.0.1', port, strictPort: true, hmr: false } })
  // Vite's listen() normalizes port 0 to 5173. Its HTTP server still initializes
  // Vite on listen and lets the OS allocate a port without a reservation race.
  await new Promise((resolve, reject) => {
    const http = server.httpServer
    const onError = (error) => { http.off('listening', onListening); reject(error) }
    const onListening = () => { http.off('error', onError); resolve() }
    http.once('error', onError)
    http.once('listening', onListening)
    http.listen(port, '127.0.0.1')
  })
  const address = server.httpServer.address()
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port')
  const env = { ...process.env, MSX_URL: `http://127.0.0.1:${address.port}/`, MSX_OFFLINE: online ? '0' : '1' }
  console.log(`Owned verification server: ${env.MSX_URL} (${online ? 'CDN required' : 'CDN blocked'})`)
  const tools = online
    ? ['verify-interactions2.mjs', 'probe-game.mjs']
    : ['verify-keymap.mjs', 'verify-textures.mjs', 'verify-physics.mjs', 'verify-interactions2.mjs']
  for (const tool of tools) await run(process.execPath, [`tools/${tool}`], env)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await stop()
}
