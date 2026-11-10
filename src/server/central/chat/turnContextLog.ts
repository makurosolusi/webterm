// Per-turn context bookkeeping (WS-19 wiring of WS-06): the trace of what a turn was given, `ctx_tokens` and
// the checkpoint. `ctx_tokens` is written for every succeeded turn (it is only a number, and session rotation
// reads it with the flag off too); the checkpoint runs unless `WEBTERM_CENTRAL_CHECKPOINT=off`.
import type { Database } from 'bun:sqlite'
import { createLogger } from '../../logs'
import { createCheckpoint, type Summarize } from '../context/checkpointSummarizer'
import { checkpointOn } from '../context/contextAssembler'
import type { ContextTrace } from '../context/contextPort'
import { ctxTokensOf, recordCtxTokens } from '../context/contextUsage'
import type { RuntimeResult } from '../runtime/centralRuntime'

const log = createLogger('central')

export interface TurnContextDeps {
  db: Database
  env: Record<string, string | undefined>
  now: () => number
  summarize?: Summarize
}

const NO_TRACE: ContextTrace = { memoryIds: [], checkpointId: null, headerHash: '', headerChars: 0, stateVersions: { global: null, project: null } }

/** Stores what the turn was given in `central_turn.context_json`; a failure is logged and never fails the turn. */
export function recordTurnTrace(db: Database, turnId: string, trace: ContextTrace | undefined): void {
  try {
    db.query('UPDATE central_turn SET context_json = ? WHERE id = ?').run(JSON.stringify(trace ?? NO_TRACE), turnId)
  } catch (err) {
    log.warn('central.turn.context_trace_failed', 'could not record the context trace', { turnId, error: err instanceof Error ? err.name : typeof err })
  }
}

/**
 * Records the prompt-side size of a succeeded turn and, unless the checkpoint flag is off, starts a checkpoint
 * without awaiting it. The size is the last model step's (`usage.contextTokens`); a runtime that does not
 * report it falls back to the turn total, which overestimates the window over several tool steps.
 */
export function recordTurnContext(deps: TurnContextDeps, conversationId: string, turnId: string, result: RuntimeResult): void {
  if (result.outcome !== 'success') return
  try {
    recordCtxTokens(deps.db, turnId, result.usage.contextTokens ?? ctxTokensOf(result.usage))
  } catch (err) {
    log.warn('central.turn.ctx_tokens_failed', 'could not record ctx_tokens', { turnId, error: err instanceof Error ? err.name : typeof err })
    return
  }
  if (!deps.summarize || !checkpointOn(deps.env)) return
  void createCheckpoint({ db: deps.db, conversationId, summarize: deps.summarize, now: deps.now }).catch((err: unknown) =>
    log.warn('central.turn.checkpoint_failed', 'checkpoint after turn failed', { turnId, error: err instanceof Error ? err.name : typeof err }))
}
