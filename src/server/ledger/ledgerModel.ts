/**
 * Shapes and typed errors for the P2 ledger repository (schema v1).
 * Nothing here touches SQLite; ledgerCore/ledgerTask/ledgerEvent do.
 */

export type Row = Record<string, unknown>

export type TaskStatus =
  | 'pending'
  | 'leased'
  | 'suspect'
  | 'claimed_done'
  | 'verified'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'reopened'

/** Mirrors the task.status CHECK in ledgerSchema.ts. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  'pending', 'leased', 'suspect', 'claimed_done', 'verified',
  'blocked', 'failed', 'cancelled', 'reopened',
]

export interface Project {
  id: string
  workspaceId: string
  name: string
  path: string
  branchBase: string | null
  status: string
  priority: number
  budget: unknown
  lockEpoch: number
  approvedBy: string | null
  createdAt: number
  updatedAt: number
}

export interface Agent {
  id: string
  projectId: string
  parentAgentId: string | null
  name: string | null
  role: string
  depth: number
  capabilities: unknown
  sessionRef: string | null
  state: string
  heartbeatAt: number | null
  createdAt: number
}

export interface Task {
  id: string
  projectId: string
  parentId: string | null
  agentId: string | null
  spec: string
  specDigest: string | null
  status: TaskStatus
  fence: number
  leaseOwner: string | null
  leaseExpires: number | null
  heartbeatAt: number | null
  attempt: number
  maxAttempts: number
  idemKey: string | null
  evidence: unknown
  createdAt: number
  updatedAt: number
}

export interface LedgerEvent {
  seq: number
  ts: number
  projectId: string | null
  taskId: string | null
  runId: string | null
  actor: string
  kind: string
  payload: unknown
  correlationId: string | null
}

export interface CreateProjectInput {
  id?: string
  workspaceId: string
  name: string
  path: string
  branchBase?: string
  priority?: number
  budget?: unknown
}

export interface CreateAgentInput {
  id?: string
  projectId: string
  parentAgentId?: string
  name?: string
  role?: string
  depth: number
  capabilities?: unknown
  sessionRef?: string
}

export interface CreateTaskInput {
  id?: string
  projectId: string
  parentId?: string
  agentId?: string
  spec: string
  specDigest?: string
  maxAttempts?: number
  idemKey?: string
  /** Overrides the clock injected at createLedger for this write. */
  now?: number
  actor?: string
}

export interface LeaseTaskInput {
  owner: string
  ttlMs: number
  now?: number
  actor?: string
  /** Extra JSON merged into the emitted `task.leased` event (tests use it to force a failure). */
  payload?: unknown
}

export interface TaskActorOptions {
  actor?: string
  payload?: unknown
}

export interface AppendEventInput {
  projectId?: string
  taskId?: string
  runId?: string
  actor: string
  kind: string
  payload?: unknown
  correlationId?: string
  now?: number
}

export interface ListEventsInput {
  projectId?: string
  taskId?: string
  afterSeq?: number
  limit?: number
}

/** Base class so callers can `catch (e) { if (e instanceof LedgerError) ... }`. */
export class LedgerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/** A writer presented a fence the row no longer has (someone re-leased it). */
export class StaleFenceError extends LedgerError {
  constructor(readonly taskId: string, readonly expected: number, readonly actual: number) {
    super(`stale fence for task ${taskId}: expected ${expected}, row has ${actual}`)
  }
}

/** The requested status change is not legal from the row's current status. */
export class IllegalTransitionError extends LedgerError {
  constructor(readonly taskId: string, readonly from: string, readonly to: string) {
    super(`illegal task transition for ${taskId}: ${from} -> ${to}`)
  }
}

/** `task.idem_key` is UNIQUE; the caller reused a key for a different task. */
export class DuplicateIdemKeyError extends LedgerError {
  constructor(readonly idemKey: string, readonly existingId: string | null) {
    super(`duplicate task idem_key ${idemKey}${existingId ? ` (existing task ${existingId})` : ''}`)
  }
}

export class LedgerNotFoundError extends LedgerError {
  constructor(readonly entity: string, readonly id: string) {
    super(`${entity} not found: ${id}`)
  }
}
