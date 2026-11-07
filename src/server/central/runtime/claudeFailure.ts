// Turns how a Claude child failed (spawn errno, exit status, stderr tail, failed `result` text) into
// one human, input-free reason for the chat, plus whether a plain retry can help. Text is redacted
// and capped by `stderrReason`; the prompt never reaches here (it only goes to stdin).
import type { RuntimeResult, TurnInput } from './centralRuntime'
import type { ClaudeTurnState, TurnFailure } from './claudeSession'
import { stderrReason } from './runtimeShared'
import { createLogger } from '../../logs'

const log = createLogger('central')

/** Chat note when a missing resumed session was replaced by a fresh one (the earlier context is gone). */
export const FRESH_SESSION_NOTICE = 'Started a fresh Claude session; the previous one was no longer available.'

export interface ClaudeFailureFacts {
  /** errno code of a failed spawn (`ENOENT`, `EACCES`, ...). */
  spawnCode?: string
  exitCode: number | null
  signal: string | null
  stderr: string
  /** Whether the `system/init` record arrived (Claude actually started). */
  sawInit: boolean
  /** Error text of a failed `result` record, when one arrived. */
  resultText?: string | null
  secrets: ReadonlyArray<string | undefined>
}

const AUTH = /not logged in|please run \/login|invalid api key|authentication[_ ]failed|oauth token (?:has )?expired|\b401\b/i
const UNKNOWN_OPTION = /unknown option|unrecognized option|unknown argument/i
const NO_SESSION = /no conversation found with session id/i
const TRANSIENT = /overloaded|rate.?limit|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|\b5\d\d\b/i

/** Claude could not resume the requested session (its failed result text or stderr says so). */
export function isMissingSession(resultText: string | null | undefined, stderr: string): boolean {
  return NO_SESSION.test(resultText ?? '') || NO_SESSION.test(stderr)
}

/** Classifies a Claude failure that has no more specific code; `reason` is already redacted. */
export function classifyClaudeFailure(f: ClaudeFailureFacts): TurnFailure {
  if (f.spawnCode === 'ENOENT') return { code: 'runtime_unavailable', unavailable: 'claude_not_found' }
  if (f.spawnCode) {
    return { code: 'runtime_error', reason: `Claude could not be started (${f.spawnCode}): check the Claude launch profile in Settings` }
  }
  const text = `${f.resultText ?? ''}\n${f.stderr}`
  if (AUTH.test(text)) return { code: 'runtime_unavailable', unavailable: 'claude_not_authenticated' }
  const detail = stderrReason(f.resultText ?? '', f.secrets) || stderrReason(f.stderr, f.secrets)
  if (NO_SESSION.test(text)) {
    return { code: 'runtime_error', reason: 'Claude could not find the saved session for this chat; start a new chat to continue' }
  }
  if (UNKNOWN_OPTION.test(text)) {
    return { code: 'runtime_error', reason: `Claude rejected an option (${detail}): your Claude CLI may be too old, run "claude update"` }
  }
  const when = f.sawInit ? '' : ' before starting'
  if (f.resultText) return { code: 'runtime_error', retryable: TRANSIENT.test(text), reason: `Claude reported an error${when}: ${detail}` }
  // A signal we did not send (cancel/timeout are handled before this) is usually an OOM kill or a restart.
  if (f.exitCode === null && f.signal) return { code: 'runtime_error', retryable: true, reason: `Claude was stopped by ${f.signal}${when}` }
  const status = f.exitCode === null ? 'ended without a result' : `exited with code ${f.exitCode}`
  return { code: 'runtime_error', retryable: TRANSIENT.test(text), reason: `Claude ${status}${when}${detail ? `: ${detail}` : ''}` }
}

/**
 * One server-side line per failed turn, so a "Claude could not start" report is diagnosable from the log.
 * Ids, codes, lengths and the redacted first stderr line only: no prompt, no env values, no tokens.
 */
export function logTurnFailed(
  input: TurnInput, state: ClaudeTurnState, result: RuntimeResult,
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined,
  launch: { argv0: string; profileId: string } | null, secrets: readonly string[]
): void {
  if (result.errorCode === 'cancelled') return
  const firstLine = state.stderrTail.split('\n').find((line) => line.trim().length > 0) ?? ''
  log.error('central.turn.failed', 'central turn failed', {
    turnId: input.turnId, conversationId: input.conversationId, code: result.errorCode ?? 'runtime_error',
    exitCode: exit?.code ?? null, signal: exit?.signal ?? null, spawnErrorCode: state.spawnError?.code ?? null,
    sawInit: state.sawInit, stderrChars: state.stderrTail.length, stderrFirstLine: stderrReason(firstLine, secrets),
    reason: state.failure?.reason ?? null, argv0: launch?.argv0 ?? null, profileId: launch?.profileId ?? null,
  })
}
