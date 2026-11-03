// Per-turn state and event mapping for the OpenCode adapter, split out of
// `opencodeRuntime` (Rule 8). Also owns the isolated child HOME (RND/28 B6).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../../config'
import type { RuntimeErrorCode, RuntimeUsage } from './centralRuntime'
import type { TurnEmitter } from './runtimeEvents'
import type { OpencodeEvent, OpencodeUsageDelta } from './opencodeEvents'
import { opencodeHomeEnv } from './opencodeOptions'

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costMicros: number
}

export type Termination = 'cancelled' | 'timeout' | null

export interface SessionState {
  sessionRef: string | null
  sawError: boolean
  termination: Termination
}

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 }
}

function addUsage(totals: UsageTotals, delta: OpencodeUsageDelta): void {
  totals.inputTokens += delta.inputTokens
  // Reasoning tokens are generated tokens; RuntimeUsage has no separate bucket.
  totals.outputTokens += delta.outputTokens + delta.reasoningTokens
  totals.cacheReadTokens += delta.cacheReadTokens
  totals.cacheWriteTokens += delta.cacheWriteTokens
  totals.costMicros += delta.costMicros
}

export function toRuntimeUsage(totals: UsageTotals, durationMs: number): RuntimeUsage {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    costMicros: totals.costMicros,
    durationMs: Math.max(0, Math.round(durationMs)),
  }
}

/** Maps one parsed OpenCode event onto the turn emitter, folding usage into `totals`. */
export function applyOpencodeEvent(
  event: OpencodeEvent, emitter: TurnEmitter, totals: UsageTotals,
  startedAt: number, now: number, state: SessionState
): void {
  switch (event.type) {
    case 'text':
      emitter.textDelta(event.text)
      return
    case 'tool.requested':
      emitter.emit({ type: 'tool.requested', toolCallId: event.toolCallId, name: event.name, input: event.input })
      return
    case 'tool.completed':
      emitter.emit({
        type: 'tool.completed',
        toolCallId: event.toolCallId,
        name: event.name,
        ok: event.ok,
        ...(event.output === undefined ? {} : { output: event.output }),
        ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
        durationMs: 0,
      })
      return
    case 'usage':
      addUsage(totals, event.usage)
      emitter.emit({ type: 'usage', usage: toRuntimeUsage(totals, now - startedAt) })
      return
    case 'error':
      // One adapter error event per turn; a later non-zero exit adds no duplicate.
      if (!state.sawError) {
        state.sawError = true
        emitter.emit({ type: 'error', code: event.code, message: event.message, retryable: false })
      }
      return
    default:
      return
  }
}

/** Stable, input-free messages: never echo child output or the prompt. */
export function runtimeErrorMessage(code: RuntimeErrorCode): string {
  switch (code) {
    case 'timeout':
      return 'opencode timed out'
    case 'cancelled':
      return 'opencode turn cancelled'
    case 'max_turns':
      return 'opencode turn limit reached'
    default:
      return 'opencode runtime failed'
  }
}

/** Webterm-owned HOME for the child: `<dataDir>/central/home`, never the user's own. */
export function defaultOpencodeHomeDir(): string {
  return join(dataDir(), 'central', 'home')
}

/** Creates the child HOME and its XDG directories (idempotent). */
export function prepareOpencodeHome(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true })
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    mkdirSync(String(opencodeHomeEnv(homeDir)[key]), { recursive: true })
  }
}
