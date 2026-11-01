// Types, limits, and pure validation for the P4 central thin layer
// (RND/03-RENCANA.md §7). No SQLite and no I/O here, so role authority and
// priority clamping can be tested without a database.
import { type TaskStatus } from '../ledger/ledgerModel'

/** Who performs a central mutation. Only humans and the root principal may. */
export type ActorKind =
  | 'human'
  | 'root'
  | 'central'
  | 'orchestrator'
  | 'agent'
  | 'worker'
  | 'system'

export interface CentralActor {
  /** Audit identity written to the event row; never a secret or token. */
  id: string
  kind: ActorKind
}

export type CentralErrorCode =
  | 'invalid_actor'
  | 'invalid_project_id'
  | 'invalid_priority'
  | 'invalid_limit'
  | 'invalid_offset'
  | 'forbidden'
  | 'project_not_found'

export class CentralError extends Error {
  constructor(
    readonly code: CentralErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CentralError'
  }
}

/** Mutations the central surface exposes; the HTTP guard is called per action. */
export type CentralAction = 'pause' | 'resume' | 'priority'

export const MAX_PROJECT_ID = 200

/**
 * Priority is a human envelope knob, not an arithmetic input: it never changes
 * spend. Bounds keep a single project from burying every other row in the
 * portfolio ordering.
 */
export const MIN_PRIORITY = -100
export const MAX_PRIORITY = 100

export const PROJECT_PAUSED = 'paused'
export const PROJECT_ACTIVE = 'active'

export const EVENT_PAUSED = 'project.paused'
export const EVENT_RESUMED = 'project.resumed'
export const EVENT_PRIORITY = 'project.priority'

export const DEFAULT_PORTFOLIO_LIMIT = 50
export const MAX_PORTFOLIO_LIMIT = 200
export const MAX_PORTFOLIO_OFFSET = 1_000_000

/** `WEBTERM_CENTRAL=on` enables the surface; every other value (and unset) is off. */
export function centralEnabled(raw: string | undefined = process.env.WEBTERM_CENTRAL): boolean {
  return (raw ?? '').trim().toLowerCase() === 'on'
}

export function validateProjectId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CentralError('invalid_project_id', 'projectId must be a string')
  }
  const id = value.trim()
  if (id === '' || id.length > MAX_PROJECT_ID) {
    throw new CentralError(
      'invalid_project_id',
      `projectId must be 1..${MAX_PROJECT_ID} characters`
    )
  }
  return id
}

/** Human/root only. Agents, orchestrators, and workers are rejected by kind. */
export function isHumanAuthority(actor: CentralActor): boolean {
  return actor.kind === 'human' || actor.kind === 'root'
}

export function assertHumanAuthority(actor: unknown): CentralActor {
  if (typeof actor !== 'object' || actor === null) {
    throw new CentralError('invalid_actor', 'actor is required')
  }
  const candidate = actor as Partial<CentralActor>
  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
    throw new CentralError('invalid_actor', 'actor.id must be a non-empty string')
  }
  if (typeof candidate.kind !== 'string') {
    throw new CentralError('invalid_actor', 'actor.kind must be a string')
  }
  if (!isHumanAuthority(candidate as CentralActor)) {
    throw new CentralError(
      'forbidden',
      `actor kind ${candidate.kind} cannot mutate central state; only human/root may`
    )
  }
  return { id: candidate.id.trim(), kind: candidate.kind as ActorKind }
}

/** Integer input is required; out-of-range values clamp into the named envelope. */
export function clampPriority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new CentralError('invalid_priority', `priority must be an integer, got ${String(value)}`)
  }
  return Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, value))
}

export interface PlanSummary {
  id: string
  status: string
  version: number
  items: {
    total: number
    pending: number
    assigned: number
    running: number
    done: number
    failed: number
    cancelled: number
  }
}

export interface TaskBrief {
  id: string
  updatedAt: number
}

export interface BudgetSummary {
  limitMicros: number
  /** Ledger bookkeeping only; central never performs budget arithmetic. */
  spentMicros: number
  hardCap: boolean
}

export interface UsageSummary {
  costMicros: number
  inputTokens: number
  outputTokens: number
  unpricedRecords: number
}

export type TaskCounts = Record<TaskStatus, number>

export interface PortfolioEntry {
  id: string
  name: string
  status: string
  priority: number
  updatedAt: number
  plan: PlanSummary | null
  tasks: TaskCounts
  taskTotal: number
  pendingApprovals: number
  latest: { verified: TaskBrief | null; failed: TaskBrief | null }
  budget: BudgetSummary | null
  usage: UsageSummary
}

export interface PortfolioPage {
  items: PortfolioEntry[]
  total: number
  limit: number
  offset: number
}

export interface PortfolioOptions {
  projectId?: string
  limit?: number
  offset?: number
}

export function emptyTaskCounts(): TaskCounts {
  return {
    pending: 0,
    leased: 0,
    suspect: 0,
    claimed_done: 0,
    verified: 0,
    blocked: 0,
    failed: 0,
    cancelled: 0,
    reopened: 0,
  }
}

export function clampPortfolioLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PORTFOLIO_LIMIT
  if (!Number.isFinite(value) || value <= 0) {
    throw new CentralError('invalid_limit', `limit must be a positive number, got ${value}`)
  }
  return Math.min(MAX_PORTFOLIO_LIMIT, Math.trunc(value))
}

export function clampPortfolioOffset(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isFinite(value) || value < 0) {
    throw new CentralError('invalid_offset', `offset must be a non-negative number, got ${value}`)
  }
  return Math.min(MAX_PORTFOLIO_OFFSET, Math.trunc(value))
}
