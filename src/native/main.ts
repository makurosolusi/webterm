// Electrobun main process for the native macOS app: one window on the webterm server for the data dir,
// attached to one that is already running or started in-process on a free loopback port (nativeSession.ts).
// Built by `npm run build:native` (electrobun.config.ts); `electrobun` resolves from the Hutch devkit
// (.hutch/devkit), which does not type-check under this repo's tsconfig: excluded from `npm run typecheck`.
import Electrobun, { ApplicationMenu, BrowserWindow, Utils } from 'electrobun/main'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openNativeSession } from './nativeSession'

const WINDOW_TITLE = 'webterm'
const WINDOW_FRAME = { x: 80, y: 60, width: 1400, height: 900 }
/** electrobun.config.ts `copy` puts dist/ next to the bundled entry dir (Resources/app/bun -> Resources/app/dist). */
const DIST_DIR = join(import.meta.dirname, '../dist')

// The window starts blank and is pointed at the sign-in file once the server writes it. The file
// meta-refreshes to /auth/open?code=; Electrobun's native loadURL prints its argument to stdout
// ("DEBUG loadURLInWebView ... loading URL: %s"), so it only ever sees the file:// path, never the code.
const win = new BrowserWindow({ title: WINDOW_TITLE, frame: WINDOW_FRAME, url: 'about:blank', sandbox: true })

const session = await openNativeSession({
  distDir: DIST_DIR,
  showSignInFile: (path) => { win.webview.loadURL(pathToFileURL(path).href) },
}).catch((err: unknown) => {
  console.error('[webterm] cannot open webterm:', err instanceof Error ? err.message : String(err))
  Utils.quit()
  throw err
})

// WKWebView only gets ⌘C/⌘V/⌘A/⌘Z through the Edit menu's responder roles. No Window menu: ⌘W/⌘T/⌘N
// are left to the page (webterm binds them), and closing the window still works from the title bar.
ApplicationMenu.setApplicationMenu([
  { submenu: [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'showAll' }, { type: 'separator' }, { role: 'quit' }] },
  { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
])

// Quit (⌘Q, last window closed, SIGTERM) is vetoed once so an in-process server stops first, then quits
// for real. stop() also closes the SQLite stores: Electrobun's native exit skips the process `exit` hook.
// Attached to an external server: quit() is a no-op, that server keeps running.
let stopped = false
Electrobun.events.on('before-quit', (e: { response?: { allow: boolean } }) => {
  if (stopped) return
  e.response = { allow: false }
  session.quit()
    .catch((err: unknown) => console.error('[webterm] cannot stop the server cleanly:', err))
    .finally(() => { stopped = true; Utils.quit() })
})
