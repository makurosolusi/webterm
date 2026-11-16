// The escalation ladder for Central's open duties (workDuties.ts). Rung 1 is the worker nudge (workSupervisor),
// rung 2 wakes Central (the stall/fail move, then once more after a check-in turn left it unresolved), rung 3 tells
// the user. Every rung fires once per attempt (dedupe key / notice key) and leaves a timeline event on the task.
// Bounded: retries end in a visible notice, never in silence.
// Tasks nobody is working on (reported/verifying/needs_review) are walked by `escalateLeases` from their stored lease.
import type { Database } from 'bun:sqlite'
import { previewText } from '../../events/producers'
import { allRows, getRow } from '../../ledger/ledgerCore'
import { appendEvent } from '../../ledger/ledgerEvent'
import { listDuties, type Duty } from './workDuties'
import { WORK_LIVENESS_RULES } from './workSupervisor'

export const ESCALATE_EVENT = 'work.escalate'
/** Rule of a rung taken because a verifier / human lease ran out (the rung's reason says which). */
export const LEASE_RULE = 'lease_expired'
const SCAN_LIMIT = 200
const TITLE_CHARS = 60
const MINUTE_MS = 60_000

export interface EscalationDeps {
  db: Database
  /** Whether a check-in about this project could be delivered now (setting on, budget left, not halted). */
  canWake(projectId: string): boolean
  /** Queues a `task_duty` reason; returns whether a new row was written. */
  enqueue(dedupeKey: string, duty: Duty, text: string): boolean
  /** Queues a `task_report` reason for a task nobody owns an open duty for; returns whether a new row was written. */
  enqueueLease(dedupeKey: string, task: { taskId: string; projectId: string }, text: string): boolean
  /** Idempotent by key; returns whether the notice was new. */
  notice(key: string, text: string, projectId: string): boolean
  projectName(id: string): string
}

/** Plain-English state of a duty, e.g. `failed (not_started; the prompt is still in its input box)`. */
export function dutyState(d: Duty): string {
  const box = d.textLeftInBox === true ? '; the prompt is still in its input box' : d.textLeftInBox === false ? '; the prompt was not left in its input box' : ''
  return `${d.status}${d.reason ? ` (${d.reason}${box})` : ''}`
}

/** Walks every open duty once; called from the check-in tick. */
export function escalateDuties({ db, canWake, enqueue, notice, projectName }: EscalationDeps, at: number): void {
  const { escalate } = WORK_LIVENESS_RULES
  for (const d of listDuties(db, SCAN_LIMIT)) {
    const age = at - d.since
    if (age < escalate.graceMs) continue
    const base = `escalate:${d.taskId}:${d.attempts}`
    const label = `task "${previewText(d.title, TITLE_CHARS) ?? d.taskId}" in project ${projectName(d.projectId)}`
    const note = (rung: number, reason: string): void => {
      appendEvent({ db, now: () => at }, { kind: ESCALATE_EVENT, actor: `system:${escalate.name}`, projectId: d.projectId, correlationId: d.taskId, payload: { rung, rule: escalate.name, reason } })
    }
    const wakes = Number(getRow(db, 'SELECT COUNT(*) AS n FROM central_checkin_reason WHERE task_id = ? AND sent_at >= ? AND turn_id IS NOT NULL', d.taskId, d.since)?.n ?? 0)
    const wakeable = canWake(d.projectId)
    if (!wakeable || age >= escalate.afterMs) {
      const tried = !wakeable ? 'Central check-ins are off or used up, so Central was not woken' : `Central was woken ${wakes} time(s)`
      const text = `Central could not fix ${label}: ${dutyState(d)} for ${Math.floor(age / MINUTE_MS)} min. ${tried}. Check node ${d.nodeId} or tell Central what to do.`
      if (notice(`${base}:3`, text, d.projectId)) note(3, tried)
      continue
    }
    // Rung 2 once more: nothing about this task is still waiting in the queue (the first wake went out, or there never was one).
    const pending = getRow(db, 'SELECT 1 AS one FROM central_checkin_reason WHERE task_id = ? AND sent_at IS NULL LIMIT 1', d.taskId)
    if (pending) continue
    if (enqueue(`${base}:2`, d, `${label} is still ${dutyState(d)}; it is listed under Open duties: act on it now`)) note(2, `woken ${wakes} time(s) before`)
  }
}

/**
 * Walks every reported/verifying/needs_review task whose stored lease ran out: the verifier's turn wakes Central once,
 * the human's (and any lease still unanswered one notice window later) becomes a notice. Idempotent per lease value.
 */
export function escalateLeases({ db, canWake, enqueueLease, notice, projectName }: EscalationDeps, at: number): void {
  const { escalate } = WORK_LIVENESS_RULES
  const rows = allRows(db, `SELECT t.id, t.project_id, t.title, t.status, a.id AS aid, a.node_id, a.lease_until FROM central_task t
    JOIN central_assignment a ON a.task_id = t.id AND a.ended_at IS NULL
    WHERE t.status IN ('reported', 'verifying', 'needs_review') AND a.lease_until IS NOT NULL AND a.lease_until <= ? ORDER BY a.lease_until LIMIT ?`, at, SCAN_LIMIT)
  for (const r of rows) {
    const task = { taskId: String(r.id), projectId: String(r.project_id) }
    const lease = Number(r.lease_until)
    /** Minutes since the lease ran out. */
    const idle = Math.floor((at - lease) / MINUTE_MS)
    const status = String(r.status)
    const base = `lease:${String(r.aid)}:${status}:${lease}`
    const label = `task "${previewText(String(r.title), TITLE_CHARS) ?? task.taskId}" in project ${projectName(task.projectId)}`
    const note = (rung: number, reason: string): void => {
      appendEvent({ db, now: () => at }, { kind: ESCALATE_EVENT, actor: `system:${LEASE_RULE}`, projectId: task.projectId, correlationId: task.taskId, payload: { rung, rule: LEASE_RULE, reason } })
    }
    if (status === 'needs_review' || !canWake(task.projectId) || at - lease >= escalate.afterMs) {
      const text = status === 'needs_review'
        ? `${label} is waiting for your review (node ${String(r.node_id)}).`
        : `${label} has been ${status} with nobody picking it up for ${idle} min past its deadline. Check node ${String(r.node_id)} or tell Central what to do.`
      if (notice(`${base}:3`, text, task.projectId)) note(3, `${status}: the owner's lease ran out ${idle} min ago`)
      continue
    }
    if (enqueueLease(`${base}:2`, task, `${label} is ${status} and nobody has picked it up; read it with task.get ${task.taskId} and act on it now`)) note(2, `${status}: the verifier's lease ran out`)
  }
}
