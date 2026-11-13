// A child's stdin pipe emits 'error' (EPIPE, ECONNRESET) when the child exits before reading it:
// a missing script, a crash at start-up, a git that rejects its args. With no listener that error
// is an uncaught exception, which in the native app is `forceExit(1)` of the whole app. The child's
// exit code / 'close' event already tells the caller what happened, so the stream error is only logged.
import type { Writable } from 'node:stream'
import { createLogger } from './logs'

const log = createLogger('child.stdin')

/** Context for the log line: what the call was for and which binary ran. Never argv (may carry secrets). */
export interface ChildStdinContext { op: string; command: string }

/** Attaches the stdin 'error' listener once; safe to call before any number of writes. */
export function guardChildStdin(stdin: Writable | null | undefined, ctx: ChildStdinContext): void {
  if (!stdin || stdin.listenerCount('error') > 0) return
  stdin.on('error', (e: NodeJS.ErrnoException) => {
    log.debug('child.stdin.error', `stdin of ${ctx.command} (${ctx.op}) failed: ${e.code ?? e.message}`, { op: ctx.op, command: ctx.command, code: e.code })
  })
}

/** Guards stdin, then writes `data` (if any) and closes it. */
export function endChildStdin(stdin: Writable | null | undefined, data: string | undefined, ctx: ChildStdinContext): void {
  if (!stdin) return
  guardChildStdin(stdin, ctx)
  stdin.end(data ?? '')
}
