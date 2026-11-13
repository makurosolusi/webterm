// Process-level handler for promise rejections nobody caught.
//
// Bun terminates on an unhandled rejection, but the `exit` hook then sees code 0, so the log read
// "webterm stopping {code:0}" — a crash dressed up as a clean stop. Installing a handler replaces
// that default, so this one keeps the fail-loud semantics of Node's `--unhandled-rejections=throw`:
// log the cause, then exit 1. Keeping the process alive instead (VS Code's `onUnexpectedError`)
// would run a terminal server in an unknown state; known triggers are fixed at their source
// (e.g. `serveAsset`), and a supervisor or the user restarts with tmux sessions intact.
import type { Logger } from './logs'

/** Exit status for a crash caused by an unhandled rejection (Node's default is also 1). */
export const UNHANDLED_REJECTION_EXIT_CODE = 1

/**
 * Build the `unhandledRejection` listener: log with context, flush the log to disk, then exit non-zero.
 * The flush matters as in `onUncaughtExceptionMonitor`: under Electrobun the exit is native and skips
 * the `exit` hook, so a buffered line (the cause) would be lost.
 */
export function onUnhandledRejection(
  log: Pick<Logger, 'error'>,
  flush: () => void,
  exit: (code: number) => void = (code) => process.exit(code)
): (reason: unknown) => void {
  return (reason) => {
    const what = reason instanceof Error ? `${reason.name}: ${reason.message}` : `non-error value (${typeof reason})`
    log.error('server.unhandled_rejection', `Unhandled promise rejection, exiting: ${what}`, {
      exitCode: UNHANDLED_REJECTION_EXIT_CODE,
      stack: reason instanceof Error ? reason.stack : undefined,
    })
    flush()
    exit(UNHANDLED_REJECTION_EXIT_CODE)
  }
}

/**
 * Build the `uncaughtExceptionMonitor` listener: log the exception and flush the log to disk at once.
 * Observe-only (the crash still happens). The flush is the point: inside the native app Electrobun's own
 * `uncaughtException` handler exits natively (forceExit) without the `exit` hook, so a buffered line would
 * be lost and the crash would leave nothing in the log.
 */
export function onUncaughtExceptionMonitor(log: Pick<Logger, 'error'>, flush: () => void): (err: Error) => void {
  return (err) => {
    log.error('server.error', `Uncaught exception: ${err.name}: ${err.message}`, { stack: err.stack })
    flush()
  }
}
