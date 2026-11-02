// Payload parsing/validation for the root-only orchestrator control plane
// (POST /api/orchestrator/bootstrap and POST /api/orchestrator/assign). No ledger, no
// filesystem mutation: the only filesystem access is a read-only git-root probe.
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { PlanError, validateScope } from './orchestrator/plan'
import type { RouteResult } from './orchestratorRunApi'

const MAX_ID_CHARS = 200
const MAX_NAME_CHARS = 200
const MAX_PATH_CHARS = 4096
const MAX_ITEMS = 20
const MAX_ITEM_TITLE = 200
const MAX_ITEM_SCOPE = 20
const MAX_BRANCH_BASE = 200
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** Agent ids are namespaced (`orch:<project>`, `worker:<project>`), so `:` is allowed. */
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
/** Everything a control body must not carry; `path` is bootstrap's own field, checked per route. */
const CLIENT_FIELDS = ['cmd', 'command', 'args', 'argv', 'exec', 'shell', 'repo', 'path', 'cwd', 'agent', 'agentId'] as const

/** Typed failure that maps directly onto an HTTP status + error code. */
export class ControlError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
    this.name = 'ControlError'
  }
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) return null
  if (CONTROL_CHARS.test(value)) return null
  return value.trim()
}

function id(value: unknown): string | null {
  const parsed = text(value, MAX_ID_CHARS)
  return parsed !== null && ID_PATTERN.test(parsed) ? parsed : null
}

function agentId(value: unknown): string | null {
  const parsed = text(value, MAX_ID_CHARS)
  return parsed !== null && AGENT_ID_PATTERN.test(parsed) ? parsed : null
}

function invalid(error: string): { ok: false; result: RouteResult } {
  return { ok: false, result: { status: 400, body: { error } } }
}

export interface BootstrapItem { title: string; scope: string[] }

export interface BootstrapInput {
  projectId: string; name: string; path: string; items: BootstrapItem[]; branchBase?: string
}

/** `.git` may be a directory (normal clone) or a file (worktree/submodule pointer). */
export function defaultIsGitRoot(path: string): boolean {
  try { return statSync(path).isDirectory() && existsSync(join(path, '.git')) } catch { return false }
}

function parseItems(raw: unknown): BootstrapItem[] | string {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ITEMS) return 'invalid_items'
  const items: BootstrapItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 'invalid_items'
    const item = entry as Record<string, unknown>
    const title = text(item['title'], MAX_ITEM_TITLE)
    if (title === null) return 'invalid_item_title'
    if (!Array.isArray(item['scope']) || item['scope'].length === 0 || item['scope'].length > MAX_ITEM_SCOPE) {
      return 'invalid_scope'
    }
    try {
      items.push({ title, scope: validateScope(item['scope']) })
    } catch (err) {
      if (!(err instanceof PlanError)) throw err
      return 'invalid_scope'
    }
  }
  return items
}

/** Validates a bootstrap payload; `path` is checked against the filesystem, never trusted. */
export function parseBootstrapBody(
  body: unknown,
  isGitRoot: (path: string) => boolean = defaultIsGitRoot
): { ok: true; value: BootstrapInput } | { ok: false; result: RouteResult } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return invalid('invalid_body')
  const raw = body as Record<string, unknown>
  for (const field of CLIENT_FIELDS) if (field !== 'path' && field in raw) return invalid('client_controlled_field')
  const projectId = id(raw['projectId'])
  if (projectId === null) return invalid('invalid_project_id')
  const name = text(raw['name'], MAX_NAME_CHARS)
  if (name === null) return invalid('invalid_name')
  const path = raw['path']
  if (
    typeof path !== 'string' || path === '' || path.length > MAX_PATH_CHARS ||
    path !== path.trim() || CONTROL_CHARS.test(path) || !isAbsolute(path) || !isGitRoot(path)
  ) {
    return invalid('invalid_path')
  }
  const items = parseItems(raw['items'])
  if (typeof items === 'string') return invalid(items)
  let branchBase: string | undefined
  if (raw['branchBase'] !== undefined) {
    const ref = text(raw['branchBase'], MAX_BRANCH_BASE)
    if (ref === null || ref.startsWith('-') || ref.includes('..') || /[\s~^:?*[\\]/.test(ref)) {
      return invalid('invalid_branch_base')
    }
    branchBase = ref
  }
  return { ok: true, value: { projectId, name, path, items, branchBase } }
}

export interface AssignInput {
  projectId: string; itemId: string; expectedVersion: number; assignee: string
}

/** Default assignee is the deterministic worker id created by bootstrap. */
export function parseAssignBody(
  body: unknown
): { ok: true; value: AssignInput } | { ok: false; result: RouteResult } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return invalid('invalid_body')
  const raw = body as Record<string, unknown>
  for (const field of CLIENT_FIELDS) if (field in raw) return invalid('client_controlled_field')
  const projectId = id(raw['projectId'])
  if (projectId === null) return invalid('invalid_project_id')
  const itemId = id(raw['itemId'])
  if (itemId === null) return invalid('invalid_item_id')
  const version = raw['expectedVersion']
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return invalid('invalid_expected_version')
  }
  const assignee = raw['assignee'] === undefined ? `worker:${projectId}` : agentId(raw['assignee'])
  if (assignee === null) return invalid('invalid_assignee')
  return { ok: true, value: { projectId, itemId, expectedVersion: version, assignee } }
}
