import type { Database } from 'bun:sqlite'
import {
  type Agent,
  type AppendEventInput,
  type CreateAgentInput,
  type CreateProjectInput,
  type CreateTaskInput,
  type LeaseTaskInput,
  type LedgerEvent,
  type ListEventsInput,
  type Project,
  type Task,
  type TaskActorOptions,
  type TaskStatus,
  LedgerError,
} from './ledgerModel'
import {
  type LedgerContext,
  allRows,
  execWrite,
  getRow,
  tx,
} from './ledgerCore'
import { appendEvent, listEvents } from './ledgerEvent'
import { agentRepository, projectRepository } from './ledgerEntity'
import {
  PROJECT_CASCADE_TABLES,
  assertConnectionPragmas,
  assertTaskParents,
  pragmaInt,
} from './ledgerInvariants'
import { migrate } from './migration'
import {
  claimDone,
  failTask,
  leaseTask,
  releaseToSuspect,
  reopenTask,
  renewLease,
  verifyTask,
} from './ledgerTask'
import { createTask, getTask, listTasks } from './ledgerTaskCreate'
import { blockTask, cancelTask, sweepExpiredLeases } from './ledgerTaskStop'

export * from './ledgerModel'

export interface LedgerOptions {
  /** Fixed epoch-ms or a clock; defaults to Date.now. Injected for deterministic tests. */
  now?: number | (() => number)
}

export interface Ledger {
  project: {
    createProject(input: CreateProjectInput): Project
    getProject(id: string): Project | null
    listProjects(opts?: { limit?: number; offset?: number }): Project[]
    setLockEpoch(id: string, epoch: number): Project
  }
  agent: {
    createAgent(input: CreateAgentInput): Agent
    getAgent(id: string): Agent | null
    setAgentState(id: string, state: string, heartbeatAt?: number): Agent
  }
  task: {
    createTask(input: CreateTaskInput): Task
    getTask(id: string): Task | null
    listTasks(projectId: string, status?: TaskStatus, opts?: { limit?: number; offset?: number }): Task[]
    leaseTask(id: string, input: LeaseTaskInput): Task | null
    renewLease(id: string, owner: string, ttlMs: number, now?: number): Task | null
    releaseToSuspect(id: string, now?: number): Task | null
    claimDone(id: string, fence: number, evidence: unknown, opts?: TaskActorOptions): Task
    verifyTask(id: string, fence: number, evidence: unknown, opts?: TaskActorOptions): Task
    failTask(id: string, fence: number, reason: string, opts?: TaskActorOptions): Task
    reopenTask(id: string, opts?: TaskActorOptions): Task
    cancelTask(id: string, reason: string, opts?: TaskActorOptions): Task
    blockTask(id: string, reason: string, opts?: TaskActorOptions): Task
    /** Reaper: expired leases -> suspect. Returns moved task ids. */
    sweepExpiredLeases(limit?: number, now?: number): string[]
  }
  event: {
    appendEvent(input: AppendEventInput): LedgerEvent
    listEvents(input?: ListEventsInput): LedgerEvent[]
  }
  /** Deletes one project; FK cascades remove agents/tasks/runs/events/usage/budget/prefix. */
  deleteProject(id: string): boolean
  /** Deletes every project owned by a workspace; returns how many projects were removed. */
  deleteProjectsForWorkspace(workspaceId: string): number
  /** Runs `fn` inside one BEGIN IMMEDIATE transaction (nested calls join it). */
  tx<T>(fn: () => T): T
  now(): number
}

function toClock(now: number | (() => number) | undefined): () => number {
  if (typeof now === 'function') return now
  if (typeof now === 'number') return () => now
  return () => Date.now()
}

/** Typed repository over the v1 ledger schema. All SQL is parameterized. */
export function createLedger(db: Database, options: LedgerOptions = {}): Ledger {
  assertConnectionPragmas(db)
  migrate(db)
  const ctx: LedgerContext = { db, now: toClock(options.now) }

  const project = projectRepository(ctx)
  const agent = agentRepository(ctx)

  return {
    project,
    agent,
    task: {
      createTask: (input) =>
        tx(ctx, () => {
          assertTaskParents(ctx, input)
          return createTask(ctx, input)
        }),
      getTask: (id) => getTask(ctx, id),
      listTasks: (projectId, status, opts) => listTasks(ctx, projectId, status, opts),
      leaseTask: (id, input) => leaseTask(ctx, id, input),
      renewLease: (id, owner, ttlMs, now) => renewLease(ctx, id, owner, ttlMs, now),
      releaseToSuspect: (id, now) => releaseToSuspect(ctx, id, now),
      claimDone: (id, fence, evidence, opts) => claimDone(ctx, id, fence, evidence, opts),
      verifyTask: (id, fence, evidence, opts) => verifyTask(ctx, id, fence, evidence, opts),
      failTask: (id, fence, reason, opts) => failTask(ctx, id, fence, reason, opts),
      reopenTask: (id, opts) => reopenTask(ctx, id, opts),
      cancelTask: (id, reason, opts) => cancelTask(ctx, id, reason, opts),
      blockTask: (id, reason, opts) => blockTask(ctx, id, reason, opts),
      sweepExpiredLeases: (limit, now) => sweepExpiredLeases(ctx, limit, now),
    },
    event: {
      appendEvent: (input) => appendEvent(ctx, input),
      listEvents: (input) => listEvents(ctx, input ?? {}),
    },
    deleteProject(id) {
      return tx(ctx, () => {
        // sqlite3_changes() is unreliable here: cascading SET NULL on memory fires
        // the memory_au trigger, so check existence explicitly instead.
        if (getRow(db, 'SELECT 1 AS one FROM project WHERE id = ?', id) === null) return false
        execWrite(db, 'DELETE FROM project WHERE id = ?', id)
        for (const table of PROJECT_CASCADE_TABLES) {
          const left = getRow(db, `SELECT 1 AS one FROM ${table} WHERE project_id = ?`, id)
          if (left !== null) {
            throw new LedgerError(
              `deleteProject ${id}: ${table} rows survived the cascade ` +
                `(foreign_keys=${pragmaInt(db, 'foreign_keys')})`
            )
          }
        }
        return true
      })
    },
    deleteProjectsForWorkspace(workspaceId) {
      return tx(ctx, () => {
        // Ledger sengaja tidak punya FK ke tabel `workspace` (bisa dibuka standalone), jadi
        // cascade tingkat-workspace harus eksplisit di sini, bukan mengandalkan db.delete.
        const ids = allRows(
          db,
          'SELECT id FROM project WHERE workspace_id = ? ORDER BY id ASC',
          workspaceId
        ).map((row) => String(row['id']))
        let removed = 0
        for (const id of ids) if (this.deleteProject(id)) removed += 1
        return removed
      })
    },
    tx: (fn) => tx(ctx, fn),
    now: () => ctx.now(),
  }
}
