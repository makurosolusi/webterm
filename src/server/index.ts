// Server entry (`bun src/server/index.ts`, the compiled binary, the native app's import). Static imports here
// stay side-effect free apart from the CLI gate: with top-level await, a sibling import starts evaluating
// before an earlier sibling's await settles, so the server (which opens webterm.db at import) is loaded
// dynamically, only once the CLI gate and the single-instance guard are done.
// Must stay the first import: CLI flags (--help, --version, ...) exit before the server module loads.
import './cli/cliGate'
import { dataDir } from './config'
import { embedHost } from './embedHost'
import { ALREADY_RUNNING_EXIT_CODE, AlreadyRunningError, assertSoleServer } from './instanceGuard'

// Another live server for this data dir: refuse before any DB opens or a port binds. The CLI and the binary
// print one line and exit; an in-process host (the native app) gets the error from its import() instead.
try {
  await assertSoleServer(dataDir())
} catch (err) {
  if (!(err instanceof AlreadyRunningError) || embedHost() !== null) throw err
  process.stderr.write(`${err.message}\n`)
  process.exit(ALREADY_RUNNING_EXIT_CODE)
}

// The login shell's PATH, merged before server.main loads and spawns anything (tmux probe, launch profile
// Test, headless claude). After the guard so a second instance exits without paying the shell run (up to
// 5 s); the guard itself spawns nothing. Dynamic for the same import-order reason as server.main.
const { mergeLoginShellPath } = await import('./loginShellPath')
mergeLoginShellPath()
// After the login-shell merge so the managed custom-bin dir stays FIRST on PATH for every later reader.
const { bootCustomBin } = await import('./customCommands.store')
bootCustomBin()

const server = await import('./server.main')
/** Resolves once the main listener is bound; for an in-process host (src/native) that imports this module. */
export const ready = server.ready
/** Open a signed-in UI window through the opener (the in-process host's window when one is registered). */
export const openUi = server.openUi
/** Stop the server in-process (listeners, sockets, stores); see server.main.ts. */
export const stopServer = server.stopServer
