// Central's open duties: tasks it delegated whose latest attempt went wrong. The state header lists them and the
// escalation ladder (workEscalation.ts) walks them, so both read the same rows from one query.
import type { Database } from 'bun:sqlite'
import type { WorkStatus } from '../../../shared/centralWork'
import { allRows, parseJson } from '../../ledger/ledgerCore'

/**
 * A task in one of these, whose latest attempt Central started, is Central's to fix. So is a `todo` task whose
 * latest attempt never got sent (task.assign on an existing card puts it back where it was).
 */
export const DUTY_STATUSES: readonly WorkStatus[] = ['stalled', 'failed', 'waiting_input']

export interface Duty {
  taskId: string
  projectId: string
  title: string
  nodeId: string
  status: WorkStatus
  /** The submit code of a failed send, else the reason of the move into `status`. */
  reason: string | null
  /** Attempt number of the latest assignment. */
  attempts: number
  /** When the task entered `status`. */
  since: number
  /** Only for a failed send: true means the prompt still sits in the input box (press Enter, do not retype). */
  textLeftInBox?: boolean
}

const PLACEHOLDERS = DUTY_STATUSES.map(() => '?').join(', ')

// One statement, no per-task reads: the "started by Central" test is the same as workCheckin's handoff check
// (the latest attempt's work.assignment.open event has actor 'central').
const dutiesSql = (oneTask: boolean): string => `
SELECT t.id, t.project_id, t.title, t.status, t.updated_at, a.node_id, a.attempt, a.end_reason, a.result_json,
  (SELECT e.ts FROM event e WHERE e.correlation_id = t.id AND json_extract(e.payload_json, '$.to') = t.status ORDER BY e.seq DESC LIMIT 1) AS since,
  (SELECT json_extract(e.payload_json, '$.reason') FROM event e WHERE e.correlation_id = t.id AND json_extract(e.payload_json, '$.to') = t.status ORDER BY e.seq DESC LIMIT 1) AS move_reason
FROM central_task t
JOIN central_assignment a ON a.task_id = t.id AND a.attempt = (SELECT MAX(x.attempt) FROM central_assignment x WHERE x.task_id = t.id)
WHERE (t.status IN (${PLACEHOLDERS}) OR (t.status = 'todo' AND a.end_reason = 'send_failed'))${oneTask ? ' AND t.id = ?' : ''}
  AND EXISTS (SELECT 1 FROM event e WHERE e.correlation_id = t.id AND e.kind = 'work.assignment.open' AND e.actor = 'central' AND json_extract(e.payload_json, '$.assignmentId') = a.id)
ORDER BY since DESC, t.id
LIMIT ?`

const DUTIES_SQL = dutiesSql(false)
const DUTY_SQL = dutiesSql(true)

/** Whether a task is an open duty right now. */
export function isDuty(db: Database, taskId: string): boolean {
  return allRows(db, DUTY_SQL, ...DUTY_STATUSES, taskId, 1).length > 0
}

/** Open duties, newest first; `limit` bounds the scan. */
export function listDuties(db: Database, limit: number): Duty[] {
  return allRows(db, DUTIES_SQL, ...DUTY_STATUSES, limit).map((r) => {
    const result = r.end_reason === 'send_failed' ? (parseJson(r.result_json) ?? {}) as { reason?: unknown; textLeftInBox?: unknown } : null
    const reason = typeof result?.reason === 'string' ? result.reason : r.move_reason === null ? null : String(r.move_reason)
    return {
      taskId: String(r.id), projectId: String(r.project_id), title: String(r.title), nodeId: String(r.node_id), status: r.status as WorkStatus,
      reason, attempts: Number(r.attempt), since: r.since === null ? Number(r.updated_at) : Number(r.since),
      ...(typeof result?.textLeftInBox === 'boolean' ? { textLeftInBox: result.textLeftInBox } : {}),
    }
  })
}
