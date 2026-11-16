// The escalation ladder for Central's open duties (workDuties.ts). Rung 1 is the worker nudge (workSupervisor),
// rung 2 wakes Central (the stall/fail move, then once more after a check-in turn left it unresolved), rung 3 tells
// the user. Every rung fires once per attempt (dedupe key / notice key) and leaves a timeline event on the task.
// Bounded: retries end in a visible notice, never in silence.
import type { Database } from 'bun:sqlite'
import { previewText } from '../../events/producers'
import { getRow } from '../../ledger/ledgerCore'
import { appendEvent } from '../../ledger/ledgerEvent'
import { listDuties, type Duty } from './workDuties'
import { WORK_LIVENESS_RULES } from './workSupervisor'

export const ESCALATE_EVENT = 'work.escalate'
const SCAN_LIMIT = 200
const TITLE_CHARS = 60
const MINUTE_MS = 60_000

export interface EscalationDeps {
  db: Database
  /** Whether a check-in about this project could be delivered now (setting on, budget left, not halted). */
  canWake(projectId: string): boolean
  /** Queues a `task_duty` reason; returns whether a new row was written. */
  enqueue(dedupeKey: string, duty: Duty, text: string): boolean
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
