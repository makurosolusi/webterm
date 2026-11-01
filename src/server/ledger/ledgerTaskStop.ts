// Stop transitions and the reaper sweep. Dipisah dari `ledgerTask.ts` agar file state machine
// tetap di bawah budget service.
import { type Task, type TaskActorOptions, type TaskStatus, IllegalTransitionError, LedgerError } from './ledgerModel'
import { type LedgerContext, allRows, execWrite, tx } from './ledgerCore'
import { releaseToSuspect } from './ledgerTask'
import { BLOCKABLE, CANCELABLE, emit, reload } from './ledgerTaskShared'
import { ledgerMetrics } from './ledgerMetrics'

/** Terminal stop requested by a human/scheduler. A live lease is revoked. */
export function cancelTask(
  ctx: LedgerContext,
  id: string,
  reason: string,
  opts?: TaskActorOptions
): Task {
  return stopTask(ctx, id, 'cancelled', CANCELABLE, reason, opts)
}

/** Non-terminal stop: the task stays resumable via reopenTask. */
export function blockTask(
  ctx: LedgerContext,
  id: string,
  reason: string,
  opts?: TaskActorOptions
): Task {
  return stopTask(ctx, id, 'blocked', BLOCKABLE, reason, opts)
}

function stopTask(
  ctx: LedgerContext,
  id: string,
  next: 'cancelled' | 'blocked',
  allowed: readonly TaskStatus[],
  reason: string,
  opts: TaskActorOptions | undefined
): Task {
  if (typeof reason !== 'string' || reason.trim() === '') {
    const name = next === 'cancelled' ? 'cancelTask' : 'blockTask'
    throw new LedgerError(`${name}: reason must be non-empty`)
  }
  const at = ctx.now()
  return tx(ctx, () => {
    const task = reload(ctx, id)
    if (!allowed.includes(task.status)) throw new IllegalTransitionError(id, task.status, next)
    const changes = execWrite(
      ctx.db,
      `UPDATE task SET status = ?, fence = fence + 1, lease_owner = NULL, lease_expires = NULL,
         heartbeat_at = NULL, updated_at = ?
       WHERE id = ? AND status = ? AND fence = ?`,
      next,
      at,
      id,
      task.status,
      task.fence
    )
    if (changes !== 1) throw new LedgerError(`${next}Task: concurrent update for ${id}`)
    const updated = reload(ctx, id)
    emit(ctx, updated, `task.${next}`, { fence: updated.fence, from: task.status, reason }, opts, at)
    return updated
  })
}

/**
 * Reaper sweep: every expired lease becomes `suspect` (never straight to pending), oldest first.
 * Returns the ids that moved so the caller can revoke sessions / requeue with a fresh fence.
 */
export function sweepExpiredLeases(ctx: LedgerContext, limit = 100, now?: number): string[] {
  const at = now ?? ctx.now()
  const capped = Math.min(1000, Math.max(1, Math.trunc(limit)))
  const rows = allRows(
    ctx.db,
    `SELECT id FROM task WHERE status = 'leased' AND lease_expires IS NOT NULL
       AND lease_expires <= ? ORDER BY lease_expires ASC LIMIT ?`,
    at,
    capped
  )
  const moved: string[] = []
  for (const row of rows) {
    const id = String(row['id'])
    if (releaseToSuspect(ctx, id, at) !== null) {
      moved.push(id)
      ledgerMetrics.inc('lease_expired')
      ledgerMetrics.inc('suspect')
    }
  }
  return moved
}
