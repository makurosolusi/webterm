// Per-turn state, error messages, child work dir and kill ladder for the Claude adapter
// (split from `claudeRuntime` for Rule 8; PLAN CENTRAL-RUNTIME-b 1.1/1.2).
import type { ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../../config'
import type { RuntimeErrorCode, RuntimeResult } from './centralRuntime'
import type { TurnEmitter } from './runtimeEvents'
import type { ClaudeResultEvent, ClaudeUsage } from './claudeEvents'
import { type ClaudeUnavailableCode, MICROS_PER_USD } from './claudeOptions'
import { classifyClaudeFailure } from './claudeFailure'

const WORK_DIR_MODE = 0o700
const KILL_LADDER: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGKILL']

export interface TurnFailure {
  code: RuntimeErrorCode
  retryable?: boolean
  /** Which input-free message to use when `code` is `runtime_unavailable`. */
  unavailable?: ClaudeUnavailableCode
  /** Redacted human cause shown instead of the bare `runtime_error` message. */
  reason?: string
}

export interface ClaudeTurnState {
  sessionRef: string | null
  /** The `system/init` record arrived: Claude itself started. */
  sawInit: boolean
  sawDelta: boolean
  /** Latest usage per unique assistant `message.id` (partial mode repeats ids). */
  messages: Map<string, ClaudeUsage>
  /** First failure of the turn; its `error` event has already been emitted. */
  failure: TurnFailure | null
  termination: 'cancelled' | 'timeout' | null
  result: ClaudeResultEvent | null
  retries: number
  spawnError: NodeJS.ErrnoException | null
  /** Bounded tail of the child's stderr, in memory only; redacted before it is logged or surfaced. */
  stderrTail: string
  /** MCP tool calls requested and not yet answered: tool_use id -> name + start time. */
  openTools: Map<string, { name: string; at: number }>
  /** Every tool_use id already announced (partial mode repeats assistant messages). */
  seenTools: Set<string>
}

export function newTurnState(): ClaudeTurnState {
  return { sessionRef: null, sawInit: false, sawDelta: false, messages: new Map(), failure: null,
    termination: null, result: null, retries: 0, spawnError: null, stderrTail: '', openTools: new Map(), seenTools: new Set() }
}

const UNAVAILABLE_MESSAGES: Record<ClaudeUnavailableCode, string> = {
  claude_not_found: 'Claude Code is not installed on the server PATH',
  claude_not_authenticated: 'Claude Code is not signed in: run "claude auth login" on the server machine',
  claude_check_failed: 'Claude Code could not be checked',
}

/** Stable messages, never the prompt; a `runtime_error` with a (redacted) `reason` shows that reason. */
export function runtimeErrorMessage(code: RuntimeErrorCode, unavailable?: ClaudeUnavailableCode, reason?: string): string {
  switch (code) {
    case 'runtime_unavailable':
      return UNAVAILABLE_MESSAGES[unavailable ?? 'claude_check_failed']
    case 'timeout':
      return 'claude timed out'
    case 'cancelled':
      return 'claude turn cancelled'
    case 'max_turns':
      return 'claude turn limit reached'
    case 'budget_exhausted':
      return 'claude budget exhausted'
    case 'unknown_tool':
      return 'claude requested a tool that is not allowed'
    default:
      return reason || 'claude runtime failed'
  }
}

/** Records the first failure and emits its single `error` event; later calls are no-ops. */
export function failTurn(emitter: TurnEmitter, state: ClaudeTurnState, failure: TurnFailure): void {
  if (state.failure !== null) return
  state.failure = failure
  emitter.emit({
    type: 'error', code: failure.code, message: runtimeErrorMessage(failure.code, failure.unavailable, failure.reason),
    retryable: failure.retryable ?? false,
  })
}

/** Creates the empty child cwd (0700, enforced even if it already existed) and returns it. */
export function ensureWorkDir(dir: string = defaultWorkDir()): string {
  mkdirSync(dir, { recursive: true, mode: WORK_DIR_MODE })
  chmodSync(dir, WORK_DIR_MODE)
  return dir
}

/** `<dataDir>/central/work`: an empty directory so project files and CLAUDE.md are not picked up. */
export function defaultWorkDir(): string {
  return join(dataDir(), 'central', 'work')
}

/** SIGINT, then SIGTERM, then SIGKILL, `graceMs` apart; stops escalating once the child has exited. */
export function createKillLadder(child: ChildProcess, graceMs: number): { start(): void; clear(): void } {
  let step = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const next = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill(KILL_LADDER[step])
    step += 1
    if (step < KILL_LADDER.length) {
      timer = setTimeout(next, graceMs)
      timer.unref?.()
    }
  }
  return {
    start: () => { if (step === 0) next() },
    clear: () => { if (timer !== undefined) clearTimeout(timer) },
  }
}

