// Single server-side gate for every central effect (RND/29 4.2 step 6). Pure factory over an injected db/clock/env:
// level -> project pause -> caps -> budget -> doom-loop -> breaker; each decision is written to the audit trail.
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { appendEvent } from '../../ledger/ledgerEvent'
import { getRow } from '../../ledger/ledgerCore'
import { PROJECT_PAUSED } from '../centralModel'
import type { BreakerKey, ControlGuard, ControlLevel, GuardCode, GuardDecision, GuardRequest, GuardUsage, Tier } from '../contracts/level.types'
import { addUsage, budgetExhausted, budgetLimits, readBudget, utcDay } from './budgetStore'
import { createBreakerStore, type SyncBreaker } from './breakerStore'
import { DEFAULT_GLOBAL_LEVEL, effectiveLevelOf, levelRank, projectRef, readLevel } from './levelStore'

/** I11: concurrent workers per project and across the whole server. */
export const MAX_WORKERS_PER_PROJECT = 3
export const MAX_WORKERS_GLOBAL = 5
/** Doom-loop: the same proposal digest seen this many times inside the window opens its breaker. */
export const DOOM_THRESHOLD = 3
export const DOOM_WINDOW_MS = 10 * 60_000
const MAX_TRACKED_DIGESTS = 500
const MAX_DIGEST = 64
const MAX_TOOL = 64
const GUARD_AUDIT_KIND = 'central.guard'
const SPAWN_TOOLS: readonly string[] = ['agent.spawn', 'task.run']
/** Agent states that no longer hold a worker slot (`approval_pending` has not started yet). */
const SLOT_FREE_STATES = ['approval_pending', 'closed', 'failed', 'timed_out', 'lease_expired', 'session_exited', 'cancelled', 'killed', 'orphaned']
const MIN_LEVEL: Record<Tier, ControlLevel> = { R0: 'observe', R1: 'propose', R2: 'act_gated', R3: 'propose' }

/** The guard with synchronous returns (still assignable to the contract's `ControlGuard`). */
export interface SyncControlGuard extends ControlGuard {
  check(req: GuardRequest): GuardDecision
  effectiveLevel(projectId: string | null): ControlLevel
  recordUsage(usage: GuardUsage): void
  readonly breaker: SyncBreaker
}

