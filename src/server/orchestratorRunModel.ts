// Payload model for POST /api/orchestrator/run: flag gating and strict request parsing.
// Nothing here touches the DB, a PTY or the filesystem, so it is safe to unit test in isolation.
// The request only names a project/item and a plan version. Repo, command, agent and exec are
// resolved SERVER-SIDE (project.path + settings), never taken from the payload: a run spawns a
// real PTY, so a client-supplied repo/cmd would be remote command execution.
import type { RouteResult } from './apiShared.types'
import { BUILTIN_AGENT_IDS } from '../shared/workspace'
import { flagOn } from './envFlag'

export type { RouteResult }

export const ORCHESTRATOR_RUN_FLAG = 'WEBTERM_ORCHESTRATOR_RUN'
/** Opt-in policy gate: when `on`, a run must name an approved, digest-bound ledger approval. */
export const ORCHESTRATOR_REQUIRE_APPROVAL_FLAG = 'WEBTERM_RUN_REQUIRE_APPROVAL'
export const ORCHESTRATOR_RUN_PATH = '/api/orchestrator/run'

/** Legacy worker kind: used when nothing is configured and `claude` is installed. */
export const DEFAULT_AGENT_ID = 'claude'
/** P3: worker kind for users without Claude (free-model friendly). */
export const FALLBACK_AGENT_ID = 'opencode'
/** Preference among configured kinds; the remaining builtins follow in `BUILTIN_AGENT_IDS` order. */
const WORKER_KIND_PREFERENCE: readonly string[] = [DEFAULT_AGENT_ID, FALLBACK_AGENT_ID]
export const MAX_ID_CHARS = 200
export const MAX_PROMPT_CHARS = 2000
export const MAX_BASE_REF_CHARS = 200
/** `approvalDigest` is a SHA-256 hex string; anything else cannot match an approved action. */
export const APPROVAL_DIGEST_CHARS = 64
export const MIN_TIMEOUT_MS = 5_000
export const MAX_TIMEOUT_MS = 15 * 60_000

/** Fields that would let a client choose WHAT runs or WHERE. Rejected outright. */
export const CLIENT_CONTROLLED_FIELDS = [
  'repo', 'path', 'cwd', 'cmd', 'command', 'args', 'argv', 'exec', 'env', 'shell', 'agent', 'agentId',
] as const

export function orchestratorRunEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return flagOn(env[ORCHESTRATOR_RUN_FLAG])
}

/** Default OFF: approval is optional unless an operator explicitly requires it. */
export function orchestratorRunRequireApproval(
  env: Record<string, string | undefined> = process.env
): boolean {
  return flagOn(env[ORCHESTRATOR_REQUIRE_APPROVAL_FLAG])
}

/**
 * Worker kind from `settings.agentLaunchCommands`: the first configured kind (claude, opencode,
 * then the other builtins). Nothing configured keeps the legacy `claude`, or `opencode` when
 * `claudeOnPath` is false (P3).
 */
export function resolveWorkerKind(
  configured: Partial<Record<string, string>>,
  claudeOnPath = true
): string {
  const order = [...WORKER_KIND_PREFERENCE, ...BUILTIN_AGENT_IDS.filter((id) => !WORKER_KIND_PREFERENCE.includes(id))]
  const hit = order.find((id) => (configured[id]?.trim() ?? '') !== '')
  if (hit !== undefined) return hit
  return claudeOnPath ? DEFAULT_AGENT_ID : FALLBACK_AGENT_ID
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) return null
  return trimmed
}

export interface RawRun {
  projectId: string
  itemId: string
  expectedVersion: number
  prompt?: string
  baseRef?: string
  timeoutMs?: number
  /** Ledger approval the client claims covers this run; both fields travel together. */
  approvalId?: string
  approvalDigest?: string
}

const APPROVAL_DIGEST_PATTERN = /^[0-9a-f]+$/

function digestText(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length === APPROVAL_DIGEST_CHARS &&
    APPROVAL_DIGEST_PATTERN.test(value)
    ? value
    : null
}

function invalid(error: string, message?: string): { ok: false; result: RouteResult } {
  return { ok: false, result: { status: 400, body: message ? { error, message } : { error } } }
}
/** Validates the payload. Server-resolved fields are refused, not silently ignored. */
export function parseRunBody(
  body: unknown
): { ok: true; value: RawRun } | { ok: false; result: RouteResult } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return invalid('invalid_body')
  const raw = body as Record<string, unknown>
  for (const field of CLIENT_CONTROLLED_FIELDS) {
    if (field in raw) {
      return invalid('client_controlled_field', `${field} is resolved server-side and must not be sent`)
    }
  }
  const projectId = text(raw['projectId'], MAX_ID_CHARS)
  if (projectId === null) return invalid('invalid_project_id')
  const itemId = text(raw['itemId'], MAX_ID_CHARS)
  if (itemId === null) return invalid('invalid_item_id')
  const rawVersion = raw['expectedVersion']
  const expectedVersion =
    typeof rawVersion === 'number' && Number.isSafeInteger(rawVersion) && rawVersion >= 0
      ? rawVersion
      : null
  if (expectedVersion === null) return invalid('invalid_expected_version')
  let prompt: string | undefined
  if (raw['prompt'] !== undefined) {
    if (typeof raw['prompt'] !== 'string' || raw['prompt'].length > MAX_PROMPT_CHARS) {
      return invalid('invalid_prompt')
    }
    prompt = raw['prompt']
  }
  let baseRef: string | undefined
  if (raw['baseRef'] !== undefined) {
    const ref = text(raw['baseRef'], MAX_BASE_REF_CHARS)
    if (ref === null) return invalid('invalid_base_ref')
    if (ref.startsWith('-') || ref.includes('..') || /[\s~^:?*[\\]/.test(ref)) {
      return invalid('invalid_base_ref', 'baseRef has characters git rejects')
    }
    baseRef = ref
  }
  let timeoutMs: number | undefined
  if (raw['timeoutMs'] !== undefined) {
    const value = raw['timeoutMs']
    if (typeof value !== 'number' || !Number.isFinite(value)) return invalid('invalid_timeout')
    timeoutMs = Math.min(Math.max(Math.round(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
  }
  // Approval fields are allowed (unlike repo/cmd): they name a ledger decision, not an action.
  // They are paired, so a half-approval is a malformed request rather than a silent no-op.
  let approvalId: string | undefined
  if (raw['approvalId'] !== undefined) {
    const id = text(raw['approvalId'], MAX_ID_CHARS)
    if (id === null) return invalid('invalid_approval')
    approvalId = id
  }
  let approvalDigest: string | undefined
  if (raw['approvalDigest'] !== undefined) {
    const digest = digestText(raw['approvalDigest'])
    if (digest === null) return invalid('invalid_approval_digest')
    approvalDigest = digest
  }
  if ((approvalId === undefined) !== (approvalDigest === undefined)) {
    return invalid('invalid_approval', 'approvalId and approvalDigest must be sent together')
  }
  return {
    ok: true,
    value: {
      projectId,
      itemId,
      expectedVersion,
      ...(prompt === undefined ? {} : { prompt }),
      ...(baseRef === undefined ? {} : { baseRef }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(approvalId === undefined ? {} : { approvalId }),
      ...(approvalDigest === undefined ? {} : { approvalDigest }),
    },
  }
}
