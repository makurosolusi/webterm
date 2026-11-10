import type { TaskView } from '../../../shared/centralWork'
import type { WorkActor, WorkStore } from './workModel'

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
