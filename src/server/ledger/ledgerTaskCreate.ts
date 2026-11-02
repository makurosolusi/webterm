// Pembuatan dan pembacaan task. Dipisah dari state machine (`ledgerTask.ts`) agar dua file itu
// tetap di bawah budget service 300 baris.
import {
  type CreateTaskInput,
  type Task,
  type TaskStatus,
  DuplicateIdemKeyError,
  LedgerError,
  TASK_STATUSES,
} from './ledgerModel'
import { type LedgerContext, allRows, execWrite, getRow, newId, toTask, tx } from './ledgerCore'
import {
  clampPageLimit,
  clampPageOffset,
  emit,
  loadTask,
  reload,
} from './ledgerTaskShared'

export function createTask(ctx: LedgerContext, input: CreateTaskInput): Task {
  if (typeof input.spec !== 'string' || input.spec.trim() === '') {
    throw new LedgerError('task.spec must be a non-empty string')
  }
  const at = input.now ?? ctx.now()
  const id = input.id ?? newId()
  const maxAttempts = input.maxAttempts ?? 3
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new LedgerError(`task.maxAttempts must be a positive integer, got ${maxAttempts}`)
  }
  // '' and blank keys are "no idempotency key", not a shared global key.
  const idemKey =
    typeof input.idemKey === 'string' && input.idemKey.trim() !== '' ? input.idemKey : null
  return tx(ctx, () => {
    try {
      execWrite(
        ctx.db,
        `INSERT INTO task (id, project_id, parent_id, agent_id, spec, spec_digest, status, fence,
           attempt, max_attempts, idem_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?, ?)`,
        id,
        input.projectId,
        input.parentId ?? null,
        input.agentId ?? null,
        input.spec,
        input.specDigest ?? null,
        maxAttempts,
        idemKey,
        at,
        at
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (idemKey !== null && message.includes('task.idem_key')) {
        // The composite unique index is (project_id, idem_key); fall back to a global
        // lookup so an older single-column index still reports the winning task id.
        const existing =
          getTaskByIdemKey(ctx, input.projectId, idemKey) ??
          getTaskByIdemKey(ctx, undefined, idemKey)
        throw new DuplicateIdemKeyError(idemKey, existing?.id ?? null)
      }
      throw err
    }
    const task = reload(ctx, id)
    emit(
      ctx,
      task,
      'task.created',
      { projectId: task.projectId, spec_digest: task.specDigest },
      { actor: input.actor },
      at
    )
    return task
  })
}

export function getTask(ctx: LedgerContext, id: string): Task | null {
  return loadTask(ctx, id)
}

/**
 * Idempotency lookup scoped to one project (the uniqueness domain is
 * `UNIQUE(project_id, idem_key)`). Passing `undefined` searches across projects and is
 * only used to enrich duplicate-key errors.
 */
export function getTaskByIdemKey(
  ctx: LedgerContext,
  projectId: string | undefined,
  idemKey: string
): Task | null {
  if (typeof idemKey !== 'string' || idemKey.trim() === '') return null
  const row =
    projectId === undefined
      ? getRow(ctx.db, 'SELECT * FROM task WHERE idem_key = ? LIMIT 1', idemKey)
      : getRow(
          ctx.db,
          'SELECT * FROM task WHERE project_id = ? AND idem_key = ? LIMIT 1',
          projectId,
          idemKey
        )
  return row ? toTask(row) : null
}

/**
 * Oldest-first page; status must be one of the schema's CHECK values.
 * `limit`/`offset` are validated before binding so bad input is a typed `LedgerError`
 * rather than SQLite's "datatype mismatch".
 */
export function listTasks(
  ctx: LedgerContext,
  projectId: string,
  status?: TaskStatus,
  opts: { limit?: number; offset?: number } = {}
): Task[] {
  if (status !== undefined && !TASK_STATUSES.includes(status)) {
    throw new LedgerError(`listTasks: unknown status ${String(status)}`)
  }
  const limit = clampPageLimit(opts.limit, 'listTasks')
  const offset = clampPageOffset(opts.offset, 'listTasks')
  const where = status === undefined ? 'project_id = ?' : 'project_id = ? AND status = ?'
  const params: unknown[] = status === undefined ? [projectId] : [projectId, status]
  return allRows(
    ctx.db,
    `SELECT * FROM task WHERE ${where} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset
  ).map(toTask)
}
