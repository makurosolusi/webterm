// Electrobun (native macOS shell) config: `npm run build:native` / `npm run dev:native`.
// The main process is src/native/main.ts, which runs the webterm server in-process; the window
// loads the server's own URL, so there is no separate view bundle.
import pkg from './package.json'

export default {
  app: {
    name: 'webterm',
    identifier: 'dev.webterm.app',
    version: pkg.version,
  },
  build: {
    mainProcess: 'bun',
    bun: {
      entrypoint: 'src/native/main.ts',
      // The packaged app always serves the built UI, like `build:binary`: compile-time NODE_ENV, so the
      // dev-only Vite import in src/server/index.ts never runs (external, never loaded).
      define: { 'process.env.NODE_ENV': "'production'" },
      // distAssets.generated: `build:binary`'s embedded copy of dist/; the app serves the copied dist/ instead.
      external: ['vite', './distAssets.generated'],
    },
    // The built UI, packaged next to the bun entry dir (Resources/app/dist); main.ts passes that path as distDir.
    copy: { dist: 'dist' },
    mac: {
      bundleCEF: process.env.WEBTERM_NATIVE_CEF === '1',
      defaultRenderer: process.env.WEBTERM_NATIVE_CEF === '1' ? 'cef' : 'native',
      createDmg: false,
    },
  },
}
