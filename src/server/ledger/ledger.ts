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
  LedgerNotFoundError,
} from './ledgerModel'
import {
  type LedgerContext,
  allRows,
  execWrite,
  getRow,
  jsonOf,
  newId,
  toAgent,
  toProject,
  tx,
} from './ledgerCore'
import { appendEvent, listEvents } from './ledgerEvent'
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

export * from './ledgerModel'

export interface LedgerOptions {
  /** Fixed epoch-ms or a clock; defaults to Date.now. Injected for deterministic tests. */
  now?: number | (() => number)
}

export interface Ledger {
  project: {
    createProject(input: CreateProjectInput): Project
    getProject(id: string): Project | null
    listProjects(): Project[]
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
  }
  event: {
    appendEvent(input: AppendEventInput): LedgerEvent
    listEvents(input?: ListEventsInput): LedgerEvent[]
  }
  /** Deletes one project; FK cascades remove agents/tasks/runs/events/usage/budget/prefix. */
  deleteProject(id: string): boolean
  /** Runs `fn` inside one BEGIN IMMEDIATE transaction (nested calls join it). */
  tx<T>(fn: () => T): T
  now(): number
}

function toClock(now: number | (() => number) | undefined): () => number {
  if (typeof now === 'function') return now
  if (typeof now === 'number') return () => now
  return () => Date.now()
}

function projectById(ctx: LedgerContext, id: string): Project {
  const row = getRow(ctx.db, 'SELECT * FROM project WHERE id = ?', id)
  if (!row) throw new LedgerNotFoundError('project', id)
  return toProject(row)
}

function agentById(ctx: LedgerContext, id: string): Agent {
  const row = getRow(ctx.db, 'SELECT * FROM agent WHERE id = ?', id)
  if (!row) throw new LedgerNotFoundError('agent', id)
  return toAgent(row)
}

/** Typed repository over the v1 ledger schema. All SQL is parameterized. */
export function createLedger(db: Database, options: LedgerOptions = {}): Ledger {
  const ctx: LedgerContext = { db, now: toClock(options.now) }

  const project: Ledger['project'] = {
    createProject(input) {
      const at = ctx.now()
      const id = input.id ?? newId()
      const priority = input.priority ?? 0
      if (!Number.isInteger(priority)) {
        throw new LedgerError(`project.priority must be an integer, got ${priority}`)
      }
      execWrite(
        db,
        `INSERT INTO project (id, workspace_id, name, path, branch_base, priority, budget_json,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.workspaceId,
        input.name,
        input.path,
        input.branchBase ?? null,
        priority,
        jsonOf(input.budget, 'project.budget'),
        at,
        at
      )
      return projectById(ctx, id)
    },
    getProject(id) {
      const row = getRow(db, 'SELECT * FROM project WHERE id = ?', id)
      return row ? toProject(row) : null
    },
    listProjects() {
      return allRows(db, 'SELECT * FROM project ORDER BY priority DESC, created_at ASC, id ASC').map(
        toProject
      )
    },
    setLockEpoch(id, epoch) {
      if (!Number.isInteger(epoch) || epoch < 0) {
        throw new LedgerError(`project.lock_epoch must be a non-negative integer, got ${epoch}`)
      }
      const at = ctx.now()
      const changes = execWrite(
        db,
        'UPDATE project SET lock_epoch = ?, updated_at = ? WHERE id = ?',
        epoch,
        at,
        id
      )
      if (changes !== 1) throw new LedgerNotFoundError('project', id)
      return projectById(ctx, id)
    },
  }

  const agent: Ledger['agent'] = {
    createAgent(input) {
      const at = ctx.now()
      const id = input.id ?? newId()
      execWrite(
        db,
        `INSERT INTO agent (id, project_id, parent_agent_id, name, role, depth,
           capabilities_json, session_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.projectId,
        input.parentAgentId ?? null,
        input.name ?? null,
        input.role ?? 'worker',
        input.depth,
        jsonOf(input.capabilities, 'agent.capabilities'),
        input.sessionRef ?? null,
        at
      )
      return agentById(ctx, id)
    },
    getAgent(id) {
      const row = getRow(db, 'SELECT * FROM agent WHERE id = ?', id)
      return row ? toAgent(row) : null
    },
    setAgentState(id, state, heartbeatAt) {
      if (typeof state !== 'string' || state.trim() === '') {
        throw new LedgerError('agent.state must be a non-empty string')
      }
      const at = heartbeatAt ?? ctx.now()
      const changes = execWrite(
        db,
        'UPDATE agent SET state = ?, heartbeat_at = ? WHERE id = ?',
        state,
        at,
        id
      )
      if (changes !== 1) throw new LedgerNotFoundError('agent', id)
      return agentById(ctx, id)
    },
  }

  return {
    project,
    agent,
    task: {
      createTask: (input) => createTask(ctx, input),
      getTask: (id) => getTask(ctx, id),
      listTasks: (projectId, status, opts) => listTasks(ctx, projectId, status, opts),
      leaseTask: (id, input) => leaseTask(ctx, id, input),
      renewLease: (id, owner, ttlMs, now) => renewLease(ctx, id, owner, ttlMs, now),
      releaseToSuspect: (id, now) => releaseToSuspect(ctx, id, now),
      claimDone: (id, fence, evidence, opts) => claimDone(ctx, id, fence, evidence, opts),
      verifyTask: (id, fence, evidence, opts) => verifyTask(ctx, id, fence, evidence, opts),
      failTask: (id, fence, reason, opts) => failTask(ctx, id, fence, reason, opts),
      reopenTask: (id, opts) => reopenTask(ctx, id, opts),
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
        return true
      })
    },
    tx: (fn) => tx(ctx, fn),
    now: () => ctx.now(),
  }
}
