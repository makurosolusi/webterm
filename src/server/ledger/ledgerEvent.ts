import {
  type AppendEventInput,
  type LedgerEvent,
  type ListEventsInput,
  LedgerError,
  LedgerNotFoundError,
} from './ledgerModel'
import {
  type LedgerContext,
  execInsert,
  getRow,
  jsonOf,
  requireText,
  toEvent,
  tx,
  allRows,
} from './ledgerCore'

const DEFAULT_PAGE = 100
const MAX_PAGE = 500

export interface PageBounds {
  def?: number
  max?: number
  label?: string
}

/**
 * Shared finite-int clamp for list options. Rejects NaN/Infinity instead of
 * letting SQLite bind them (which surfaces as a raw `datatype mismatch`).
 */
export function clampLimit(value: number | undefined, bounds: PageBounds = {}): number {
  const { def = DEFAULT_PAGE, max = MAX_PAGE, label = 'listEvents' } = bounds
  if (value === undefined) return def
  if (!Number.isFinite(value) || value <= 0) {
    throw new LedgerError(`${label}: limit must be a positive number, got ${value}`)
  }
  return Math.min(max, Math.trunc(value))
}

/** Non-negative finite offset; non-numeric input is a typed caller error. */
export function clampOffset(value: number | undefined, label = 'listEvents'): number {
  if (value === undefined) return 0
  if (!Number.isFinite(value) || value < 0) {
    throw new LedgerError(`${label}: offset must be a non-negative number, got ${value}`)
  }
  return Math.trunc(value)
}

interface EventRefs {
  projectId: string | null
  taskId: string | null
  runId: string | null
}

/**
 * Audit rows must not point across projects, and a dangling parent should be a
 * typed not-found rather than a bare SQLite FK error.
 */
function assertEventRefs(ctx: LedgerContext, refs: EventRefs): void {
  const { projectId, taskId, runId } = refs
  if (projectId !== null && getRow(ctx.db, 'SELECT 1 AS one FROM project WHERE id = ?', projectId) === null) {
    throw new LedgerNotFoundError('project', projectId)
  }
  let taskProject: string | null = null
  if (taskId !== null) {
    const row = getRow(ctx.db, 'SELECT project_id FROM task WHERE id = ?', taskId)
    if (!row) throw new LedgerNotFoundError('task', taskId)
    taskProject = String(row['project_id'])
  }
  if (projectId !== null && taskProject !== null && projectId !== taskProject) {
    throw new LedgerError(
      `event projectId ${projectId} disagrees with task ${taskId} (project ${taskProject})`
    )
  }
  if (runId !== null && getRow(ctx.db, 'SELECT 1 AS one FROM run WHERE id = ?', runId) === null) {
    throw new LedgerNotFoundError('run', runId)
  }
}

/** Appends one audit event; joins an ambient transaction when the caller opened one. */
export function appendEvent(ctx: LedgerContext, input: AppendEventInput): LedgerEvent {
  const actor = requireText(input.actor, 'event.actor')
  const kind = requireText(input.kind, 'event.kind')
  const ts = input.now ?? ctx.now()
  const payload = jsonOf(input.payload, 'event.payload')
  const refs: EventRefs = {
    projectId: input.projectId ?? null,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
  }
  const seq = tx(ctx, () => {
    assertEventRefs(ctx, refs)
    try {
      return execInsert(
        ctx.db,
        `INSERT INTO event (ts, project_id, task_id, run_id, actor, kind, payload_json, correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ts,
        refs.projectId,
        refs.taskId,
        refs.runId,
        actor,
        kind,
        payload,
        input.correlationId ?? null
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('FOREIGN KEY constraint failed')) {
        throw new LedgerError(
          `event references a missing row (projectId=${refs.projectId}, taskId=${refs.taskId}, runId=${refs.runId})`,
          { cause: err }
        )
      }
      throw err
    }
  })
  const row = getRow(ctx.db, 'SELECT * FROM event WHERE seq = ?', seq)
  if (!row) throw new LedgerError(`event insert did not return a row (seq=${seq})`)
  return toEvent(row)
}

/**
 * Ascending-seq page of ledger audit events; limit defaults to 100 and is clamped to 500.
 * Senses rows (hash-chained, schema v10, src/server/events/) share the `event` table and are
 * excluded unless `includeSenses` is set; read them through the events log instead.
 */
export function listEvents(ctx: LedgerContext, input: ListEventsInput & { includeSenses?: boolean } = {}): LedgerEvent[] {
  const where: string[] = input.includeSenses ? [] : ['hash IS NULL']
  const params: unknown[] = []
  if (input.projectId !== undefined) {
    where.push('project_id = ?')
    params.push(input.projectId)
  }
  if (input.taskId !== undefined) {
    where.push('task_id = ?')
    params.push(input.taskId)
  }
  if (input.afterSeq !== undefined) {
    where.push('seq > ?')
    params.push(input.afterSeq)
  }
  const limit = clampLimit(input.limit)
  const sql =
    'SELECT * FROM event' +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY seq ASC LIMIT ?'
  return allRows(ctx.db, sql, ...params, limit).map(toEvent)
}
