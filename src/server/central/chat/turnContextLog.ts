// Post-turn context bookkeeping (WS-19 wiring of WS-06): `ctx_tokens` and the checkpoint. `ctx_tokens` is
// written for every succeeded turn (it is only a number, and session rotation reads it with the flag off
// too); the checkpoint still runs only with `WEBTERM_CENTRAL_CHECKPOINT=on`.
import type { Database } from 'bun:sqlite'
import { flagOn } from '../../envFlag'
import { createLogger } from '../../logs'
import { createCheckpoint, type Summarize } from '../context/checkpointSummarizer'
import { CHECKPOINT_FLAG } from '../context/contextAssembler'
import { ctxTokensOf, recordCtxTokens } from '../context/contextUsage'
import type { RuntimeResult } from '../runtime/centralRuntime'

const log = createLogger('central')

export interface TurnContextDeps {
  db: Database
  env: Record<string, string | undefined>
  now: () => number
  summarize?: Summarize
}

/**
 * Records the prompt-side size of a succeeded turn and, with the checkpoint flag on, starts a checkpoint
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
  if (!deps.summarize || !flagOn(deps.env[CHECKPOINT_FLAG])) return
  void createCheckpoint({ db: deps.db, conversationId, summarize: deps.summarize, now: deps.now }).catch((err: unknown) =>
    log.warn('central.turn.checkpoint_failed', 'checkpoint after turn failed', { turnId, error: err instanceof Error ? err.name : typeof err }))
}
