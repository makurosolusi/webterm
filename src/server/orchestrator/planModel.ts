// Bentuk data, validasi murni, dan error plan (RND/03-RENCANA.md §8).
// Dipisah dari store SQL di `plan.ts` supaya keduanya tetap di bawah budget file
// dan validasi bisa diuji tanpa SQLite.

export type PlanStatus = 'draft' | 'active' | 'completed' | 'abandoned'
export type PlanItemStatus =
  | 'pending'
  | 'assigned'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'

export const PLAN_STATUSES: readonly PlanStatus[] = ['draft', 'active', 'completed', 'abandoned']
export const PLAN_ITEM_STATUSES: readonly PlanItemStatus[] = [
  'pending',
  'assigned',
  'running',
  'done',
  'failed',
  'cancelled',
]

/** Item yang masih memegang task hidup; `replace` menolak menyentuhnya. */
export const LIVE_ITEM_STATUSES: readonly PlanItemStatus[] = ['assigned', 'running']

/** Transisi item yang sah; assign (pending->assigned) hanya lewat `assign`. */
export const ITEM_TRANSITIONS: Readonly<Record<PlanItemStatus, readonly PlanItemStatus[]>> = {
  pending: [],
  assigned: ['running', 'cancelled'],
  running: ['done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
}

export interface PlanItem {
  id: string
  planId: string
  seq: number
  taskId: string | null
  title: string
  scope: string[]
  status: PlanItemStatus
  assignee: string | null
  assignedAt: number | null
  updatedAt: number
}

export interface Plan {
  id: string
  projectId: string
  version: number
  status: PlanStatus
  items: PlanItem[]
  createdAt: number
  updatedAt: number
}

export type PlanDenyCode =
  | 'invalid_project'
  | 'invalid_item'
  | 'invalid_scope'
  | 'plan_exists'
  | 'plan_not_found'
  | 'stale_version'
  | 'item_not_found'
  | 'invalid_transition'
  | 'not_participant'
  | 'task_already_assigned'
  | 'plan_in_progress'
  | 'too_many_items'

export class PlanError extends Error {
  constructor(readonly code: PlanDenyCode, message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class StalePlanVersionError extends PlanError {
  constructor(
    readonly projectId: string,
    readonly expected: number,
    readonly actual: number
  ) {
    super(
      'stale_version',
      `plan for project ${projectId} is at version ${actual}, caller expected ${expected}`
    )
  }
}

/** Slice minimal bun:sqlite yang dipakai; cukup sempit untuk fake di test murni. */
export interface PlanStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

export interface PlanDb {
  query(sql: string): PlanStatement
  exec(sql: string): void
  readonly inTransaction?: boolean
}

export interface PlanItemInput {
  title: string
  scope: string[]
  taskId?: string
}

export interface CreatePlanInput {
  projectId: string
  items: PlanItemInput[]
  status?: PlanStatus
  now?: number
}

export interface ReplacePlanInput {
  projectId: string
  expectedVersion: number
  items: PlanItemInput[]
  status?: PlanStatus
  now?: number
}

export interface AssignItemInput {
  projectId: string
  itemId: string
  taskId: string
  assignee: string
  expectedVersion: number
  now?: number
}

export interface UpdateItemInput {
  projectId: string
  itemId: string
  expectedVersion: number
  /** Hanya assignee item ini yang boleh mengubah status. */
  actor: string
  status: PlanItemStatus
  now?: number
}

export interface PlanStore {
  get(projectId: string): Plan | null
  create(input: CreatePlanInput): Plan
  replace(input: ReplacePlanInput): Plan
  assign(input: AssignItemInput): Plan
  updateItem(input: UpdateItemInput): Plan
}

const MAX_SCOPE_ENTRIES = 50
const MAX_PLAN_ITEMS = 50
const MAX_TITLE = 500

function requireText(value: unknown, label: string, code: PlanDenyCode): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PlanError(code, `${label} must be a non-empty string`)
  }
  return value.trim()
}

export function validateTitle(value: unknown): string {
  const title = requireText(value, 'plan item title', 'invalid_item')
  if (title.length > MAX_TITLE) {
    throw new PlanError('invalid_item', `plan item title exceeds ${MAX_TITLE} characters`)
  }
  return title
}

/**
 * Scope adalah path relatif di dalam repo. Absolut, `..`, backslash, dan entri kosong
 * ditolak supaya scope tidak bisa dipakai untuk keluar dari worktree.
 */
export function validateScope(value: unknown): string[] {
  if (!Array.isArray(value)) throw new PlanError('invalid_scope', 'plan item scope must be an array')
  if (value.length === 0) throw new PlanError('invalid_scope', 'plan item scope must not be empty')
  if (value.length > MAX_SCOPE_ENTRIES) {
    throw new PlanError('invalid_scope', `plan item scope exceeds ${MAX_SCOPE_ENTRIES} entries`)
  }
  const seen = new Set<string>()
  const scope: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') throw new PlanError('invalid_scope', 'scope entry must be a string')
    const entry = raw.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '')
    if (entry === '' || entry === '.') {
      throw new PlanError('invalid_scope', `scope entry must not be empty: ${JSON.stringify(raw)}`)
    }
    if (entry.startsWith('/') || /^[A-Za-z]:\//.test(entry)) {
      throw new PlanError('invalid_scope', `scope entry must be relative, got ${entry}`)
    }
    if (entry.includes('\u0000') || entry.split('/').some((segment) => segment === '..')) {
      throw new PlanError('invalid_scope', `scope entry escapes the worktree: ${entry}`)
    }
    if (seen.has(entry)) continue
    seen.add(entry)
    scope.push(entry)
  }
  return scope
}

export function normalizeItems(items: unknown): PlanItemInput[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new PlanError('invalid_item', 'plan must contain at least one item')
  }
  if (items.length > MAX_PLAN_ITEMS) {
    throw new PlanError('too_many_items', `plan exceeds ${MAX_PLAN_ITEMS} items`)
  }
  return items.map((raw, index) => {
    const item = raw as Partial<PlanItemInput>
    const taskId =
      item.taskId === undefined
        ? undefined
        : requireText(item.taskId, `plan item ${index} taskId`, 'invalid_item')
    return { title: validateTitle(item.title), scope: validateScope(item.scope), taskId }
  })
}

export function toItem(r: Record<string, unknown>): PlanItem {
  return {
    id: String(r['id']),
    planId: String(r['plan_id']),
    seq: Number(r['seq']),
    taskId: r['task_id'] === null || r['task_id'] === undefined ? null : String(r['task_id']),
    title: String(r['title']),
    scope: parseJsonArray(r['scope_json']),
    status: String(r['status']) as PlanItemStatus,
    assignee:
      r['assignee'] === null || r['assignee'] === undefined ? null : String(r['assignee']),
    assignedAt:
      r['assigned_at'] === null || r['assigned_at'] === undefined
        ? null
        : Number(r['assigned_at']),
    updatedAt: Number(r['updated_at']),
  }
}

function parseJsonArray(text: unknown): string[] {
  const parsed: unknown = JSON.parse(String(text))
  return Array.isArray(parsed) ? parsed.map((v) => String(v)) : []
}