/** Terminal outcome implied by a `result` event. */
export function resultErrorCode(event: ClaudeResultEvent): RuntimeErrorCode | null {
  if (event.subtype === 'success' && !event.isError) return null
  if (event.subtype === 'error_max_turns') return 'max_turns'
  if (event.subtype === 'error_max_budget_usd') return 'budget_exhausted'
  return 'runtime_error'
}

function totalsOf(state: ClaudeTurnState): ClaudeUsage {
  const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const u of state.messages.values()) {
    sum.inputTokens += u.inputTokens
    sum.outputTokens += u.outputTokens
    sum.cacheReadTokens += u.cacheReadTokens
    sum.cacheWriteTokens += u.cacheWriteTokens
  }
  return sum
}

export interface FinishInput {
  state: ClaudeTurnState
  /** Elapsed wall time, used when the CLI reports no duration. */
  elapsedMs: number
  /** Session id used for this turn (the resumed one or the freshly generated one). */
  fallbackSessionRef: string
  /** How the child ended (absent when it never ran); its cause comes from this, stderr and the result text. */
  exit?: { code: number | null; signal: NodeJS.Signals | null }
  /** Child env secret values redacted out of any reason. */
  secrets?: readonly string[]
}

/** Decides the outcome, emits the missing `error` + one `usage`, and closes the turn. */
export function finishTurn(emitter: TurnEmitter, f: FinishInput): RuntimeResult {
  const { state } = f
  let outcome: RuntimeResult['outcome'] = 'success'
  let code: RuntimeErrorCode | undefined
  if (state.termination === 'cancelled') {
    outcome = 'cancelled'
    code = 'cancelled'
  } else if (state.failure !== null) {
    outcome = 'error'
    code = state.failure.code
  } else if (state.termination === 'timeout') {
    outcome = 'error'
    code = 'timeout'
  } else if (state.spawnError !== null) {
    outcome = 'error'
    code = state.spawnError.code === 'ENOENT' ? 'runtime_unavailable' : 'runtime_error'
  } else {
    const failed = state.result === null ? 'runtime_error' : resultErrorCode(state.result)
    if (failed !== null) {
      outcome = 'error'
      code = failed
    }
  }
  if (outcome === 'error' && code !== undefined && state.failure === null) {
    const failure: TurnFailure = state.spawnError !== null || code === 'runtime_error'
      ? classifyClaudeFailure({
        ...(state.spawnError?.code ? { spawnCode: state.spawnError.code } : {}),
        exitCode: f.exit?.code ?? null, signal: f.exit?.signal ?? null, stderr: state.stderrTail,
        sawInit: state.sawInit, resultText: state.result?.errorText ?? null, secrets: f.secrets ?? [],
      })
      : { code }
    failTurn(emitter, state, failure)
    // The classifier may narrow the code (e.g. an auth failure on stderr is `runtime_unavailable`).
    code = failure.code
  }
  const usage = state.result?.usage ?? totalsOf(state)
  const runtimeUsage = {
    ...usage,
    costMicros: Math.round((state.result?.costUsd ?? 0) * MICROS_PER_USD),
    durationMs: state.result?.durationMs ?? f.elapsedMs,
  }
  emitter.emit({ type: 'usage', usage: runtimeUsage })
  return emitter.result(outcome, {
    usage: runtimeUsage,
    ...(code === undefined ? {} : { errorCode: code }),
    sessionRef: outcome === 'success' ? (state.sessionRef ?? f.fallbackSessionRef) : null,
  })
}
