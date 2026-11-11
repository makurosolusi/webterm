// Preloaded into the dev:fresh server only (devFresh.ts passes `--preload`). The server is spawned
// `detached` (own process group, so stop() reaches its shells and Chromium), which also means it
// survives a SIGKILL of the dev:fresh script. Once our parent is gone (`process.ppid` changes when we
// are reparented, which pid reuse cannot fake) run `dev:fresh --clean`: it stops this server
// gracefully, ends its tmux server and keychain items and deletes the temp root.
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const PARENT_ENV = 'WEBTERM_FRESH_PARENT_PID' // devFresh.ts PARENT_ENV; not imported: this module runs in the server
const WATCH_MS = 2000
/** Backstop when the cleaner could not stop us: SIGTERM ourselves (the server's own graceful path). */
const SELF_STOP_MS = 15_000

const ROOT_ARG = '--webterm-fresh-root=' // devFresh.sweep.ts ROOT_ARG

// The root marker is for `ps` (the sweep proves ownership by it); the server's CLI gate rejects unknown
// flags, so drop it from argv in place before index.ts reads it. `ps` still shows the original argv.
const at = process.argv.findIndex((a) => a.startsWith(ROOT_ARG))
if (at >= 0) process.argv.splice(at, 1)

const parent = Number(process.env[PARENT_ENV])
delete process.env[PARENT_ENV] // shells and agents of this server must not inherit it
if (Number.isInteger(parent) && parent > 1) {
  const t = setInterval(() => {
    if (process.ppid === parent) return
    clearInterval(t)
    const selfStop = () => process.kill(process.pid, 'SIGTERM')
    spawn(process.execPath, ['--no-env-file', join(import.meta.dirname, 'devFresh.ts'), '--clean'], { detached: true, stdio: 'ignore' })
      .once('error', selfStop)
      .unref()
    setTimeout(selfStop, SELF_STOP_MS).unref()
  }, WATCH_MS)
  t.unref()
}
