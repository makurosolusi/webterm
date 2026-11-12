// Terminal notices for a session that could not start or exited because its program was missing.
// Only the error text or a binary NAME is ever printed: a launch line can carry secret-bearing args.
import { PROBE_TEXT } from './claudeLauncher/claudeLaunch.probe'
import { redactSecrets } from './redactSecrets'
import { isClaudeToken } from '../shared/claudeLaunch/claudeLaunch.normalize'

/** Longest cause shown in the node; an error message is one line, anything longer is noise. */
export const OPEN_FAILED_CAUSE_MAX = 200

/** The open threw before any process ran (agent-211-A1). VS Code prints the same shape in the
 *  terminal itself: "The terminal process failed to launch: <reason>". */
export function openFailedNotice(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const cause = redactSecrets(raw.split('\n')[0] ?? '').slice(0, OPEN_FAILED_CAUSE_MAX) || 'unknown error'
  return `\r\n[webterm] This session could not start: ${cause}\r\n`
}

/** An agent whose program is not on PATH (agent-211-A2), in the Settings preflight's own words.
 *  Thrown by `open` before spawning, so the node shows it through `openFailedNotice`. */
export function missingBinaryText(bin: string): string {
  const text = isClaudeToken(bin) ? PROBE_TEXT.claudeMissing : `${bin} was not found on PATH. Install it and try again.`
  return `${text} Or fix the launch command in Settings › Claude.`
}
