import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

// Frontend build/dev config. In dev the server (src/server/index.ts) runs this in
// middleware mode on the single app port; `vite build` emits dist/ for prod.
/** `/m` (no slash) -> `/m/`: the PWA scope and the multi-page entry `m/index.html` both live under `/m/`. */
const mobileSlash: Plugin = {
  name: 'webterm-mobile-slash',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const [pathname, query] = (req.url ?? '').split('?')
      if (pathname !== '/m') return next()
      res.statusCode = 308
      res.setHeader('Location', `/m/${query ? `?${query}` : ''}`)
      res.end()
    })
  },
}

/** A chunk group for the JS modules `re` matches. CSS is left out so it keeps its place in main.css's cascade order. */
const group = (name: string, re: RegExp) => ({ name, test: (id: string): boolean => re.test(id) && !id.endsWith('.css') })
/** Vite's default chunk-size warning, still enforced for every chunk that is not Monaco. */
const APP_CHUNK_LIMIT_KB = 500
/** Above the largest Monaco chunk (ts.worker, ~7 MB). */
const MONACO_CHUNK_LIMIT_KB = 8000
/** Warns on a non-Monaco chunk over APP_CHUNK_LIMIT_KB, the check `chunkSizeWarningLimit` can no longer make. */
const appChunkBudget: Plugin = {
  name: 'webterm-app-chunk-budget',
  apply: 'build',
  generateBundle(_options, bundle) {
    for (const c of Object.values(bundle)) {
      if (c.type !== 'chunk' || c.moduleIds.every((id) => id.includes('node_modules/monaco-editor/'))) continue
      const kb = Buffer.byteLength(c.code) / 1000
      if (kb > APP_CHUNK_LIMIT_KB) this.warn(`${c.fileName} is ${kb.toFixed(0)} kB (> ${APP_CHUNK_LIMIT_KB} kB): lazy-load or split it`)
    }
  },
}

export default defineConfig({
  root: 'src/client',
  // Two pages: the desktop canvas and the /m PWA (src/client/mobile, no canvas/xterm/Monaco).
  // Its manifest, icons and service worker are plain files in src/client/public/m.
  build: {
    outDir: '../../dist', emptyOutDir: true,
    // Monaco's workers and editor.api are lazy (lazyMonaco.tsx) and inherently multi-MB; the limit only
    // has a number, so it is raised past them and `appChunkBudget` keeps the 500 kB check for the rest.
    chunkSizeWarningLimit: MONACO_CHUNK_LIMIT_KB,
    rolldownOptions: {
      input: { main: path.resolve(process.cwd(), 'src/client/index.html'), m: path.resolve(process.cwd(), 'src/client/m/index.html') },
      // The board's big start-up libs in their own chunks (cached across app releases). Only desktop-only libs
      // the first paint needs, plus React (both pages need all of it): a group puts every module it matches on
      // the load path of whatever imports one of them, so a shared group (radix, src/shared) made /m and lazy
      // panels fetch the board's share. The rest is left to automatic splitting.
      output: {
        codeSplitting: {
          groups: [
            group('react', /node_modules[\\/](react|react-dom|scheduler)[\\/]/),
            group('xyflow', /node_modules[\\/](@xyflow|d3-[a-z]+)[\\/]/),
            group('xterm', /node_modules[\\/]@xterm[\\/]xterm[\\/]/),
            group('xterm-addons', /node_modules[\\/]@xterm[\\/]addon-/),
            group('vscode-elements', /node_modules[\\/](@vscode-elements|lit|lit-html|lit-element|@lit)[\\/]/),
          ],
        },
      },
    },
  },
  plugins: [react(), tailwindcss(), mobileSlash, appChunkBudget],
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src/client'),
    },
  },
  // *.bun.test.ts need Bun globals (Bun.Terminal); they run under `bun test`, not vitest.
  // dir '../..' scans the repo root (so src/shared + src/server vitest files are
  // found), but a custom `exclude` replaces vitest's defaults — so the noise dirs
  // (.git/.cache/out) must be re-listed or discovery globs .git and hangs.
  // Discover tests outside src/client (root) by reaching up with `../` globs —
  // `dir` hangs discovery in vitest 5. The `../**` exclude variant is needed
  // because `**` won't cross a `..` segment, so plain `**/*.bun.test.ts` misses
  // the parent-relative server bun tests.
  test: {
    // Temp WEBTERM_DATA_DIR + HOME for the whole run (see the file's header).
    globalSetup: [path.resolve(process.cwd(), 'src/testIsolation.setup.ts')],
    include: ['**/*.test.{ts,tsx}', '../shared/**/*.test.{ts,tsx}', '../server/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.bun.test.ts', '../**/*.bun.test.ts'],
  }
})
