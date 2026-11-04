// Process wiring for the sleep-time consolidator: one instance on the Senses bus over the active ledger,
// the real haiku runner and the session registry's transcript paths. Zero-config: started by the first
// import of the awareness hook (awarenessHook.ts), never under a test runner, so no test can reach a model.
import { eventBus } from '../../events/eventBus'
import { activeLedgerRuntime } from '../../ledger/ledgerRuntimeState'
import { createLogger } from '../../logs'
import { createClaudeConsolidatorModel } from './consolidator.runner'
import { type Consolidator, createConsolidator } from './consolidator.runtime'

const log = createLogger('memory')
let instance: Consolidator | null = null

/**
 * True under bun test / vitest. NODE_ENV alone is not enough: a test may set it to `production` and leak it
 * into later files of the same `bun test` process, so the runner's argv (test files) and VITEST count too.
 */
export function underTestRunner(env: Record<string, string | undefined> = process.env, argv: readonly string[] = process.argv): boolean {
  return env.NODE_ENV === 'test' || env.VITEST !== undefined || argv.some((a) => /\.test\.tsx?$/.test(a))
}

/** Idempotent. Transcript paths come from `sessions`, imported lazily (it imports the hook path itself). */
export function startConsolidator(env: Record<string, string | undefined> = process.env): Consolidator | null {
  if (instance || underTestRunner(env)) return instance
  let transcriptOf: (nodeId: string) => string | undefined = () => undefined
  void import('../../sessions').then(({ sessions }) => { transcriptOf = (id) => sessions.getTranscript(id) })
    .catch((err: unknown) => log.warn('memory.consolidator.sessions_failed', 'consolidator cannot read transcripts', { cause: err instanceof Error ? err.message : String(err) }))
  instance = createConsolidator({
    db: () => activeLedgerRuntime()?.db ?? null,
    transcriptOf: (id) => transcriptOf(id),
    model: createClaudeConsolidatorModel(),
    now: Date.now,
    warn: (message, fields) => log.warn('memory.consolidator.run_failed', message, fields),
  }, eventBus)
  return instance
}

/** The running consolidator, or null (tests, or not started yet). */
export const activeConsolidator = (): Consolidator | null => instance
