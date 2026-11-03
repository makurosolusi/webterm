// Post-turn context bookkeeping (WS-19 wiring of WS-06): `ctx_tokens` and the checkpoint. Both only run
// with `WEBTERM_CENTRAL_CHECKPOINT=on`, so with the flag off a finished turn writes exactly what it always did.
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
 * Records the prompt-side size of a succeeded turn and starts a checkpoint without awaiting it.
 * ponytail: `result.usage` is the turn total, so over several tool steps it overestimates the window
 * (it errs toward rotating early); switch to the last step's usage once the runtime exposes it.
 */
export function recordTurnContext(deps: TurnContextDeps, conversationId: string, turnId: string, result: RuntimeResult): void {
  if (result.outcome !== 'success' || !flagOn(deps.env[CHECKPOINT_FLAG])) return
  try {
    recordCtxTokens(deps.db, turnId, ctxTokensOf(result.usage))
  } catch (err) {
    log.warn('central.turn.ctx_tokens_failed', 'could not record ctx_tokens', { turnId, error: err instanceof Error ? err.name : typeof err })
    return
  }
  if (!deps.summarize) return
  void createCheckpoint({ db: deps.db, conversationId, summarize: deps.summarize, now: deps.now }).catch((err: unknown) =>
    log.warn('central.turn.checkpoint_failed', 'checkpoint after turn failed', { turnId, error: err instanceof Error ? err.name : typeof err }))
}
