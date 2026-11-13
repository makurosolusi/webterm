// Electrobun main process for the native macOS app: webterm runs in-process on a free loopback port,
// one window shows it. Built by `npm run build:native` (electrobun.config.ts); `electrobun` resolves
// from the Hutch devkit (.hutch/devkit), which does not type-check under this repo's tsconfig: excluded from `npm run typecheck`.
import Electrobun, { ApplicationMenu, BrowserWindow, Utils } from 'electrobun/main'
import { join } from 'node:path'
import { freeLoopbackPort, startEmbeddedServer } from './embeddedServer'

const WINDOW_TITLE = 'webterm'
const WINDOW_FRAME = { x: 80, y: 60, width: 1400, height: 900 }
/** electrobun.config.ts `copy` puts dist/ next to the bundled entry dir (Resources/app/bun -> Resources/app/dist). */
const DIST_DIR = join(import.meta.dirname, '../dist')

// The window starts blank and is pointed at the one-time sign-in URL once the server mints it.
const win = new BrowserWindow({ title: WINDOW_TITLE, frame: WINDOW_FRAME, url: 'about:blank', sandbox: true })

const server = await startEmbeddedServer({
  port: await freeLoopbackPort(),
  distDir: DIST_DIR,
  openUrl: async (url) => { win.webview.loadURL(url) },
})
await server.openUi()

// WKWebView only gets ⌘C/⌘V/⌘A/⌘Z through the Edit menu's responder roles. No Window menu: ⌘W/⌘T/⌘N
// are left to the page (webterm binds them), and closing the window still works from the title bar.
ApplicationMenu.setApplicationMenu([
  { submenu: [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'showAll' }, { type: 'separator' }, { role: 'quit' }] },
  { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
])

// Quit (⌘Q, last window closed, SIGTERM) is vetoed once so the server stops first, then quits for real.
// stop() also closes the SQLite stores: Electrobun's native exit skips the process `exit` hook.
let stopped = false
Electrobun.events.on('before-quit', (e: { response?: { allow: boolean } }) => {
  if (stopped) return
  e.response = { allow: false }
  server.stop()
    .catch((err: unknown) => console.error('[webterm] cannot stop the server cleanly:', err))
    .finally(() => { stopped = true; Utils.quit() })
})
