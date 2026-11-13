// Electrobun main process for the native macOS app: one window on the webterm server for the data dir,
// attached to one that is already running or started in-process on a free loopback port (nativeSession.ts).
// Loaded only by the router in main.ts, never for a hidden subcommand: importing `electrobun/main` loads the
// native libraries, overrides process.exit and installs Electrobun's worker crash handlers at import time.
// Built by `npm run build:native` (electrobun.config.ts); `electrobun` resolves from the Hutch devkit
// (.hutch/devkit), which does not type-check under this repo's tsconfig: excluded from `npm run typecheck`.
import Electrobun, { ApplicationMenu, BrowserWindow, Utils } from 'electrobun/main'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openNativeSession } from './nativeSession'
import { sessionErrorDialog } from './sessionError'
import { installUpdate, startUpdateChecks, updateReady } from './updater'

const WINDOW_TITLE = 'webterm'
const WINDOW_FRAME = { x: 80, y: 60, width: 1400, height: 900 }
/** electrobun.config.ts `copy` puts dist/ next to the bundled entry dir (Resources/app/bun -> Resources/app/dist). */
const DIST_DIR = join(import.meta.dirname, '../dist')
/** The bundle this runtime runs (Resources/app/bun/index.js): children re-enter it for hidden subcommands
 *  (selfLaunch.ts). Not process.argv[1]: that is Electrobun's launcher (Resources/main.js), which would start
 *  a second app. */
const SELF_ENTRY = import.meta.path

// The window starts blank and is pointed at the sign-in file once the server writes it. The file
// meta-refreshes to /auth/open?code=; Electrobun's native loadURL prints its argument to stdout
// ("DEBUG loadURLInWebView ... loading URL: %s"), so it only ever sees the file:// path, never the code.
const win = new BrowserWindow({ title: WINDOW_TITLE, frame: WINDOW_FRAME, url: 'about:blank', sandbox: true })

const session = await openNativeSession({
  distDir: DIST_DIR,
  selfEntry: SELF_ENTRY,
  showSignInFile: (path) => { win.webview.loadURL(pathToFileURL(path).href) },
}).catch(async (err: unknown) => {
  console.error('[webterm] cannot open webterm:', err instanceof Error ? err.message : String(err))
  // Electrobun 2.0.6 Utils.showMessageBox (api/sdks/main/core/Utils.ts): modal, resolves once OK is clicked.
  await Utils.showMessageBox({ type: 'error', buttons: ['OK'], defaultId: 0, cancelId: 0, ...sessionErrorDialog(err) })
  Utils.quit()
  throw err
})

// WKWebView only gets ⌘C/⌘V/⌘A/⌘Z through the Edit menu's responder roles. No Window menu: ⌘W/⌘T/⌘N
// are left to the page (webterm binds them), and closing the window still works from the title bar.
// Once an update is downloaded the app menu offers "Restart to Update"; not choosing it is "Later": the staged
// update stays on disk and the next launch's check tells the user again. (No message box: Electrobun's
// showMessageBox is a synchronous FFI call that would stall the in-process server while it is open, and the
// helper always relaunches the app, so applying on a plain quit would reopen a window the user just closed.)
const RESTART_TO_UPDATE = 'restart-to-update'
function setMenu(updateVersion: string | null): void {
  const update = updateVersion === null ? [] : [{ label: `Restart to Update (${updateVersion})`, action: RESTART_TO_UPDATE }, { type: 'separator' }]
  ApplicationMenu.setApplicationMenu([
    { submenu: [...update, { role: 'hide' }, { role: 'hideOthers' }, { role: 'showAll' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  ])
}
setMenu(null)

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

// Restart to Update: stop the server through the same quit path first (Updater.applyUpdate asks the before-quit
// handlers synchronously, so the async stop cannot run inside it), then let the updater quit and relaunch.
// If the helper cannot start, an attached window keeps running; an embedded one has no server left, so it quits.
async function restartToUpdate(): Promise<void> {
  if (!updateReady()) return
  console.info('[webterm] restarting to install the downloaded update')
  await session.quit().catch((err: unknown) => console.error('[webterm] cannot stop the server cleanly:', err))
  stopped = true
  if (await installUpdate()) return
  Utils.showNotification({ title: 'webterm update failed', body: session.mode === 'embedded' ? 'The update could not be installed. webterm will quit; open it again.' : 'The update could not be installed. webterm keeps running.' })
  if (session.mode === 'embedded') Utils.quit()
  else stopped = false
}
ApplicationMenu.on('application-menu-clicked', (e: unknown) => {
  if ((e as { data?: { action?: string } }).data?.action !== RESTART_TO_UPDATE) return
  restartToUpdate().catch((err: unknown) => console.warn('[webterm] restart to update failed:', err))
})

// After the window is up: never blocks startup (the first check waits FIRST_CHECK_DELAY_MS in updatePolicy.ts).
startUpdateChecks((version) => setMenu(version))
