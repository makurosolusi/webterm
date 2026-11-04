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

export default defineConfig({
  root: 'src/client',
  // Two pages: the desktop canvas and the /m PWA (src/client/mobile, no canvas/xterm/Monaco).
  // Its manifest, icons and service worker are plain files in src/client/public/m.
  build: {
    outDir: '../../dist', emptyOutDir: true,
    rollupOptions: { input: { main: path.resolve(process.cwd(), 'src/client/index.html'), m: path.resolve(process.cwd(), 'src/client/m/index.html') } },
  },
  plugins: [react(), tailwindcss(), mobileSlash],
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
