/**
 * Goal persistence over `project.goal_json` (schema v4). One goal per project,
 * optimistic `version`, and one ledger audit event per mutation. Transitions and
 * criteria rules live in goalModel.ts; this module only reads/writes and audits.
 */
import type { Database } from 'bun:sqlite'
import { appendEvent } from '../ledger/ledgerEvent'
import { execWrite, getRow, type LedgerContext } from '../ledger/ledgerCore'
import {
  type Goal,
  type GoalDraftInput,
  GoalError,
  assertGoalTransition,
  parseGoalStored,
  validateGoalContent,
} from './goalModel'

export const EVENT_GOAL_PROPOSED = 'goal.proposed'
export const EVENT_GOAL_ACTIVATED = 'goal.activated'
export const EVENT_GOAL_ABANDONED = 'goal.abandoned'
const MAX_REASON = 500
const MAX_ACTOR_ID = 200
const CONTROL = /[\u0000-\u001f\u007f]/

/** Audit identity for a goal mutation; authority is enforced at the HTTP layer. */
export interface GoalActor {
  id: string
  kind: string
}

export interface ProposeGoalInput {
  projectId: string
  draft: GoalDraftInput
  actor: GoalActor
  /** Current version, or null/undefined when no goal exists (create). */
  expectedVersion?: number | null
  now?: number
}

export interface ActivateGoalInput {
  projectId: string
  expectedVersion: number
  actor: GoalActor
  now?: number
}

export interface AbandonGoalInput extends ActivateGoalInput {
  reason: string
}

function ctxOf(db: Database): LedgerContext {
  return { db, now: () => Date.now() }
}

/**
 * Local BEGIN IMMEDIATE wrapper. The scoped handle reports `inTransaction` so the
 * nested appendEvent joins instead of starting a second transaction (node:sqlite
 * has no inTransaction getter, so we cannot rely on the real handle alone).
 */
function writeTx<T>(db: Database, fn: (txDb: Database) => T): T {
  if ((db as unknown as { inTransaction?: boolean }).inTransaction === true) return fn(db)
  db.exec('BEGIN IMMEDIATE')
  const scoped = {
    inTransaction: true,
    exec: (sql: string) => db.exec(sql),
    query: (sql: string) => db.query(sql),
  } as unknown as Database
  try {
    const result = fn(scoped)
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // SQLite already rolled back.
    }
    throw err
  }
}

function validateProjectId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (id === '' || id.length > 200 || CONTROL.test(id)) {
    throw new GoalError('project_not_found', 'projectId must be a non-empty id')
  }
  return id
}

function validateActor(actor: GoalActor): GoalActor {
  if (typeof actor !== 'object' || actor === null) throw new GoalError('forbidden', 'actor is required')
  const id = typeof actor.id === 'string' ? actor.id.trim() : ''
  if (id === '' || id.length > MAX_ACTOR_ID || CONTROL.test(id)) {
    throw new GoalError('forbidden', 'actor.id must be a non-empty id')
  }
  if (typeof actor.kind !== 'string' || actor.kind === '') {
    throw new GoalError('forbidden', 'actor.kind is required')
  }
  return { id, kind: actor.kind }
}

function validateVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new GoalError('invalid_version', 'expectedVersion must be a positive integer')
  }
  return value
}

function requireProject(db: Database, projectId: string): void {
  if (getRow(db, 'SELECT 1 AS one FROM project WHERE id = ?', projectId) === null) {
    throw new GoalError('project_not_found', `project not found: ${projectId}`)
  }
}

/** Reads the current goal or null when the project has none. */
export function getGoal(db: Database, rawProjectId: string): Goal | null {
  const projectId = validateProjectId(rawProjectId)
  const row = getRow(db, 'SELECT goal_json FROM project WHERE id = ?', projectId)
  if (!row) throw new GoalError('project_not_found', `project not found: ${projectId}`)
  const raw = row['goal_json']
  return raw === null || raw === undefined ? null : parseGoalStored(String(raw))
}

function saveGoal(db: Database, projectId: string, goal: Goal, ts: number): void {
  const changed = execWrite(
    db,
    'UPDATE project SET goal_json = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(goal),
    ts,
    projectId
  )
  if (changed !== 1) throw new GoalError('project_not_found', `project not found: ${projectId}`)
}

function stale(expected: unknown, current: Goal | null): never {
  throw new GoalError(
    'stale_version',
    `expectedVersion ${String(expected)} does not match current ${current?.version ?? 'none'}`
  )
}

/**
 * Writes a `proposed` goal. Central/system only; an existing active goal blocks a
 * new proposal (WIP goal = 1). The proposal has zero effect on plan/task rows.
 */
export function proposeGoal(db: Database, input: ProposeGoalInput): Goal {
  const projectId = validateProjectId(input.projectId)
  const actor = validateActor(input.actor)
  if (actor.kind !== 'central' && actor.kind !== 'system') {
    throw new GoalError('forbidden', 'only central may propose a goal')
  }
  const content = validateGoalContent(input.draft)
  const ts = input.now ?? Date.now()
  return writeTx(db, (txDb) => {
    requireProject(txDb, projectId)
    const current = getGoal(txDb, projectId)
    if (current?.status === 'active') {
      throw new GoalError('goal_active', 'an active goal already exists for this project')
    }
    if ((current?.version ?? null) !== (input.expectedVersion ?? null)) {
      stale(input.expectedVersion, current)
    }
    const goal: Goal = { version: (current?.version ?? 0) + 1, status: 'proposed', ...content }
    saveGoal(txDb, projectId, goal, ts)
    appendEvent(ctxOf(txDb), {
      actor: actor.id,
      kind: EVENT_GOAL_PROPOSED,
      projectId,
      now: ts,
      payload: {
        fromVersion: current?.version ?? null,
        toVersion: goal.version,
        status: goal.status,
        actorKind: actor.kind,
        criteria: goal.successCriteria.length,
      },
    })
    return goal
  })
}

function transition(
  db: Database,
  input: ActivateGoalInput,
  next: Goal['status'],
  kind: string,
  reason: string | null
): Goal {
  const projectId = validateProjectId(input.projectId)
  const actor = validateActor(input.actor)
  const expected = validateVersion(input.expectedVersion)
  const ts = input.now ?? Date.now()
  return writeTx(db, (txDb) => {
    const current = getGoal(txDb, projectId)
    if (!current) throw new GoalError('stale_version', 'no goal exists for this project')
    if (current.version !== expected) stale(expected, current)
    assertGoalTransition(current.status, next, actor.kind)
    const goal: Goal = { ...current, status: next, version: current.version + 1 }
    saveGoal(txDb, projectId, goal, ts)
    appendEvent(ctxOf(txDb), {
      actor: actor.id,
      kind,
      projectId,
      now: ts,
      payload: {
        fromVersion: current.version,
        toVersion: goal.version,
        from: current.status,
        to: next,
        actorKind: actor.kind,
        reason,
      },
    })
    return goal
  })
}

/** `proposed -> active`; the HTTP layer requires a human principal. */
export function activateGoal(db: Database, input: ActivateGoalInput): Goal {
  return transition(db, input, 'active', EVENT_GOAL_ACTIVATED, null)
}

/** `active -> abandoned`; a non-empty reason is required for the audit trail. */
export function abandonGoal(db: Database, input: AbandonGoalInput): Goal {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason === '' || reason.length > MAX_REASON || CONTROL.test(reason)) {
    throw new GoalError('invalid_goal', `abandon reason must be 1..${MAX_REASON} characters`)
  }
  return transition(db, input, 'abandoned', EVENT_GOAL_ABANDONED, reason)
}
