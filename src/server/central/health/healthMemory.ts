/**
 * Decision 5 (central-health.md): a dismissal is a human decision, so it becomes one project memory and Central
 * does not argue it again from recall. Same write path as workMemory.ts (fact, trust `attested`: the server vouches
 * the human pressed dismiss; the title is repo data). Reopen supersedes the fact instead of forgetting it, so the
 * history stays and a later dismissal with the same words is not blocked by a tombstone.
 */
import type { Database } from 'bun:sqlite'
import type { FindingView } from '../../../shared/centralHealth'
import { newId, tx } from '../../ledger/ledgerCore'
import { createLogger } from '../../logs'
import { contentHash } from '../../memory/memoryConsolidate'
import { appendMemoryEvent, memoryContext } from '../../memory/memoryCore'
import { findRowByKey, insertMemoryRow, supersedeRow } from '../../memory/memoryInsert'
import { MAX_BODY_CHARS, MAX_TITLE_CHARS } from '../../memory/memoryRemember'
import { redactSecrets } from '../../redactSecrets'

const log = createLogger('central.health')
const SOURCE_KIND = 'central_finding'
const ACTOR = 'system:health'

const clean = (text: string): string => redactSecrets(text.replace(/\s+/g, ' ').trim())
/** The memory slot of one finding's dismissal. */
export const dismissalKey = (findingId: string): string => `health.finding.${findingId}.dismissed`

/** Retires the active dismissal fact of `f`, if any; returns whether one was retired. */
function retire(db: Database, f: FindingView, now: number, event: string): boolean {
  const row = findRowByKey(db, f.projectId, 'project', dismissalKey(f.id))
  if (row === null || row.status === 'superseded') return false
  supersedeRow(db, row, now)
  appendMemoryEvent(memoryContext(db, now), row.id, ACTOR, event, { actorKind: 'system', findingId: f.id }, now)
  return true
}

/** Writes "the user dismissed ..." for a just-dismissed finding, replacing an older dismissal of the same finding. */
export function rememberDismissal(db: Database, f: FindingView, now: number): void {
  const title = clean(`Dismissed health finding: ${f.title}`).slice(0, MAX_TITLE_CHARS)
  const where = f.line === null ? f.file : `${f.file}:${f.line}`
  const day = new Date(now).toISOString().slice(0, 10)
  const body = clean(`The user dismissed health finding '${f.title}' (${f.rule}, ${where}) on ${day}: ${f.dismissedReason ?? 'no reason given'}`).slice(0, MAX_BODY_CHARS)
  tx(memoryContext(db, now), () => {
    retire(db, f, now, 'memory.health_dismissal_replaced')
    const id = newId()
    insertMemoryRow(db, {
      id, projectId: f.projectId, scope: 'project', key: dismissalKey(f.id), title, body, status: 'fact', kind: 'decision', trust: 'attested',
      sourceKind: SOURCE_KIND, sourceRef: f.id, supersedes: null, contentHash: contentHash(title, body), staleAfter: null, verifiedAt: now, now,
    })
    appendMemoryEvent(memoryContext(db, now), id, ACTOR, 'memory.health_dismissal', { actorKind: 'system', findingId: f.id, by: f.dismissedBy }, now)
  })
}

/** Supersedes the dismissal fact of a reopened finding. */
export function forgetDismissal(db: Database, f: FindingView, now: number): void {
  tx(memoryContext(db, now), () => { retire(db, f, now, 'memory.health_dismissal_reopened') })
}

/** Runs a memory write for a dismiss/reopen; a failure is logged with the finding id and never fails the action. */
export function syncDismissalMemory(db: Database, f: FindingView, now: number): void {
  try {
    if (f.status === 'dismissed') rememberDismissal(db, f, now)
    else forgetDismissal(db, f, now)
  } catch (err) {
    log.warn('health.memory_write_failed', `could not record the ${f.status === 'dismissed' ? 'dismissal' : 'reopen'} of health finding ${f.id} in memory`, { findingId: f.id, projectId: f.projectId, error: err instanceof Error ? err.message : String(err) })
  }
}
