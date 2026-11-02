import { defineConfig } from 'vitest/config'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

// Frontend build/dev config. In dev the server (src/server/index.ts) runs this in
// middleware mode on the single app port; `vite build` emits dist/ for prod.
export default defineConfig({
  root: 'src/client',
  build: { outDir: '../../dist', emptyOutDir: true },
  plugins: [react(), tailwindcss()],
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
    include: ['**/*.test.{ts,tsx}', '../shared/**/*.test.{ts,tsx}', '../server/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.bun.test.ts', '../**/*.bun.test.ts'],
  }
})
