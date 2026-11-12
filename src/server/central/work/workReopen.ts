// Undo of auto-done: a task the system closed because its check passed goes back to todo, the memory fact written
// for it (workMemory.ts) is retired, and dependents that were unblocked but not started are blocked again.
// Idempotent: a second click on a task this undo already reopened answers ok. Too late = the task moved on, or a
// dependent already started on top of it.
import type { Database } from 'bun:sqlite'
import type { TaskView } from '../../../shared/centralWork'
import { allRows, getRow, parseJson, tx } from '../../ledger/ledgerCore'
import { appendMemoryEvent, memoryContext } from '../../memory/memoryCore'
import { findRowByKey, supersedeRow } from '../../memory/memoryInsert'
import type { WorkActor, WorkStore } from './workModel'

/** Rule of the reopen move; also how a repeated click is recognised. */
export const REOPEN_RULE = 'auto_done_undo'
const NOT_STARTED = ['todo', 'blocked']

export type ReopenResult = { ok: true; task: TaskView } | { ok: false; status: number; error: string; message: string }

const refuse = (status: number, error: string, message: string): ReopenResult => ({ ok: false, status, error, message })

/** The memory slot workMemory.ts writes for a done task. */
export const outcomeKey = (taskId: string): string => `work.task.${taskId}.outcome`

function retireOutcome(db: Database, task: TaskView, now: number): void {
  tx(memoryContext(db, now), () => {
    const row = findRowByKey(db, task.projectId, 'project', outcomeKey(task.id))
    if (row === null || row.status === 'superseded') return
    supersedeRow(db, row, now)
    appendMemoryEvent(memoryContext(db, now), row.id, 'system:work', 'memory.task_outcome_reopened', { actorKind: 'system', taskId: task.id }, now)
  })
}

function lastRule(db: Database, taskId: string): unknown {
  const row = getRow(db, 'SELECT payload_json FROM event WHERE correlation_id = ? ORDER BY seq DESC LIMIT 1', taskId)
  return row ? (parseJson(row.payload_json) as { rule?: unknown } | null)?.rule : undefined
}

/** Reopens auto-done task `id` for `actor` (the human who pressed Undo). */
export function reopenAutoDone(db: Database, store: WorkStore, id: string, actor: WorkActor, now: number): ReopenResult {
  const task = store.getTask(id)
  if (!task) return refuse(404, 'task_not_found', 'This task no longer exists.')
  if (task.status === 'todo' && lastRule(db, id) === REOPEN_RULE) return { ok: true, task }
  if (task.status !== 'done') return refuse(409, 'too_late', 'Too late to reopen: the task has moved on since it was marked done.')
  const dependents = allRows(db, 'SELECT t.id, t.status FROM central_task t JOIN central_task_dep d ON d.task_id = t.id WHERE d.blocked_by_id = ?', id)
  if (dependents.some((r) => !NOT_STARTED.includes(String(r.status)))) return refuse(409, 'too_late', 'Too late to reopen: a task that depended on it has already started.')
  let reopened: TaskView
  try {
    reopened = store.moveTask(id, 'todo', { actor, rule: REOPEN_RULE, reason: 'reopened: undo of auto-done' })
  } catch (err) {
    // The store refuses a done task that a person closed: only automatic closes are undoable.
    return refuse(409, 'not_auto_done', `Only a task marked done automatically can be reopened (${err instanceof Error ? err.message : String(err)}).`)
  }
  for (const r of dependents) {
    if (r.status === 'todo') store.moveTask(String(r.id), 'blocked', { actor: { kind: 'system' }, rule: 'deps', reason: `dependency ${id} reopened` })
  }
  retireOutcome(db, reopened, now)
  return { ok: true, task: reopened }
}
