// Helper bersama transisi task: loader, reload, dan penulis event. Dipisah supaya `ledgerTask.ts`
// (state machine) dan `ledgerTaskCreate.ts` (create/query) sama-sama di bawah budget file.
import type { Task, TaskActorOptions, TaskStatus } from './ledgerModel'
import { LedgerNotFoundError } from './ledgerModel'
import { type LedgerContext, getRow, toTask } from './ledgerCore'
import { appendEvent } from './ledgerEvent'

/** Statuses that may enter `leased`. `suspect` is the reaper's requeue state. */
export const LEASEABLE: readonly TaskStatus[] = ['pending', 'reopened', 'suspect']
export const REOPENABLE: readonly TaskStatus[] = ['suspect', 'failed', 'blocked', 'cancelled']
export const FAILABLE: readonly TaskStatus[] = ['leased', 'claimed_done']
export const DEFAULT_PAGE = 200
export const MAX_PAGE = 1000

export function loadTask(ctx: LedgerContext, id: string): Task | null {
  const row = getRow(ctx.db, 'SELECT * FROM task WHERE id = ?', id)
  return row ? toTask(row) : null
}

export function reload(ctx: LedgerContext, id: string): Task {
  const task = loadTask(ctx, id)
  if (!task) throw new LedgerNotFoundError('task', id)
  return task
}

/** Appends the transition event in the caller's transaction. */
export function emit(
  ctx: LedgerContext,
  task: Task,
  kind: string,
  base: Record<string, unknown>,
  opts: TaskActorOptions | undefined,
  at: number
): void {
  appendEvent(ctx, {
    projectId: task.projectId,
    taskId: task.id,
    actor: opts?.actor ?? 'system',
    kind,
    payload: opts?.payload === undefined ? base : { ...base, data: opts.payload },
    now: at,
  })
}
