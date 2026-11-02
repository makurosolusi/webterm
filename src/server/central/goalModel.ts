/**
 * P5 goal contract (RND/08 §6, RND/10 §2). Pure validation and transitions only:
 * no SQLite, no clock. The goal lives in `project.goal_json` (schema v4) as one
 * versioned JSON document; the store owns persistence and audit events.
 */
import { DEFAULT_CAPS } from '../orchestrator/caps'
import { DEFAULT_EXECUTABLES } from '../orchestrator/verifyCommands'

export const GOAL_STATUSES = ['proposed', 'active', 'achieved', 'abandoned', 'superseded'] as const
export type GoalStatus = (typeof GOAL_STATUSES)[number]
/** Mirrors RND/10 §2; `achieved` is server-owned, everything else needs a human. */
export const GOAL_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  proposed: ['active'],
  active: ['achieved', 'abandoned', 'superseded'],
  achieved: [],
  abandoned: [],
  superseded: [],
}

export type SuccessCriterion =
  | { kind: 'command'; command: string }
  | { kind: 'scope'; paths: string[] }
  | { kind: 'review'; by: 'human' }

export interface GoalEnvelope { maxCostMicros: number; maxWallMs: number; maxItems: number }

export interface Goal {
  version: number
  status: GoalStatus
  statement: string
  successCriteria: SuccessCriterion[]
  owner: string
  horizon: string
  envelope: GoalEnvelope
}

/** The part a proposer supplies; version/status are assigned by the store. */
export interface GoalDraftInput {
  statement: unknown
  successCriteria: unknown
  owner: unknown
  horizon: unknown
  envelope: unknown
}

export type GoalContent = Omit<Goal, 'version' | 'status'>

export type GoalErrorCode =
  | 'invalid_statement' | 'invalid_criteria' | 'invalid_command' | 'invalid_scope'
  | 'invalid_review' | 'invalid_owner' | 'invalid_horizon' | 'invalid_envelope' | 'invalid_goal'
  | 'invalid_status' | 'invalid_version' | 'illegal_transition' | 'forbidden' | 'corrupt_goal'
  | 'project_not_found' | 'goal_active' | 'stale_version'

export class GoalError extends Error {
  constructor(readonly code: GoalErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'GoalError'
  }
}

