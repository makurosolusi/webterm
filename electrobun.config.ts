// Electrobun (native macOS shell) config: `npm run build:native` / `npm run dev:native`.
// The main process is src/native/main.ts, a router: hidden subcommands (selfLaunch.ts) go to the CLI gate, anything
// else loads nativeApp.ts, which attaches to the data dir's running server or runs one in-process; the window
// loads the server's own URL, so there is no separate view bundle.
import pkg from './package.json'
import { UPDATE_BASE_URL } from './src/native/release.config'

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
      // System WKWebView only: the app stays small and needs no Chromium of its own. No CEF variant is
      // shipped or scripted (it added ~hundreds of MB and a second renderer to test for no feature we use).
      bundleCEF: false,
      defaultRenderer: 'native',
      createDmg: false,
      // Placeholder "wt" monogram. Regenerate from assets/native/icon.svg: `sips -s format png icon.svg --out
      // icon1024.png`, then `sips -z N N` into icon_<s>x<s>.png and @2x for s in 16 32 128 256 512.
      icons: 'assets/native/icon.iconset',
    },
  },
  // Update host (src/native/release.config.ts): baked into the app's version.json for Updater checks, and used
  // by Hutch on a stable build to diff against the previously published release (delta .patch). Empty: neither.
  release: { baseUrl: UPDATE_BASE_URL },
}
