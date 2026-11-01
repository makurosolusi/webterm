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
import { DEFAULT_PAGE, MAX_PAGE, emit, loadTask, reload } from './ledgerTaskShared'

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
        input.idemKey ?? null,
        at,
        at
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (input.idemKey !== undefined && message.includes('task.idem_key')) {
        const existing = getRow(ctx.db, 'SELECT id FROM task WHERE idem_key = ?', input.idemKey)
        throw new DuplicateIdemKeyError(input.idemKey, existing ? String(existing['id']) : null)
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

/** Oldest-first page; status must be one of the schema's CHECK values. */
export function listTasks(
  ctx: LedgerContext,
  projectId: string,
  status?: TaskStatus,
  opts: { limit?: number; offset?: number } = {}
): Task[] {
  if (status !== undefined && !TASK_STATUSES.includes(status)) {
    throw new LedgerError(`listTasks: unknown status ${String(status)}`)
  }
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.trunc(opts.limit ?? DEFAULT_PAGE)))
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0))
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