export const MAX_STATEMENT_CHARS = 500
export const MAX_CRITERIA = 20
export const MAX_SCOPE_PATHS = 20
export const MAX_PATH_CHARS = 300
export const MAX_COMMAND_CHARS = 200
/** Mirrors MAX_PLAN_ITEMS; a goal must not demand more items than a plan can hold. */
export const MAX_GOAL_ITEMS = 50
const OWNER_PREFIX = 'human:'
const HORIZON = /^\d{4}-\d{2}-\d{2}$/
const CONTROL = /[\u0000-\u001f\u007f]/
/** Executable-level allowlist plus no shell metacharacters: the criterion stays argv-shaped. */
const SHELL_META = /[;&|`$<>\n\r\t]/

function fail(code: GoalErrorCode, message: string): never {
  throw new GoalError(code, message)
}

function text(value: unknown, label: string, max: number): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed === '' || trimmed.length > max || CONTROL.test(trimmed)) {
    fail('invalid_goal', `${label} must be 1..${max} characters without control characters`)
  }
  return trimmed
}
function validateStatement(value: unknown): string {
  const statement = typeof value === 'string' ? value.trim() : ''
  if (statement === '' || CONTROL.test(statement) || statement.length > MAX_STATEMENT_CHARS) {
    fail('invalid_statement', `statement must be 1..${MAX_STATEMENT_CHARS} single-line characters`)
  }
  return statement
}

function validateCommand(value: unknown): string {
  const command = typeof value === 'string' ? value.trim() : ''
  if (command === '' || command.length > MAX_COMMAND_CHARS) {
    fail('invalid_command', `command must be 1..${MAX_COMMAND_CHARS} characters`)
  }
  if (SHELL_META.test(command)) fail('invalid_command', 'command must not contain shell metacharacters')
  const [file] = command.split(/\s+/)
  if (file === undefined || !(DEFAULT_EXECUTABLES as readonly string[]).includes(file)) {
    fail('invalid_command', `executable ${JSON.stringify(file)} is not in the verifier allowlist`)
  }
  return command
}

function requirePath(raw: unknown, index: number): string {
  const path = typeof raw === 'string' ? raw.trim() : ''
  if (path === '' || path.length > MAX_PATH_CHARS || CONTROL.test(path) || path.includes('\\')) {
    fail('invalid_scope', `paths[${index}] must be a POSIX path of 1..${MAX_PATH_CHARS} characters`)
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) fail('invalid_scope', `paths[${index}] must be relative`)
  if (path.split('/').includes('..')) fail('invalid_scope', `paths[${index}] must not escape the project`)
  return path
}

function validateCriterion(raw: unknown, index: number): SuccessCriterion {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('invalid_criteria', `bad criterion ${index}`)
  const criterion = raw as Record<string, unknown>
  if (criterion['kind'] === 'command') return { kind: 'command', command: validateCommand(criterion['command']) }
  if (criterion['kind'] === 'scope') {
    const paths = criterion['paths']
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_SCOPE_PATHS) {
      fail('invalid_scope', `paths must contain 1..${MAX_SCOPE_PATHS} entries`)
    }
    return { kind: 'scope', paths: paths.map((path, i) => requirePath(path, i)) }
  }
  if (criterion['kind'] === 'review') {
    if (criterion['by'] !== 'human') fail('invalid_review', 'review criteria must be checked by "human"')
    return { kind: 'review', by: 'human' }
  }
  fail('invalid_criteria', `successCriteria[${index}].kind must be command|scope|review`)
}

function validateEnvelope(value: unknown): GoalEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('invalid_envelope', 'envelope must be an object')
  const raw = value as Record<string, unknown>
  const limit = (field: string, max: number): number => {
    const n = raw[field]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) fail('invalid_envelope', `${field} must be a positive integer`)
    if (n > max) fail('invalid_envelope', `${field} exceeds the global limit ${max}`)
    return n
  }
  return {
    maxCostMicros: limit('maxCostMicros', DEFAULT_CAPS.maxCostMicros),
    maxWallMs: limit('maxWallMs', DEFAULT_CAPS.maxWallMs),
    maxItems: limit('maxItems', MAX_GOAL_ITEMS),
  }
}

/** Validates a proposed goal body; throws `GoalError` with a stable code. */
export function validateGoalContent(input: GoalDraftInput): GoalContent {
  if (typeof input !== 'object' || input === null) fail('invalid_goal', 'goal draft is required')
  const criteria = input.successCriteria
  if (!Array.isArray(criteria) || criteria.length === 0 || criteria.length > MAX_CRITERIA) {
    fail('invalid_criteria', `successCriteria must contain 1..${MAX_CRITERIA} entries`)
  }
  const owner = text(input.owner, 'owner', 100)
  if (!owner.startsWith(OWNER_PREFIX) || owner.length === OWNER_PREFIX.length) fail('invalid_owner', 'owner must be human:*')
  const horizon = text(input.horizon, 'horizon', 10)
  const [y, m, d] = horizon.split('-').map(Number)
  const parsed = new Date(Date.UTC(y, m - 1, d))
  const real = parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
  if (!HORIZON.test(horizon) || !real) fail('invalid_horizon', 'invalid date')
  return {
    statement: validateStatement(input.statement),
    successCriteria: criteria.map((criterion, index) => validateCriterion(criterion, index)),
    owner,
    horizon,
    envelope: validateEnvelope(input.envelope),
  }
}

/** Parses a stored goal document; a malformed row is `corrupt_goal`, never repaired. */
export function parseGoalStored(raw: string): Goal {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new GoalError('corrupt_goal', `goal_json is not valid JSON: ${String(err)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('corrupt_goal', 'goal_json must be an object')
  const goal = parsed as Record<string, unknown>
  const { version, status } = goal
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) fail('invalid_version', 'bad version')
  if (typeof status !== 'string' || !(GOAL_STATUSES as readonly string[]).includes(status)) {
    fail('invalid_status', `unknown goal status ${JSON.stringify(status)}`)
  }
  return { version, status: status as GoalStatus, ...validateGoalContent(goal as unknown as GoalDraftInput) }
}

/** Enforces RND/10 transitions; only a server actor may mark `achieved`. */
export function assertGoalTransition(from: GoalStatus, to: GoalStatus, actorKind: string): void {
  if (to === 'achieved' && actorKind !== 'server' && actorKind !== 'system') fail('forbidden', 'server-only transition')
  if (!GOAL_TRANSITIONS[from].includes(to)) fail('illegal_transition', `goal cannot move from ${from} to ${to}`)
}
