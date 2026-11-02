import type { Database } from 'bun:sqlite'
import {
  type CreateTaskInput,
  LedgerError,
  LedgerNotFoundError,
} from './ledgerModel'
import { type LedgerContext, getRow } from './ledgerCore'

/** Reads the first column of a PRAGMA row (column names differ per pragma). */
export function pragmaInt(db: Database, name: string): number {
  const row = getRow(db, `PRAGMA ${name}`)
  return row === null ? NaN : Number(Object.values(row)[0])
}

/**
 * The repository is unusable without FK enforcement: `deleteProject` and every
 * `ON DELETE` clause silently no-op otherwise. Bun opens connections with
 * `foreign_keys = 0`, so repair and verify before accepting the connection.
 */
export function assertConnectionPragmas(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON')
  const fk = pragmaInt(db, 'foreign_keys')
  if (fk !== 1) {
    throw new LedgerError(
      `createLedger: PRAGMA foreign_keys reads back ${fk}, expected 1 ` +
        '(it cannot be enabled inside a transaction; open the connection first)'
    )
  }
  db.exec('PRAGMA busy_timeout = 5000')
  const busy = pragmaInt(db, 'busy_timeout')
  if (busy !== 5000) {
    throw new LedgerError(`createLedger: PRAGMA busy_timeout reads back ${busy}, expected 5000`)
  }
}

/** Tables whose rows must disappear with a project (all declare ON DELETE CASCADE). */
export const PROJECT_CASCADE_TABLES = [
  'agent',
  'task',
  'run',
  'event',
  'budget',
  'prefix',
  'decision',
  'approval',
] as const

/** Parents must live in the same project as the task they are attached to. */
export function assertTaskParents(ctx: LedgerContext, input: CreateTaskInput): void {
  if (input.parentId !== undefined) {
    const parent = getRow(ctx.db, 'SELECT project_id FROM task WHERE id = ?', input.parentId)
    if (!parent) throw new LedgerNotFoundError('task', input.parentId)
    const parentProject = String(parent['project_id'])
    if (parentProject !== input.projectId) {
      throw new LedgerError(
        `task.parentId ${input.parentId} belongs to project ${parentProject}, not ${input.projectId}`
      )
    }
  }
  if (input.agentId !== undefined) {
    const agent = getRow(ctx.db, 'SELECT project_id FROM agent WHERE id = ?', input.agentId)
    if (!agent) throw new LedgerNotFoundError('agent', input.agentId)
    const agentProject = String(agent['project_id'])
    if (agentProject !== input.projectId) {
      throw new LedgerError(
        `task.agentId ${input.agentId} belongs to project ${agentProject}, not ${input.projectId}`
      )
    }
  }
}
