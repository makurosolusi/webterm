// SessionStart extras for the agent-status hook reply: the cached identifier card, the open gate
// count, and the user's verified procedural memory. Called by `agentStatusApi` next to
// `nextAwareness`. Also the project rules in force (rules/rulesAwareness.ts): with the rest on
// SessionStart, and on UserPromptSubmit only when they changed. Every other event → null (the card's
// changes are announced by linkNote / hookContext / linkAwareness; procedural facts are per session).
import type { Database } from 'bun:sqlite'
import type { Workspace } from '../../shared/workspace'
import { eventBus } from '../events/eventBus'
import { allRows } from '../ledger/ledgerCore'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { createLogger } from '../logs'
import { createAwarenessCards } from './awarenessCard'
import { proceduralBlock } from './proceduralMemory'
import { createRulesAwareness, loadRules } from '../rules/rulesAwareness'

const log = createLogger('hooks')

/** Process subscriber, started at import so peer statuses seen before the first SessionStart count. */
const cards = createAwarenessCards(eventBus)

/** Project rules per folder, warmed off the hook path (rules/rulesAwareness.ts). */
export const projectRules = createRulesAwareness({
  load: loadRules,
  now: Date.now,
  onError: (_cwd, err) => log.warn('hooks.awareness.rules_failed', 'project rules read failed; reply sent without them', { cause: err instanceof Error ? err.message : String(err) }),
})

/** Rules text for this reply; a bug in the rules path costs the block, not the hook reply. */
function rulesFor(nodeId: string, event: string | undefined, ws: Workspace): string | null {
  try {
    return projectRules.next(nodeId, event, ws.nodes.find((n) => n.id === nodeId)?.cwd || ws.cwd || '')
  } catch (err) {
    log.warn('hooks.awareness.rules_failed', 'project rules block failed; reply sent without it', { ids: { nodeId }, cause: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** Pending, unexpired approvals ("gates" waiting for the user). */
export function openGates(db: Database, now = Date.now()): number {
  const row = allRows(db, "SELECT COUNT(*) AS n FROM approval WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > ?)", now)[0]
  return Number(row?.['n'] ?? 0)
}

/**
 * SessionStart → card (+ gates line, + procedural block when there is a ledger, + cached project rules);
 * UserPromptSubmit → changed project rules or null; anything else → null.
 * Never throws: a broken ledger costs the block, not the hook reply.
 */
export function awarenessExtras(
  nodeId: string, event: string | undefined, ws: Workspace | null | undefined,
  db: Database | null = activeLedgerRuntime()?.db ?? null,
): string | null {
  if (!ws) return null
  // Every hook call keeps the rules cache warm; after SessionStart only a change is re-sent.
  const rules = rulesFor(nodeId, event, ws)
  if (event !== 'SessionStart') return rules
  const parts = [cards.card(nodeId, ws)]
  if (db) {
    try {
      // ponytail: gate count is one COUNT per SessionStart (approvals emit no bus event yet); cache it once they do.
      const gates = openGates(db)
      if (gates) parts[0] += `\nOpen gates waiting for the user: ${gates}.`
      const procedural = proceduralBlock(db)
      if (procedural) parts.push(procedural)
    } catch (err) {
      log.warn('hooks.awareness.ledger_failed', 'awareness ledger read failed; card sent without it', { ids: { nodeId }, cause: err instanceof Error ? err.message : String(err) })
    }
  }
  if (rules) parts.push(rules)
  return parts.join('\n\n')
}

/** Forget a node's card (node removed / session closed). */
export function forgetAwarenessCard(nodeId: string): void {
  cards.forget(nodeId)
  projectRules.forget(nodeId)
}
