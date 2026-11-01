import {
  type AppendEventInput,
  type LedgerEvent,
  type ListEventsInput,
  LedgerError,
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

/** Appends one audit event; joins an ambient transaction when the caller opened one. */
export function appendEvent(ctx: LedgerContext, input: AppendEventInput): LedgerEvent {
  const actor = requireText(input.actor, 'event.actor')
  const kind = requireText(input.kind, 'event.kind')
  const ts = input.now ?? ctx.now()
  const payload = jsonOf(input.payload, 'event.payload')
  const seq = tx(ctx, () =>
    execInsert(
      ctx.db,
      `INSERT INTO event (ts, project_id, task_id, run_id, actor, kind, payload_json, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ts,
      input.projectId ?? null,
      input.taskId ?? null,
      input.runId ?? null,
      actor,
      kind,
      payload,
      input.correlationId ?? null
    )
  )
  const row = getRow(ctx.db, 'SELECT * FROM event WHERE seq = ?', seq)
  if (!row) throw new LedgerError(`event insert did not return a row (seq=${seq})`)
  return toEvent(row)
}

/** Ascending-seq page of events; limit defaults to 100 and is clamped to 500. */
export function listEvents(ctx: LedgerContext, input: ListEventsInput = {}): LedgerEvent[] {
  const where: string[] = []
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

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new LedgerError(`listEvents: limit must be a positive number, got ${limit}`)
  }
  return Math.min(MAX_PAGE, Math.trunc(limit))
}
