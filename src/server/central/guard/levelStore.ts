// Persistent control ladder (RND/28b 4.1): level per scope in `central_control`, effective level =
// min(env ceiling, global, project). Lowering is open to humans and the server; raising needs a human/root actor.
import type { Database } from 'bun:sqlite'
import { appendEvent } from '../../ledger/ledgerEvent'
import { execWrite, getRow, tx } from '../../ledger/ledgerCore'
import { CONTROL_LEVELS, type ControlLevel, type ControlScope } from '../contracts/level.types'

/** Level of the global scope when no row exists yet (L2 propose, RND/28b 4.1). */
export const DEFAULT_GLOBAL_LEVEL: ControlLevel = 'propose'
/** A project without its own row inherits the global level, i.e. it adds no restriction. */
const TOP_LEVEL: ControlLevel = CONTROL_LEVELS[CONTROL_LEVELS.length - 1]!
const CENTRAL_AGENTS_ENV = 'WEBTERM_CENTRAL_AGENTS'
const MAX_REASON = 200
const MAX_ACTOR_ID = 80
/** Audit kind for every level change. */
export const CONTROL_AUDIT_KIND = 'central.control'

/** Who asks, derived by the transport from the credential (never from model text). */
export type GuardActorKind = 'root' | 'human' | 'system' | 'central' | 'worker'
export interface GuardActor { kind: GuardActorKind; id: string }

/** One persisted `central_control` row. */
export interface StoredLevel { scope: ControlScope; level: ControlLevel; reason: string | null; setBy: string; setAt: number; version: number }

export type SetLevelResult =
  | { ok: true; level: ControlLevel; version: number; changed: boolean }
  | { ok: false; code: 'forbidden' | 'conflict' | 'invalid'; reason: string }

/** Position of a level on the ladder (higher = more authority). */
export function levelRank(level: ControlLevel): number { return CONTROL_LEVELS.indexOf(level) }
/** Lowest of the given levels. */
export function minLevel(...levels: ControlLevel[]): ControlLevel {
  return levels.reduce((low, next) => (levelRank(next) < levelRank(low) ? next : low))
}

/** Ceiling ("Batas tertinggi") from `WEBTERM_CENTRAL_AGENTS` (derived from the Worker/Otonomi cards): off = propose only, propose = act_gated, auto = act_envelope. */
export function envCeiling(env: Record<string, string | undefined>): ControlLevel {
  const mode = (env[CENTRAL_AGENTS_ENV] ?? '').trim().toLowerCase()
  if (mode === 'propose') return 'act_gated'
  if (mode === 'auto') return 'act_envelope'
  return 'propose'
}

/** `{projectId}` for an audit event only when the project exists (events reject dangling refs). */
export function projectRef(db: Database, projectId: string | null): { projectId?: string } {
  if (!projectId) return {}
  return getRow(db, 'SELECT 1 AS one FROM project WHERE id = ?', projectId) ? { projectId } : {}
}

function scopeOf(projectId: string | null): ControlScope { return projectId ? `project:${projectId}` : 'global' }

/** Persisted row for `scope`, or null. */
export function readLevel(db: Database, scope: ControlScope): StoredLevel | null {
  const r = getRow(db, 'SELECT scope, level, reason, set_by, set_at, version FROM central_control WHERE scope = ?', scope)
  if (!r) return null
  return { scope, level: String(r.level) as ControlLevel, reason: r.reason === null ? null : String(r.reason), setBy: String(r.set_by), setAt: Number(r.set_at), version: Number(r.version) }
}

/** A global scope without a row inherits the ceiling, capped here: per-action approval, never envelope by default. */
const INHERIT_MAX: ControlLevel = 'act_gated'

/** Global level in force: the stored row, else the ceiling capped at act_gated. */
export function globalLevelOf(db: Database, env: Record<string, string | undefined>): ControlLevel {
  return readLevel(db, 'global')?.level ?? minLevel(envCeiling(env), INHERIT_MAX)
}

/**
 * `min(ceiling, global, project)` read fresh from the DB on every call. No global row = the ceiling up to
 * act_gated, so turning on the Worker card is enough for Central to run workers (each run still needs an
 * approval card); act_envelope always needs a human to raise the global level.
 */
export function effectiveLevelOf(db: Database, projectId: string | null, env: Record<string, string | undefined>): ControlLevel {
  const global = globalLevelOf(db, env)
  const project = projectId ? readLevel(db, scopeOf(projectId))?.level ?? TOP_LEVEL : TOP_LEVEL
  return minLevel(envCeiling(env), global, project)
}

const LOWER_KINDS: readonly GuardActorKind[] = ['root', 'human', 'system']
const RAISE_KINDS: readonly GuardActorKind[] = ['root', 'human']

/** Sets a scope's level with optional CAS; raising needs a root/human actor, lowering also allows `system`. */
export function setLevel(
  db: Database,
  input: { scope: ControlScope; level: ControlLevel; actor: GuardActor; reason?: string; expectedVersion?: number; now: () => number },
): SetLevelResult {
  const { scope, level, actor } = input
  const validScope = scope === 'global' || (scope.startsWith('project:') && scope.length > 'project:'.length)
  if (!validScope || levelRank(level) < 0) return { ok: false, code: 'invalid', reason: 'invalid scope or level' }
  const actorId = actor.id.trim().slice(0, MAX_ACTOR_ID)
  if (actorId === '') return { ok: false, code: 'invalid', reason: 'actor id required' }
  return tx({ db, now: input.now }, () => {
    const row = readLevel(db, scope)
    const current = row?.level ?? (scope === 'global' ? DEFAULT_GLOBAL_LEVEL : TOP_LEVEL)
    const raising = levelRank(level) > levelRank(current)
    if (!(raising ? RAISE_KINDS : LOWER_KINDS).includes(actor.kind)) {
      return { ok: false, code: 'forbidden', reason: raising ? 'raising a level needs a human token' : 'actor may not change levels' } as const
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== (row?.version ?? 0)) {
      return { ok: false, code: 'conflict', reason: `version is ${row?.version ?? 0}` } as const
    }
    const reason = input.reason?.slice(0, MAX_REASON) ?? null
    const at = input.now()
    const version = (row?.version ?? 0) + 1
    if (row) execWrite(db, 'UPDATE central_control SET level = ?, reason = ?, set_by = ?, set_at = ?, version = ? WHERE scope = ?', level, reason, actorId, at, version, scope)
    else execWrite(db, 'INSERT INTO central_control (scope, level, reason, set_by, set_at, version) VALUES (?, ?, ?, ?, ?, ?)', scope, level, reason, actorId, at, version)
    const pid = scope === 'global' ? null : scope.slice('project:'.length)
    appendEvent({ db, now: input.now }, { actor: actorId, kind: CONTROL_AUDIT_KIND, ...projectRef(db, pid), payload: { scope, from: current, to: level, reason, actorKind: actor.kind, version } })
    return { ok: true, level, version, changed: current !== level } as const
  })
}
