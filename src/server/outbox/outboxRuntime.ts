// The process-wide outbox. Started lazily (idempotent) by the first user: the link-note loop
// (first Claude hook) or the enqueue endpoint. Deps are imported dynamically because `db`,
// `sessions` and the ledger pull `bun:sqlite` and the PTY, which node-env tests must never load.
import { eventBus } from '../events/eventBus'
import { recordEvent } from '../events/producers'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { LINK_NOTE_OP } from '../linkNoteDelivery'
import { claudeChannelAdapter } from './outboxChannel'
import { agentIn, OutboxDelivery, subscribeOutbox } from './outboxDelivery'
import { createOutboxStore } from './outboxStore'

let starting: Promise<OutboxDelivery> | undefined
let active: OutboxDelivery | undefined

export function startOutbox(): Promise<OutboxDelivery> {
  starting ??= (async () => {
    const [{ db }, { sessions }] = await Promise.all([import('../db'), import('../sessions')])
    // ponytail: with the ledger off (mode off / failed to open) the outbox lives in memory, so
    // queued mail does not survive a restart in that degraded mode; the ledger is on by default.
    const ledgerDb = activeLedgerRuntime()?.db ?? (await import('../ledger/migration')).openLedgerDb(':memory:')
    const outbox = new OutboxDelivery({
      store: createOutboxStore(ledgerDb),
      agentOf: (id) => agentIn(db.list(), id),
      sessions,
      record: recordEvent,
      channel: claudeChannelAdapter(),
    })
    subscribeOutbox(outbox, eventBus)
    active = outbox
    // A link note describes the cables of one PTY, which died with the old process: stale, so it is
    // cancelled, never typed. Everything else queued before the restart is redriven.
    for (const n of outbox.queuedNodes()) outbox.cancel(n, LINK_NOTE_OP)
    void outbox.kickAll()
    return outbox
  })()
  return starting
}

/** The hook route's half (sync): context-only mail for this hook's additionalContext, or null
 *  before the outbox started. */
export function outboxHookContext(nodeId: string, event: string | undefined): string | null {
  return active?.takeHookContext(nodeId, event) ?? null
}
