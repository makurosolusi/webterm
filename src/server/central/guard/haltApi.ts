// Pure handlers for `POST /api/central/halt` (root only) and `GET|PUT /api/central/control`. The transport
// authenticates and passes the derived actor; this module never reads tokens and is not mounted here (WS-19).
import type { Database } from 'bun:sqlite'
import { appendEvent } from '../../ledger/ledgerEvent'
import { allRows } from '../../ledger/ledgerCore'
import { boundedInteger } from '../../apiShared.params'
import type { RouteResult } from '../../apiShared.types'
import { CONTROL_LEVELS, type ControlLevel, type ControlScope } from '../contracts/level.types'
import { effectiveLevelOf, envCeiling, globalLevelOf, readLevel, setLevel, type GuardActor } from './levelStore'

export const HALT_PATH = '/api/central/halt'
export const CONTROL_PATH = '/api/central/control'
const DEFAULT_PAGE = 50
const MAX_PAGE = 200
const MAX_OFFSET = 1_000_000
const MAX_PROJECT_ID = 200
const HALT_REASON_DEFAULT = 'kill-switch'
const HALT_AUDIT_KIND = 'central.halt'

/** Parsed request; `actor` is derived by the transport from the credential, null = unauthenticated. */
export interface ControlRequest { method: string; path: string; query?: URLSearchParams; body?: unknown; actor: GuardActor | null }
export interface ControlDeps {
  db: Database
  now: () => number
  env?: Record<string, string | undefined>
  /** Side effects of a halt owned by other modules (close agents, revoke capabilities); may be async. */
  onHalt?: (info: { reason: string; actor: GuardActor }) => void | Promise<void>
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): RouteResult => ({ status, body: { error, ...extra } })
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Sets global level off and runs `onHalt`; idempotent, the level change is persisted before any hook runs. */
async function halt(req: ControlRequest, deps: ControlDeps): Promise<RouteResult> {
  if (!req.actor) return fail(401, 'unauthenticated')
  if (req.actor.kind !== 'root') return fail(403, 'root_only')
  const raw = isRecord(req.body) ? req.body.reason : undefined
  const reason = typeof raw === 'string' && raw.trim() !== '' ? raw.trim().slice(0, 200) : HALT_REASON_DEFAULT
  const res = setLevel(deps.db, { scope: 'global', level: 'off', actor: req.actor, reason, now: deps.now })
  if (!res.ok) return fail(409, res.code, { reason: res.reason })
  appendEvent({ db: deps.db, now: deps.now }, { actor: req.actor.id, kind: HALT_AUDIT_KIND, payload: { reason, version: res.version } })
  try {
    await deps.onHalt?.({ reason, actor: req.actor })
  } catch (err) {
    return fail(500, 'halt_hook_failed', { halted: true, version: res.version, detail: err instanceof Error ? err.message : String(err) })
  }
  return { status: 200, body: { halted: true, level: 'off', version: res.version } }
}

function readControl(req: ControlRequest, deps: ControlDeps): RouteResult {
  const env = deps.env ?? process.env
  const global = readLevel(deps.db, 'global')
  const base = { ceiling: envCeiling(env), global: { level: globalLevelOf(deps.db), version: global?.version ?? 0, reason: global?.reason ?? null, setBy: global?.setBy ?? null, setAt: global?.setAt ?? null } }
  const projectId = req.query?.get('projectId')?.trim()
  if (projectId) {
    if (projectId.length > MAX_PROJECT_ID) return fail(400, 'invalid_project')
    const own = readLevel(deps.db, `project:${projectId}`)
    return { status: 200, body: { ...base, projectId, project: own, effective: effectiveLevelOf(deps.db, projectId, env) } }
  }
  const limit = boundedInteger(req.query?.get('limit') ?? null, 1, MAX_PAGE)
  const offset = boundedInteger(req.query?.get('offset') ?? null, 0, MAX_OFFSET)
  if (limit === null || offset === null) return fail(400, 'invalid_page')
  const rows = allRows(deps.db, "SELECT scope, level, version, set_by, set_at FROM central_control WHERE scope LIKE 'project:%' ORDER BY scope LIMIT ? OFFSET ?", limit ?? DEFAULT_PAGE, offset ?? 0)
  const projects = rows.map((r) => ({ scope: String(r.scope), level: String(r.level), version: Number(r.version), setBy: String(r.set_by), setAt: Number(r.set_at) }))
  return { status: 200, body: { ...base, effective: effectiveLevelOf(deps.db, null, env), projects } }
}

function putControl(req: ControlRequest, deps: ControlDeps): RouteResult {
  if (!req.actor) return fail(401, 'unauthenticated')
  const b = req.body
  if (!isRecord(b) || typeof b.scope !== 'string' || typeof b.level !== 'string') return fail(400, 'invalid_body')
  if (!(CONTROL_LEVELS as readonly string[]).includes(b.level)) return fail(400, 'invalid_level')
  const expected = b.expectedVersion
  if (expected !== undefined && (!Number.isInteger(expected) || (expected as number) < 0)) return fail(400, 'invalid_version')
  const res = setLevel(deps.db, {
    scope: b.scope as ControlScope, level: b.level as ControlLevel, actor: req.actor, now: deps.now,
    ...(typeof b.reason === 'string' ? { reason: b.reason } : {}),
    ...(expected !== undefined ? { expectedVersion: expected as number } : {}),
  })
  if (res.ok) return { status: 200, body: { level: res.level, version: res.version, changed: res.changed } }
  return fail(res.code === 'forbidden' ? 403 : res.code === 'conflict' ? 409 : 400, res.code, { reason: res.reason })
}

/** Routes the three control endpoints; returns null for any other path so the caller can fall through. */
export async function controlRoute(req: ControlRequest, deps: ControlDeps): Promise<RouteResult | null> {
  if (req.path === HALT_PATH) return req.method === 'POST' ? halt(req, deps) : fail(405, 'method_not_allowed')
  if (req.path !== CONTROL_PATH) return null
  if (req.method === 'GET') {
    if (!req.actor) return fail(401, 'unauthenticated')
    return req.actor.kind === 'root' || req.actor.kind === 'human' ? readControl(req, deps) : fail(403, 'human_only')
  }
  return req.method === 'PUT' ? putControl(req, deps) : fail(405, 'method_not_allowed')
}
