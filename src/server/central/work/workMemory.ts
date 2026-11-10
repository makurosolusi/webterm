/**
 * Decision 5, verified results: a task reaching `done` becomes one project memory. Only a human or a
 * passed auto-done check can reach `done`, so the server vouches for it and the row is a `fact` with
 * trust `attested`: `human` would claim a person wrote this text, `agent` would call a checked result unverified.
 */
import type { Database } from 'bun:sqlite'
import { allRows, newId, tx } from '../../ledger/ledgerCore'
import { createLogger } from '../../logs'
import { contentHash } from '../../memory/memoryConsolidate'
import { nodeRef } from '../../memory/memoryControls'
import { appendMemoryEvent, memoryContext } from '../../memory/memoryCore'
import { isIncognito } from '../../memory/memoryGuard'
import { findActiveByHash, insertMemoryRow } from '../../memory/memoryInsert'
import { maskPii } from '../../memory/memoryPii'
import { MAX_BODY_CHARS, MAX_TITLE_CHARS } from '../../memory/memoryRemember'
import { redactSecrets } from '../../redactSecrets'
import type { WorkMove } from './workModel'
import { onWorkMove } from './workStore'

const log = createLogger('central.work')
const SOURCE_KIND = 'central_task'
const ACTOR = 'system:work'
const FALLBACK_RESULT = 'completed'
const MAX_RESULT_CHARS = 300
const MAX_NODES_CHECKED = 50

const clean = (text: string): string => redactSecrets(maskPii(text.replace(/\s+/g, ' ').trim()))

/** The verifier's summary when it passed, else the reason given for the move; never the agent's own report. */
function resultOf({ task, reason }: WorkMove): string {
  const verification = task.verification as { passed?: unknown; summary?: unknown } | null
  const summary = verification?.passed === true && typeof verification.summary === 'string' ? verification.summary : ''
  return clean(summary || reason || FALLBACK_RESULT).slice(0, MAX_RESULT_CHARS) || FALLBACK_RESULT
}

function sessionRefs(db: Database, move: WorkMove): string[] {
  const nodes = allRows(db, 'SELECT DISTINCT node_id FROM central_assignment WHERE task_id = ? LIMIT ?', move.task.id, MAX_NODES_CHECKED)
  return [...(move.task.conversationId ? [move.task.conversationId] : []), ...nodes.map((row) => nodeRef(String(row['node_id'])))]
}

/** Writes the outcome of a task that just reached `done`; idempotent by content hash, silent for an incognito session. */
export function rememberTaskOutcome(db: Database, move: WorkMove, now: number): void {
  if (move.to !== 'done') return
  const { task } = move
  if (isIncognito(db, sessionRefs(db, move))) return
  const title = clean(task.title).slice(0, MAX_TITLE_CHARS)
  const body = `${clean(task.title)}: ${resultOf(move)}`.slice(0, MAX_BODY_CHARS)
  const hash = contentHash(title, body)
  tx(memoryContext(db, now), () => {
    if (findActiveByHash(db, task.projectId, 'project', hash) !== null) return
    const id = newId()
    insertMemoryRow(db, {
      id, projectId: task.projectId, scope: 'project', key: `work.task.${task.id}.outcome`, title, body, status: 'fact', kind: 'episode', trust: 'attested',
      sourceKind: SOURCE_KIND, sourceRef: task.id, supersedes: null, contentHash: hash, staleAfter: null, verifiedAt: now, now,
      sessionRef: task.conversationId, sourceEventId: move.seq,
    })
    appendMemoryEvent(memoryContext(db, now), id, ACTOR, 'memory.task_outcome', { actorKind: 'system', taskId: task.id, seq: move.seq }, now)
  })
}

/** Observes task moves on `db`; a failed write is logged with the task id and never reaches the task. */
export function registerWorkMemory(db: Database, now: () => number): void {
  onWorkMove(db, (move) => {
    try {
      rememberTaskOutcome(db, move, now())
    } catch (err) {
      log.warn('work.memory_write_failed', `could not remember the outcome of done task ${move.task.id}`, { taskId: move.task.id, seq: move.seq, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
