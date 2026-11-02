// Central thin layer over the ledger (RND/03-RENCANA.md §7): the human envelope around
// projects. Mutations only touch project.status/priority and the audit event log; central
// never spawns workers and never writes fact/CORE. Portfolio reads live in
// centralProjection.ts.
import type { Database } from 'bun:sqlite'
import { writeTx } from './writeTx'
import { appendEvent } from '../ledger/ledgerEvent'
import { execWrite, getRow, type LedgerContext } from '../ledger/ledgerCore'
import {
  type CentralActor,
  CentralError,
  EVENT_PAUSED,
  EVENT_PRIORITY,
  EVENT_RESUMED,
  PROJECT_ACTIVE,
  PROJECT_PAUSED,
  assertHumanAuthority,
  clampPriority,
  validateProjectId,
} from './centralModel'

export * from './centralModel'
export { portfolio, projectPortfolio } from './centralProjection'

function ctxOf(db: Database): LedgerContext {
  return { db, now: () => Date.now() }
}

function num(value: unknown): number {
  return Number(value ?? 0)
}

interface ProjectRow {
  id: string
  name: string
  status: string
  priority: number
  updated_at: number
}

export type ProjectMutation = {
  project: { id: string; name: string; status: string; priority: number }
  changed: boolean
}

function requireProject(ctx: LedgerContext, projectId: string): ProjectRow {
  const row = getRow(
    ctx.db,
    'SELECT id, name, status, priority, updated_at FROM project WHERE id = ?',
    projectId
  ) as ProjectRow | null
  if (!row) throw new CentralError('project_not_found', `project not found: ${projectId}`)
  return row
}

function brief(row: ProjectRow) {
  return {
    id: String(row.id),
    name: String(row.name),
    status: String(row.status),
    priority: num(row.priority),
  }
}

function setStatus(
  db: Database,
  actor: CentralActor,
  projectId: string,
  next: string,
  eventKind: string
): ProjectMutation {
  const principal = assertHumanAuthority(actor)
  const id = validateProjectId(projectId)
  return writeTx(db, (txDb) => {
    const ctx = ctxOf(txDb)
    const row = requireProject(ctx, id)
    if (row.status === next) return { project: brief(row), changed: false }
    execWrite(
      txDb,
      'UPDATE project SET status = ?, updated_at = ? WHERE id = ?',
      next,
      ctx.now(),
      id
    )
    appendEvent(ctx, {
      actor: principal.id,
      kind: eventKind,
      projectId: id,
      payload: { from: row.status, to: next, actorKind: principal.kind },
    })
    return { project: { ...brief(row), status: next }, changed: true }
  })
}

/** Pause a project. Human/root only; agent and worker authority is rejected. */
export function pauseProject(db: Database, actor: CentralActor, projectId: string): ProjectMutation {
  return setStatus(db, actor, projectId, PROJECT_PAUSED, EVENT_PAUSED)
}

/** Resume a paused project by setting status back to `active`. Human/root only. */
export function resumeProject(db: Database, actor: CentralActor, projectId: string): ProjectMutation {
  return setStatus(db, actor, projectId, PROJECT_ACTIVE, EVENT_RESUMED)
}

/**
 * Set the human priority envelope for a project. The value is clamped, never used
 * for spend arithmetic, and every change appends one audit event.
 */
export function prioritize(
  db: Database,
  actor: CentralActor,
  projectId: string,
  priority: number
): ProjectMutation {
  const principal = assertHumanAuthority(actor)
  const id = validateProjectId(projectId)
  const value = clampPriority(priority)
  return writeTx(db, (txDb) => {
    const ctx = ctxOf(txDb)
    const row = requireProject(ctx, id)
    if (num(row.priority) === value) return { project: brief(row), changed: false }
    execWrite(txDb, 'UPDATE project SET priority = ?, updated_at = ? WHERE id = ?', value, ctx.now(), id)
    appendEvent(ctx, {
      actor: principal.id,
      kind: EVENT_PRIORITY,
      projectId: id,
      payload: { from: num(row.priority), to: value, actorKind: principal.kind },
    })
    return { project: { ...brief(row), priority: value }, changed: true }
  })
}
