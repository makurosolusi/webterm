// SessionStart extras for the agent-status hook reply: the cached identifier card, the open gate
// count, and the user's verified procedural memory. Called by `agentStatusApi` next to
// `nextAwareness`; null on every other event (the card's changes are announced by linkNote /
// hookContext / linkAwareness, and procedural facts are a per-session block, like CLAUDE.md).
import type { Database } from 'bun:sqlite'
import type { Workspace } from '../../shared/workspace'
import { eventBus } from '../events/eventBus'
import { allRows } from '../ledger/ledgerCore'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { createLogger } from '../logs'
import { createAwarenessCards } from './awarenessCard'
import { proceduralBlock } from './proceduralMemory'

const log = createLogger('hooks')

/** Process subscriber, started at import so peer statuses seen before the first SessionStart count. */
const cards = createAwarenessCards(eventBus)

/** Pending, unexpired approvals ("gates" waiting for the user). */
export function openGates(db: Database, now = Date.now()): number {
  const row = allRows(db, "SELECT COUNT(*) AS n FROM approval WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > ?)", now)[0]
  return Number(row?.['n'] ?? 0)
}

/**
 * SessionStart → card (+ gates line, + procedural block when there is a ledger); anything else → null.
 * Never throws: a broken ledger costs the block, not the hook reply.
 */
export function awarenessExtras(
  nodeId: string, event: string | undefined, ws: Workspace | null | undefined,
  db: Database | null = activeLedgerRuntime()?.db ?? null,
): string | null {
  if (event !== 'SessionStart' || !ws) return null
  const parts = [cards.card(nodeId, ws)]
  if (db) {
    try {
      // ponytail: gate count is one COUNT per SessionStart (approvals emit no bus event yet); cache it once they do.
      const gates = openGates(db)
      if (gates) parts[0] += `\nOpen gates waiting for the user: ${gates}.`
      const rules = proceduralBlock(db)
      if (rules) parts.push(rules)
    } catch (err) {
      log.warn('hooks.awareness.ledger_failed', 'awareness ledger read failed; card sent without it', { ids: { nodeId }, cause: err instanceof Error ? err.message : String(err) })
    }
  }
  return parts.join('\n\n')
}

/** Forget a node's card (node removed / session closed). */
export function forgetAwarenessCard(nodeId: string): void {
  cards.forget(nodeId)
}
