// Applies a classifier verdict to a pending ledger approval card: on `allow` the card is approved by
// `classifier` exactly like a human click (same digest + nonce check, single use stays with the consumer), and
// its inbox row is closed with "auto-approved by classifier: <reason>". On `ask` nothing changes: the card waits.
import type { Database } from 'bun:sqlite'
import { recordEvent } from '../events/producers'
import { createLogger } from '../logs'
import { syncApprovalGates } from '../inbox/inboxItemStore'
import { execWrite, getRow } from '../ledger/ledgerCore'
import { decideApproval } from '../ledger/ledgerApproval'
import { LedgerError } from '../ledger/ledgerModel'
import { CLASSIFIER_ACTOR, classifyGated, type Classifier, type ClassifyDeps, type GatedAction, type GatedOutcome } from './policy.classifier'
import { createClaudeClassifier } from './policy.classifier.claude'

/** Inbox resolution text of a card the classifier approved. */
export const autoApprovedText = (reason: string): string => `auto-approved by classifier: ${reason}`

/** Approves pending card `id` as the classifier; false when it is no longer pending (a human was faster). */
export function approveByClassifier(db: Database, id: string, reason: string, now: () => number = Date.now): boolean {
  const ctx = { db, now }
  syncApprovalGates(ctx) // the inbox row must exist so the resolution below is visible
  const row = getRow(db, "SELECT d.action_digest, d.nonce FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id = ? AND a.status = 'pending'", id)
  if (!row) return false
  try {
    decideApproval(ctx, id, { actor: CLASSIFIER_ACTOR, approve: true, digest: String(row['action_digest']), nonce: String(row['nonce']) })
  } catch (err) {
    if (err instanceof LedgerError) return false // expired or decided between the read and the write
    throw new Error(`classifier approve ${id} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  execWrite(db, "UPDATE inbox_item SET status = 'done', resolution = ?, updated_at = ? WHERE approval_id = ?", autoApprovedText(reason), now(), id)
  return true
}

export interface CardDeps extends Partial<ClassifyDeps> { db: Database }

const log = createLogger('policy')
let shared: Classifier | null = null
/** Process-wide `claude -p` classifier (one hourly cap for the whole server). */
export function defaultClassifier(): Classifier {
  shared ??= createClaudeClassifier()
  return shared
}

/** Classifies `a` (which names its card in `approvalId`) and approves the card on `allow`. Never throws. */
export async function classifyCard(deps: CardDeps, a: GatedAction & { approvalId: string }): Promise<GatedOutcome> {
  const outcome = await classifyGated({ classifier: deps.classifier ?? defaultClassifier(), record: deps.record ?? recordEvent, ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}), ...(deps.now ? { now: deps.now } : {}) }, a)
  if (outcome.effect !== 'allow') return outcome
  try {
    return approveByClassifier(deps.db, a.approvalId, outcome.reason, deps.now) ? outcome : { ...outcome, effect: 'ask', reason: 'card already decided' }
  } catch (err) {
    log.warn('policy.classifier.approve_failed', 'classifier verdict could not be applied; the card keeps waiting', { ids: { requestId: a.approvalId }, cause: err instanceof Error ? err.message : String(err) })
    return { effect: 'ask', by: 'failure', reason: 'could not approve the card' }
  }
}
