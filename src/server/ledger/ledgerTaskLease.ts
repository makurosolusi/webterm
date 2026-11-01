// Lease lifecycle transitions for the task ledger: grant, renew, and reaper release.
// Split out of `ledgerTask.ts` to keep each module under the file-health budget.
import { type LeaseTaskInput, type Task, LedgerError, StaleFenceError } from './ledgerModel'
import { type LedgerContext, execWrite, tx } from './ledgerCore'
import { LEASEABLE, emit, loadTask, reload } from './ledgerTaskShared'

/**
 * Grants a lease when the task is queueable (pending/reopened/suspect) and has
 * no live lease; bumps `fence` so every older writer becomes stale.
 *
 * Returns `null` (no error) when `attempt >= maxAttempts`: the caller decides whether to
 * fail the row. The reaper/scheduler owns the `suspect -> failed` transition, so the
 * ledger never silently retries a permanently broken task.
 */
export function leaseTask(ctx: LedgerContext, id: string, input: LeaseTaskInput): Task | null {
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    throw new LedgerError(`leaseTask: ttlMs must be positive, got ${input.ttlMs}`)
  }
  if (typeof input.owner !== 'string' || input.owner.trim() === '') {
    throw new LedgerError('leaseTask: owner must be a non-empty string')
  }
  const at = input.now ?? ctx.now()
  return tx(ctx, () => {
    const task = loadTask(ctx, id)
    if (!task) return null
    if (!LEASEABLE.includes(task.status)) return null
    if (task.attempt >= task.maxAttempts) return null
    if (task.leaseExpires !== null && task.leaseExpires > at) return null
    const fence = task.fence + 1
    const expires = at + input.ttlMs
    const changes = execWrite(
      ctx.db,
      `UPDATE task SET status = 'leased', fence = ?, lease_owner = ?, lease_expires = ?,
         heartbeat_at = ?, attempt = attempt + 1, updated_at = ?
       WHERE id = ? AND fence = ? AND lease_expires IS ?`,
      fence,
      input.owner,
      expires,
      at,
      at,
      id,
      task.fence,
      task.leaseExpires === null ? null : task.leaseExpires
    )
    // Re-read the row so the reported `actual` fence is the real one, not a guess.
    if (changes !== 1) throw new StaleFenceError(id, task.fence, reload(ctx, id).fence)
    const next = reload(ctx, id)
    emit(ctx, next, 'task.leased', { owner: input.owner, fence, lease_expires: expires }, input, at)
    return next
  })
}

/**
 * Extends a live lease. Returns null when the owner/lease no longer holds it.
 * A caller-supplied `now` earlier than the current lease heartbeat (a clock that moves
 * backwards) is rejected instead of writing a lease that is already expired.
 */
export function renewLease(
  ctx: LedgerContext,
  id: string,
  owner: string,
  ttlMs: number,
  now?: number
): Task | null {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new LedgerError(`renewLease: ttlMs must be positive, got ${ttlMs}`)
  }
  const at = now ?? ctx.now()
  return tx(ctx, () => {
    const task = loadTask(ctx, id)
    if (!task || task.status !== 'leased' || task.leaseOwner !== owner) return null
    const leaseStart = task.heartbeatAt ?? at
    if (at < leaseStart) {
      throw new LedgerError(
        `renewLease: now (${at}) is before the lease start (${leaseStart}) for task ${id}`
      )
    }
    const expires = at + ttlMs
    const changes = execWrite(
      ctx.db,
      `UPDATE task SET lease_expires = ?, heartbeat_at = ?, updated_at = ?
       WHERE id = ? AND status = 'leased' AND lease_owner = ? AND fence = ?
         AND lease_expires IS NOT NULL AND lease_expires > ?`,
      expires,
      at,
      at,
      id,
      owner,
      task.fence,
      at
    )
    if (changes !== 1) return null
    const next = reload(ctx, id)
    emit(ctx, next, 'task.renewed', { owner, lease_expires: expires, fence: next.fence }, undefined, at)
    return next
  })
}

/** Reaper step: expired `leased` -> `suspect` (never straight back to pending). */
export function releaseToSuspect(ctx: LedgerContext, id: string, now?: number): Task | null {
  const at = now ?? ctx.now()
  return tx(ctx, () => {
    const task = loadTask(ctx, id)
    if (!task || task.status !== 'leased') return null
    if (task.leaseExpires === null || task.leaseExpires > at) return null
    const changes = execWrite(
      ctx.db,
      `UPDATE task SET status = 'suspect', lease_owner = NULL, lease_expires = NULL, updated_at = ?
       WHERE id = ? AND status = 'leased' AND fence = ?
         AND lease_expires IS NOT NULL AND lease_expires <= ?`,
      at,
      id,
      task.fence,
      at
    )
    if (changes !== 1) return null
    const next = reload(ctx, id)
    emit(ctx, next, 'task.suspect', { fence: next.fence, expired_at: task.leaseExpires }, undefined, at)
    return next
  })
}
