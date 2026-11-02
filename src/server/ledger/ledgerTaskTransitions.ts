// Claim/verify/fail/reopen transitions for the task ledger, plus their fence/lease guards.
// Split out of `ledgerTask.ts` to keep each module under the file-health budget.
import {
  type Task,
  type TaskActorOptions,
  IllegalTransitionError,
  LedgerError,
  StaleFenceError,
  StaleLeaseError,
} from './ledgerModel'
import { type LedgerContext, execWrite, jsonOf, tx } from './ledgerCore'
import { FAILABLE, REOPENABLE, emit, reload } from './ledgerTaskShared'
import { ledgerMetrics } from './ledgerMetrics'

function assertFence(task: Task, fence: number): void {
  if (task.fence !== fence) {
    ledgerMetrics.inc('stale_fence')
    throw new StaleFenceError(task.id, fence, task.fence)
  }
}

/**
 * Extra `WHERE` terms asserting a live lease (and ownership when `owner` is supplied).
 * `params` holds the bind values in SQL order; `at` is prepended by the caller.
 */
function leaseWhere(owner: string | undefined): { sql: string; params: string[] } {
  return {
    sql: ' AND lease_expires IS NOT NULL AND lease_expires > ?' + (owner === undefined ? '' : ' AND lease_owner = ?'),
    params: owner === undefined ? [] : [owner],
  }
}

/**
 * Pre-flight assertion mirroring {@link leaseWhere}: a `leased` row must still be alive,
 * and must be owned by `owner` when the caller names one.
 */
function assertLiveLease(task: Task, owner: string | undefined, at: number): void {
  if (task.leaseExpires === null || task.leaseExpires <= at) {
    throw new StaleLeaseError(task.id, `lease expired at ${task.leaseExpires ?? 'never'}`)
  }
  if (owner !== undefined && task.leaseOwner !== owner) {
    throw new StaleLeaseError(task.id, `held by ${task.leaseOwner ?? 'nobody'}, not ${owner}`)
  }
}

/**
 * Marks a leased task done. The lease must still be live and, when `opts.owner` is set,
 * held by that owner; an expired zombie or a foreign actor is rejected with
 * `StaleLeaseError`. Omitting `owner` keeps the older call shape but still requires a
 * live lease.
 */
export function claimDone(
  ctx: LedgerContext,
  id: string,
  fence: number,
  evidence: unknown,
  opts?: TaskActorOptions
): Task {
  const at = ctx.now()
  const evidenceJson = jsonOf(evidence, 'claimDone.evidence')
  const owner = opts?.owner
  const lease = leaseWhere(owner)
  return tx(ctx, () => {
    const task = reload(ctx, id)
    assertFence(task, fence)
    if (task.status !== 'leased') throw new IllegalTransitionError(id, task.status, 'claimed_done')
    assertLiveLease(task, owner, at)
    const changes = execWrite(
      ctx.db,
      `UPDATE task SET status = 'claimed_done', evidence_json = ?, lease_owner = NULL,
         lease_expires = NULL, heartbeat_at = ?, updated_at = ?
       WHERE id = ? AND fence = ? AND status = 'leased'${lease.sql}`,
      evidenceJson,
      at,
      at,
      id,
      fence,
      at,
      ...lease.params
    )
    if (changes !== 1) throw new StaleLeaseError(id, 'lease lost before claimDone was written')
    const next = reload(ctx, id)
    emit(ctx, next, 'task.claimed_done', { fence }, opts, at)
    return next
  })
}

/**
 * Verifies a `claimed_done` task. `claimDone` already released the lease, so the fence is
 * the caller assertion here; `opts.owner` is accepted for API symmetry but not checked.
 * Evidence is written with `COALESCE`, so an explicit `null`/`undefined` keeps the claim
 * evidence and only a non-null value replaces it (see ledgerTask.bun.test.ts).
 */
export function verifyTask(
  ctx: LedgerContext,
  id: string,
  fence: number,
  evidence: unknown,
  opts?: TaskActorOptions
): Task {
  const at = ctx.now()
  const evidenceJson = jsonOf(evidence, 'verifyTask.evidence')
  return tx(ctx, () => {
    const task = reload(ctx, id)
    assertFence(task, fence)
    if (task.status !== 'claimed_done') throw new IllegalTransitionError(id, task.status, 'verified')
    const changes = execWrite(
      ctx.db,
      `UPDATE task SET status = 'verified', evidence_json = COALESCE(?, evidence_json), updated_at = ?
       WHERE id = ? AND fence = ? AND status = 'claimed_done'`,
      evidenceJson,
      at,
      id,
      fence
    )
    if (changes !== 1) throw new StaleFenceError(id, fence, reload(ctx, id).fence)
    const next = reload(ctx, id)
    emit(ctx, next, 'task.verified', { fence }, opts, at)
    return next
  })
}

/** Terminal failure from `leased`/`claimed_done`; `reason` lands in the event payload. */
export function failTask(
  ctx: LedgerContext,
  id: string,
  fence: number,
  reason: string,
  opts?: TaskActorOptions
): Task {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new LedgerError('failTask: reason must be a non-empty string')
  }
  const at = ctx.now()
  const fallbackEvidence = jsonOf({ reason }, 'failTask.reason')
  const owner = opts?.owner
  const lease = leaseWhere(owner)
  return tx(ctx, () => {
    const task = reload(ctx, id)
    assertFence(task, fence)
    if (!FAILABLE.includes(task.status)) throw new IllegalTransitionError(id, task.status, 'failed')
    // `claimed_done` rows already released their lease; only a leased row can be a zombie.
    if (task.status === 'leased') assertLiveLease(task, owner, at)
    const leaseSql = task.status === 'leased' ? lease.sql : ''
    const leaseParams = task.status === 'leased' ? [at, ...lease.params] : []
    const changes = execWrite(
      ctx.db,
      `UPDATE task SET status = 'failed', lease_owner = NULL, lease_expires = NULL,
         evidence_json = COALESCE(evidence_json, ?), updated_at = ?
       WHERE id = ? AND fence = ? AND status IN ('leased', 'claimed_done')${leaseSql}`,
      fallbackEvidence,
      at,
      id,
      fence,
      ...leaseParams
    )
    if (changes !== 1) throw new StaleLeaseError(id, 'lease lost before failTask was written')
    const next = reload(ctx, id)
    emit(ctx, next, 'task.failed', { fence, reason }, opts, at)
    return next
  })
}

/** Returns a non-terminal task to the queue with a fresh fence. */
export function reopenTask(ctx: LedgerContext, id: string, opts?: TaskActorOptions): Task {
  const at = ctx.now()
  return tx(ctx, () => {
    const task = reload(ctx, id)
    if (!REOPENABLE.includes(task.status)) {
      throw new IllegalTransitionError(id, task.status, 'reopened')
    }
    const changes = execWrite(
      ctx.db,
      `UPDATE task SET status = 'reopened', fence = fence + 1, lease_owner = NULL,
         lease_expires = NULL, heartbeat_at = NULL, updated_at = ?
       WHERE id = ? AND status = ?`,
      at,
      id,
      task.status
    )
    if (changes !== 1) throw new LedgerError(`reopenTask: concurrent update for ${id}`)
    const next = reload(ctx, id)
    emit(ctx, next, 'task.reopened', { fence: next.fence, from: task.status }, opts, at)
    return next
  })
}
