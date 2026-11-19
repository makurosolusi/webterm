// Signed-in browser window without a secret in any URL bar, argv or HTTP response (Jupyter's
// `use_redirect_file`). A one-time code (single use, CODE_TTL_MS) is written into a 0600 HTML file
// under <dataDir>/run/ that meta-refreshes to `/auth/open?code=`; the OS opener gets the file PATH
// only (`ps` shows argv to a sandboxed agent). `/auth/open` (routes/auth.routes.ts) trades the code
// for the HttpOnly `wt_ui` cookie and deletes the file.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_HOST, tokensMatch } from './auth'
import { childEnv } from './childEnv'
import { assertPathArg } from './openArgGuard'
import { createLogger } from './logs'

const log = createLogger('auth')

/** Lifetime of an open code; short because macOS `open` runs outside the agent sandbox. */
export const CODE_TTL_MS = 60_000
const CODE_BYTES = 32
const RUN_DIR_MODE = 0o700
const OPEN_FILE_MODE = 0o600
/** Data-dir subfolder for runtime files (the redirect file). Listed in agentSandbox AGENT_SECRET_ENTRIES. */
export const RUN_SUBDIR = 'run'
/** A `Host` naming this machine's loopback; only such a Host may steer where the redirect file points. */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/

/** Launch the OS default handler for a file path. The seam tests replace: never a real browser there.
 *  An in-process host (src/server/embedHost.ts) loads the same path in its own window instead. */
export type OpenFile = (path: string) => Promise<void>

export interface UiOpener {
  /** Mint a code (replacing any pending one), write the redirect file, hand its path to the opener.
   *  `next`: a path already passed through safeNext; `/auth/open` re-validates it anyway.
   *  `launch` false: write the file only, for a local process that loads it itself (the native app
   *  attaching to this server, src/native/nativeSession.ts); the 0600 file is still the only carrier. */
  open(hostHeader?: string, next?: string, launch?: boolean): Promise<void>
  /** Spend `candidate`: true exactly once for the pending, unexpired code. */
  consume(candidate: string | null): boolean
}

/** Default opener: `open` (macOS), `xdg-open` (Linux), `explorer.exe` (Windows); argv = the path. */
export const openWithSystem: OpenFile = (path) => {
  assertPathArg(path, 'uiOpen')
  if (process.env.NODE_ENV === 'test') return Promise.reject(new Error('refusing to launch a browser under a test runner'))
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [path], { stdio: 'ignore', detached: true, env: childEnv() })
    child.once('error', (err) => reject(new Error(`cannot launch ${cmd} to open the sign-in page`, { cause: err })))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

/** Origin the redirect file points at: the caller's loopback Host when it names our port (so the
 *  cookie lands on the host the user's tab uses), else the bind host. Never a foreign Host: the file
 *  would hand the code to it. */
export function openOrigin(bindHost: string, port: number, hostHeader?: string): string {
  const m = hostHeader ? LOOPBACK_HOST.exec(hostHeader) : null
  if (m && Number(m[2]) === port) return `http://${hostHeader}`
  const host = bindHost === '0.0.0.0' || bindHost === '::' ? DEFAULT_HOST : bindHost
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function redirectHtml(url: string): string {
  const u = escapeHtml(url)
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${u}"><title>Opening webterm</title></head>` +
    `<body><p><a href="${u}">Open webterm</a></p></body></html>\n`
}

/** Fresh 0600 file in a real (non-symlink) 0700 dir: an agent must not redirect the write elsewhere. */
function writeRedirectFile(runDir: string, file: string, html: string): void {
  mkdirSync(runDir, { recursive: true, mode: RUN_DIR_MODE })
  if (lstatSync(runDir).isSymbolicLink()) throw new Error(`refusing to write the sign-in file: ${runDir} is a symlink`)
  rmSync(file, { force: true })
  writeFileSync(file, html, { mode: OPEN_FILE_MODE, flag: 'wx' }) // wx: O_EXCL, never follows a planted link
}

/** Name of the redirect file server process `pid` writes under its run dir. */
export const signInFileName = (pid: number): string => `open-${pid}.html`

export function createUiOpener(o: { runDir: string; bindHost: string; port: number; openFile?: OpenFile; now?: () => number }): UiOpener {
  const now = o.now ?? Date.now
  const openFile = o.openFile ?? openWithSystem
  const file = join(o.runDir, signInFileName(process.pid))
  let pending: { code: string; expires: number } | null = null
  const discard = () => {
    pending = null
    rmSync(file, { force: true })
  }
  return {
    async open(hostHeader, next, launch = true) {
      const code = randomBytes(CODE_BYTES).toString('base64url')
      const nextQuery = next && next !== '/' ? `&next=${encodeURIComponent(next)}` : ''
      try {
        writeRedirectFile(o.runDir, file, redirectHtml(`${openOrigin(o.bindHost, o.port, hostHeader)}/auth/open?code=${code}${nextQuery}`))
      } catch (err) {
        throw new Error(`cannot write the sign-in file in ${o.runDir}`, { cause: err })
      }
      pending = { code, expires: now() + CODE_TTL_MS }
      // Expired codes leave no file behind; unref: never holds the process open.
      setTimeout(() => { if (pending?.code === code) discard() }, CODE_TTL_MS).unref()
      if (!launch) return log.info('auth.open_file_written', 'Wrote a sign-in file for a local window', { file: `${RUN_SUBDIR}/${signInFileName(process.pid)}` })
      await openFile(file)
      log.info('auth.open_window', 'Opened a signed-in webterm window', { file: `${RUN_SUBDIR}/${signInFileName(process.pid)}` })
    },
    consume(candidate) {
      if (pending === null || typeof candidate !== 'string') return false
      if (now() > pending.expires) { discard(); return false }
      if (!tokensMatch(pending.code, candidate)) return false
      discard()
      return true
    },
  }
}

/** Boot: open a signed-in window only on a data dir with no live session and a terminal attached
 *  (piped stdio = a test runner, a service or another agent's shell: no tabs from those). */
export async function autoOpenAtBoot(d: { sessionCount: () => number; opener: UiOpener; interactive: boolean }): Promise<'opened' | 'has_sessions' | 'not_interactive' | 'failed'> {
  try {
    // Inside the try: a session store that cannot open must not become an unhandled rejection at boot.
    if (d.sessionCount() > 0) return 'has_sessions'
    if (!d.interactive) return 'not_interactive'
    await d.opener.open()
    return 'opened'
  } catch (err) {
    log.warn('auth.open_boot_failed', 'Cannot open a signed-in webterm window at boot', { cause: err instanceof Error ? err.message : String(err) })
    return 'failed'
  }
}
