import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  plugins: [{
    name: 'build-version',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'application-version', content: version }, injectTo: 'head' }],
  }],
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        /**
         * Vite 8 bundles with rolldown, which only accepts the *function* form of
         * `manualChunks` — the Rollup object form fails the build outright
         * ("manualChunks is not a function"). Same split, expressed as a matcher.
         */
        manualChunks(id: string): string | undefined {
          if (id.includes('/node_modules/three/')) return 'three'
          if (id.includes('/node_modules/postprocessing/')) return 'postfx'
          return undefined
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    /**
     * Under `MSX_CAPTURE=1` the HMR error dialog is suppressed. It exists so a
     * stale overlay can never composite itself into a captured frame — which is
     * exactly how half of a review round's shots ended up being a screenshot of
     * a parse error. The capture harness still aborts on console errors and on
     * a scene that never signals ready, so suppressing the dialog hides nothing.
     */
    hmr: { overlay: process.env['MSX_CAPTURE'] !== '1' },
  },
})
