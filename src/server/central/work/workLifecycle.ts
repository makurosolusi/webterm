import type { Database } from 'bun:sqlite'
import { canWorkTransition, type TaskView, type WorkStatus } from '../../../shared/centralWork'
import { WorkError, type WorkActor, type WorkStore } from './workModel'
import { buildResult, noResult } from './workResult'
import { createWorkStore } from './workStore'

/** Rule of the move made when a headless (exec) run exits. */
export const EXEC_EXIT_RULE = 'exec_exit'
/** Rule of a move made by `webterm report` (workAgentReport.ts), and the timeline event every report leaves. */
export const AGENT_REPORT_RULE = 'agent_report'
export const AGENT_REPORT_EVENT = 'work.agent_report'
const SYSTEM: WorkActor = { kind: 'system' }

export interface FinishOptions {
  actor: WorkActor
  rule?: string
  reason?: string
  /** Stored as the assignment's end reason; defaults to `reason`, then the target status. */
  endReason?: string
  result?: unknown
}

/** Moves a task off its current attempt (to done/cancelled/failed, or back to todo) and ends its open assignment. */
export function finishTask(store: WorkStore, id: string, to: 'done' | 'cancelled' | 'failed' | 'todo', opts: FinishOptions): TaskView {
  const open = store.openAssignmentOfTask(id)
  const { actor, rule, reason } = opts
  const moved = store.moveTask(id, to, { actor, ...(rule ? { rule } : {}), ...(reason ? { reason } : {}), ...(open ? { assignmentId: open.id } : {}) })
  if (open) store.endAssignment(open.id, opts.endReason ?? reason ?? to, opts.result, { actor, ...(rule ? { rule } : {}) })
  return moved
}

/** Moves the task of `nodeId`'s open attempt to `to` (an `assigned` one passes `running` first); null when no legal move applies. */
export function moveOpenTask(store: WorkStore, nodeId: string, to: WorkStatus, options: { actor: WorkActor; rule: string; reason: string }): WorkStatus | null {
  const a = store.openAssignmentOfNode(nodeId)
  const task = a ? store.getTask(a.taskId) : null
  if (!a || !task) return null
  const opts = { ...options, assignmentId: a.id }
  try {
    if (task.status === 'assigned' && canWorkTransition('running', to)) store.moveTask(task.id, 'running', opts)
    else if (!canWorkTransition(task.status, to)) return null
    store.moveTask(task.id, to, opts)
    return to
  } catch (err) {
    // Another signal moved the task first (CAS lost): the report is still recorded, it just makes no move.
    if (err instanceof WorkError && (err.code === 'concurrent_update' || err.code === 'illegal_transition')) return null
    throw err
  }
}

/** A headless run exited: exit 0 reports the task (the verifier then checks it), anything else fails it. */
export function settleExecTask(db: Database, now: () => number, nodeId: string, outcome: { ok: boolean; reason: string; tail?: string }): WorkStatus | null {
  const store = createWorkStore(db, now)
  // The run's output tail is its only report; keep it on the assignment before the task moves (it used to live in memory only).
  const open = store.openAssignmentOfNode(nodeId)
  if (open) store.recordResult(open.id, outcome.tail === undefined ? noResult('exec_no_tail', now()) : buildResult('exec_tail', outcome.tail, now()))
  if (outcome.ok) return moveOpenTask(store, nodeId, 'reported', { actor: SYSTEM, rule: EXEC_EXIT_RULE, reason: outcome.reason })
  const a = store.openAssignmentOfNode(nodeId)
  const task = a ? store.getTask(a.taskId) : null
  if (!task || !canWorkTransition(task.status, 'failed')) return null
  finishTask(store, task.id, 'failed', { actor: SYSTEM, rule: EXEC_EXIT_RULE, reason: outcome.reason })
  return 'failed'
}
