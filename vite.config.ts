import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Frontend build/dev config. In dev the server (src/server/index.ts) runs this in
// middleware mode on the single app port; `vite build` emits dist/ for prod.
export default defineConfig({
  root: 'src/client',
  build: { outDir: '../../dist', emptyOutDir: true },
  plugins: [react()]
})