export interface GuardDeps {
  db: Database
  now: () => number
  /** Read on every call so a lowered ceiling applies at once; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  random?: () => number
  breaker?: SyncBreaker
}

function activeAgents(db: Database, projectId: string | null): number {
  const marks = SLOT_FREE_STATES.map(() => '?').join(',')
  const where = projectId ? ' AND project_id = ?' : ''
  const row = getRow(db, `SELECT count(*) AS c FROM central_agents WHERE ended_at IS NULL AND state NOT IN (${marks})${where}`, ...SLOT_FREE_STATES, ...(projectId ? [projectId] : []))
  return Number(row?.c ?? 0)
}

/** Builds the guard; flag wiring and mounting belong to the integrator. */
export function createControlGuard(deps: GuardDeps): SyncControlGuard {
  const { db, now } = deps
  const env = (): Record<string, string | undefined> => deps.env ?? process.env
  const breaker = deps.breaker ?? createBreakerStore({ db, now, ...(deps.random ? { random: deps.random } : {}) })
  const seen = new Map<string, number[]>()

  const effectiveLevel = (projectId: string | null): ControlLevel => effectiveLevelOf(db, projectId, env())

  /** Counts this sighting of `digest`; true once it reaches the threshold inside the window. */
  const isDoomLoop = (digest: string): boolean => {
    const at = now()
    const hits = (seen.get(digest) ?? []).filter((t) => at - t < DOOM_WINDOW_MS)
    hits.push(at)
    seen.delete(digest)
    seen.set(digest, hits)
    if (seen.size > MAX_TRACKED_DIGESTS) seen.delete(seen.keys().next().value as string)
    return hits.length >= DOOM_THRESHOLD
  }

  const judge = (req: GuardRequest, level: ControlLevel): GuardDecision => {
    const deny = (code: GuardCode, reason: string): GuardDecision => ({ verdict: 'deny', level, code, reason })
    const globalLevel = readLevel(db, 'global')?.level ?? DEFAULT_GLOBAL_LEVEL
    if (globalLevel === 'off') return deny('halted', 'central is halted (global level off)')
    if (req.projectId) {
      const status = getRow(db, 'SELECT status FROM project WHERE id = ?', req.projectId)?.status
      if (status === PROJECT_PAUSED) return deny('project_paused', 'project is paused')
    }
    const spawn = req.action === 'spawn'
    const need: ControlLevel = spawn ? 'act_gated' : req.action === 'turn' ? 'observe' : MIN_LEVEL[req.tier]
    if (level === 'off' || levelRank(level) < levelRank(need)) return deny('level_denied', `level ${level} is below ${need}`)

    if (spawn) {
      if (req.projectId && activeAgents(db, req.projectId) >= MAX_WORKERS_PER_PROJECT) return deny('cap_project', `project already has ${MAX_WORKERS_PER_PROJECT} active workers`)
      if (activeAgents(db, null) >= MAX_WORKERS_GLOBAL) return deny('cap_global', `${MAX_WORKERS_GLOBAL} workers already active`)
    }
    const costly = spawn || req.action === 'turn' || req.tier !== 'R0'
    if (costly) {
      const over = budgetExhausted(readBudget(db, utcDay(now()), 'global'), budgetLimits(env()), spawn)
      if (over) return deny(over.code, over.reason)
    }
    // Reads (R0) legitimately repeat; only effects can loop.
    const digest = req.digest?.replace(/[^\w.-]/g, '').slice(0, MAX_DIGEST)
    if (digest && req.tier !== 'R0') {
      const itemKey: BreakerKey = `item:${digest}`
      const row = breaker.peek(itemKey)
      if (row && row.state !== 'closed' && !breaker.allow(itemKey).allowed) return deny(row.lastCode === 'doom_loop' ? 'doom_loop' : 'breaker_open', 'this proposal keeps repeating')
      if (isDoomLoop(digest)) {
        breaker.open(itemKey, 'doom_loop')
        return deny('doom_loop', `same proposal seen ${DOOM_THRESHOLD} times in ${DOOM_WINDOW_MS / 60_000} min`)
      }
    }
    if (req.projectId && !breaker.allow(`project:${req.projectId}`).allowed) return deny('breaker_open', 'project breaker is open')

    const tier: Tier = spawn && req.tier < 'R2' ? 'R2' : req.tier
    if (tier === 'R3' || (tier === 'R2' && level !== 'act_envelope')) return { verdict: 'needs_approval', level, tier }
    return { verdict: 'allow', level }
  }

  return {
    breaker,
    effectiveLevel,
    recordUsage: (usage) => addUsage(db, usage, now),
    check(req) {
      const level = effectiveLevel(req.projectId)
      const decision = judge(req, level)
      const code = decision.verdict === 'deny' ? { code: decision.code, reason: decision.reason } : {}
      appendEvent({ db, now }, {
        actor: 'guard', kind: GUARD_AUDIT_KIND, ...projectRef(db, req.projectId),
        payload: { action: req.action, tool: req.tool.slice(0, MAX_TOOL), tier: req.tier, projectId: req.projectId, level, verdict: decision.verdict, ...code },
      })
      return decision
    },
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Request/verdict shapes of the WS-03 registry port (`tools/toolTypes.ts`), kept structural on purpose. */
export interface ToolGuardRequest { tool: string; tier: Tier; projectId?: string; input: Record<string, unknown> }
export type ToolGuardVerdict = { ok: true } | { ok: false; code: string }

/**
 * Adapts the guard to the registry's sync `check`. `approved` marks execution after a human approval
 * (needs_approval then passes); a guard exception denies with `guard_error` and is reported to `onError`.
 */
export function toToolGuard(guard: SyncControlGuard, opts: { approved?: boolean; onError?: (err: unknown) => void } = {}): { check(req: ToolGuardRequest): ToolGuardVerdict } {
  return {
    check(req) {
      try {
        const digest = createHash('sha256').update(`${req.tool}\n${canonical(req.input)}`).digest('hex').slice(0, 32)
        const action = SPAWN_TOOLS.includes(req.tool) ? 'spawn' : 'tool'
        const d = guard.check({ action, projectId: req.projectId ?? null, tool: req.tool, tier: req.tier, digest })
        if (d.verdict === 'allow' || (d.verdict === 'needs_approval' && opts.approved)) return { ok: true }
        return { ok: false, code: d.verdict === 'deny' ? d.code : 'approval_required' }
      } catch (err) {
        opts.onError?.(err)
        return { ok: false, code: 'guard_error' }
      }
    },
  }
}
