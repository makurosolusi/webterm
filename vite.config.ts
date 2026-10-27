import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Frontend build/dev config. In dev the server (src/server/index.ts) runs this in
// middleware mode on the single app port; `vite build` emits dist/ for prod.
export default defineConfig({
  root: 'src/client',
  build: { outDir: '../../dist', emptyOutDir: true },
  plugins: [react()],
  // *.bun.test.ts need Bun globals (Bun.Terminal); they run under `bun test`, not vitest.
  test: { exclude: ['**/node_modules/**', '**/dist/**', '**/*.bun.test.ts'] }
})
