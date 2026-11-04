// Cost oracle for routines, DAG tasks and bake-off candidates: a run is a time window on a node (begin -> end), its cost
// is the node's captured usage inside that window. Estimates are the median of similar past runs;
// caps and low ROI (runs that keep producing no diff) pause the scope and leave an Inbox notice.
import type { Database } from 'bun:sqlite'
import { allRows, execWrite, getRow, newId } from '../ledger/ledgerCore'
import { createInboxItem } from '../inbox'
import { utcDayStart as dayStart } from '../central/guard/budgetStore'
import { ensureCostSchema, spentMicros } from './costStore'

export type CostRunKind = 'routine' | 'dag' | 'bakeoff'
/** `day` = all spend per UTC day; `routine:<id>` = that routine per UTC day; `dag:<id>` / `bakeoff:<id>` = that DAG / bake-off in total. */
export type CostScope = 'day' | `routine:${string}` | `dag:${string}` | `bakeoff:${string}`

/** Ended runs an estimate looks back over. */
const ESTIMATE_WINDOW = 20
/** This many ended runs in a row without a diff pauses the scope (low ROI). */
export const ROI_NO_DIFF_RUNS = 5

export interface BeginRunInput { kind: CostRunKind; ref: string; label?: string; workspaceId?: string | null; nodeId?: string | null }

export interface Notice { scope: CostScope; title: string; body: string; workspaceId: string | null }
export type Notify = (db: Database, n: Notice) => void

/** Default notifier: one open Inbox `notify` row per scope and reason (repeats bump its count). */
export const inboxNotify: Notify = (db, n) => {
  const project = n.workspaceId ? getRow(db, 'SELECT id FROM project WHERE id = ? OR workspace_id = ?', n.workspaceId, n.workspaceId) : null
  createInboxItem({ db, now: Date.now }, {
    kind: 'notify', source: 'cost', title: n.title, body: n.body, workspaceId: n.workspaceId,
    projectId: project ? String(project['id']) : null, dedupeKey: `cost:${n.scope}:${n.title}`,
  })
}

const usd = (micros: number): string => `$${(micros / 1e6).toFixed(2)}`

/** Starts a cost window; call before the routine/DAG task hands work to `nodeId`. */
export function beginCostRun(db: Database, input: BeginRunInput, now: () => number = Date.now): string {
  ensureCostSchema(db)
  const id = newId()
  execWrite(db, 'INSERT INTO cost_run (id, kind, ref, label, workspace_id, node_id, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, input.kind, input.ref, input.label ?? null, input.workspaceId ?? null, input.nodeId ?? null, now())
  return id
}

function windowCost(db: Database, nodeId: unknown, from: number, to: number): number {
  if (typeof nodeId !== 'string' || nodeId === '') return 0
  return spentMicros(db, { nodeId, since: from, until: to + 1 }).costMicros
}

export interface EndRunResult { costMicros: number; paused: string | null }

/**
 * Closes the window, stores its cost, then applies the ROI rule and the caps. Capture the node's
 * transcript first (costRuntime.endCostRunLive does) or the last responses are missed.
 */
export function endCostRun(db: Database, id: string, outcome: { producedDiff?: boolean; costMicros?: number | null }, now: () => number = Date.now, notify: Notify = inboxNotify): EndRunResult {
  ensureCostSchema(db)
  const run = getRow(db, 'SELECT * FROM cost_run WHERE id = ?', id)
  if (!run) throw new Error(`endCostRun: cost run ${id} not found`)
  const end = run['ended_at'] == null ? now() : Number(run['ended_at'])
  // A reported total (a headless run's `total_cost_usd`) wins over the captured window, which can miss responses.
  const cost = outcome.costMicros ?? windowCost(db, run['node_id'], Number(run['started_at']), end)
  const diff = outcome.producedDiff === undefined ? null : outcome.producedDiff ? 1 : 0
  execWrite(db, 'UPDATE cost_run SET ended_at = ?, cost_micros = ?, produced_diff = COALESCE(?, produced_diff) WHERE id = ?', end, cost, diff, id)
  const kind = String(run['kind']) as CostRunKind
  const ref = String(run['ref'])
  const scope: CostScope = `${kind}:${ref}`
  const workspaceId = run['workspace_id'] == null ? null : String(run['workspace_id'])
  const recent = allRows(db, 'SELECT produced_diff FROM cost_run WHERE kind = ? AND ref = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT ?', kind, ref, ROI_NO_DIFF_RUNS)
  if (recent.length === ROI_NO_DIFF_RUNS && recent.every((r) => r['produced_diff'] === 0) && !isPaused(db, scope)) {
    const spent = Number(getRow(db, 'SELECT COALESCE(SUM(cost_micros), 0) AS c FROM (SELECT cost_micros FROM cost_run WHERE kind = ? AND ref = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT ?)', kind, ref, ROI_NO_DIFF_RUNS)?.['c'] ?? 0)
    pauseScope(db, scope, `low ROI: last ${ROI_NO_DIFF_RUNS} runs produced no diff`)
    notify(db, { scope, workspaceId, title: `Paused ${kind} ${ref}: low ROI`, body: `The last ${ROI_NO_DIFF_RUNS} runs produced no diff and cost ${usd(spent)}. Resume it from Settings › Control › Cost.` })
    return { costMicros: cost, paused: scope }
  }
  const over = overCap(db, scope, now())
  if (over) notify(db, { scope, workspaceId, title: `Cost cap reached for ${kind} ${ref}`, body: over })
  return { costMicros: cost, paused: null }
}

export interface Estimate { medianMicros: number | null; samples: number; basis: 'ref' | 'kind' | 'none' }

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2)
}

/** Median cost of the last 20 runs of the same routine/DAG; falls back to all runs of that kind. */
export function estimateCost(db: Database, q: { kind: CostRunKind; ref: string }): Estimate {
  ensureCostSchema(db)
  const pick = (sql: string, ...args: unknown[]): number[] => allRows(db, sql, ...args).map((r) => Number(r['cost_micros']))
  const own = pick('SELECT cost_micros FROM cost_run WHERE kind = ? AND ref = ? AND cost_micros IS NOT NULL ORDER BY ended_at DESC LIMIT ?', q.kind, q.ref, ESTIMATE_WINDOW)
  if (own.length > 0) return { medianMicros: median(own), samples: own.length, basis: 'ref' }
  const kin = pick('SELECT cost_micros FROM cost_run WHERE kind = ? AND cost_micros IS NOT NULL ORDER BY ended_at DESC LIMIT ?', q.kind, ESTIMATE_WINDOW)
  return kin.length > 0 ? { medianMicros: median(kin), samples: kin.length, basis: 'kind' } : { medianMicros: null, samples: 0, basis: 'none' }
}

/** Spend of a scope in its cap period (`day`/`routine:` = today UTC, `dag:` = all time). */
export function scopeSpent(db: Database, scope: CostScope, now: number): number {
  ensureCostSchema(db)
  if (scope === 'day') return spentMicros(db, { since: dayStart(now) }).costMicros + uncapturedBakeoffMicros(db, dayStart(now))
  const [kind, ...rest] = scope.split(':')
  const since = kind === 'routine' ? dayStart(now) : 0
  const rows = allRows(db, 'SELECT node_id, started_at, ended_at, cost_micros FROM cost_run WHERE kind = ? AND ref = ? AND started_at >= ?', kind, rest.join(':'), since)
  // Running windows count too, so a long run cannot overshoot its cap unseen.
  return rows.reduce((sum, r) => sum + (r['ended_at'] == null ? windowCost(db, r['node_id'], Number(r['started_at']), now) : Number(r['cost_micros'] ?? 0)), 0)
}

/**
 * Bake-off cost reported by the run but absent from `cost_usage` (its transcript was never captured), so
 * the day cap sees it without counting captured responses twice. Bounded: a bake-off has at most 4 runs.
 */
function uncapturedBakeoffMicros(db: Database, since: number): number {
  const rows = allRows(db, "SELECT node_id, started_at, ended_at, cost_micros FROM cost_run WHERE kind = 'bakeoff' AND started_at >= ? AND ended_at IS NOT NULL AND cost_micros IS NOT NULL", since)
  return rows.reduce((sum, r) => sum + Math.max(0, Number(r['cost_micros']) - windowCost(db, r['node_id'], Number(r['started_at']), Number(r['ended_at']))), 0)
}

export function setCostCap(db: Database, scope: CostScope, limitMicros: number): void {
  ensureCostSchema(db)
  if (!Number.isInteger(limitMicros) || limitMicros < 0) throw new Error(`setCostCap: limitMicros must be a non-negative integer, got ${limitMicros}`)
  execWrite(db, 'INSERT INTO cost_cap (scope, limit_micros) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET limit_micros = excluded.limit_micros', scope, limitMicros)
}

function pauseScope(db: Database, scope: CostScope, reason: string): void {
  execWrite(db, 'INSERT INTO cost_cap (scope, paused_at, reason) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET paused_at = excluded.paused_at, reason = excluded.reason', scope, Date.now(), reason)
}

export function resumeCost(db: Database, scope: CostScope): void {
  ensureCostSchema(db)
  execWrite(db, 'UPDATE cost_cap SET paused_at = NULL, reason = NULL WHERE scope = ?', scope)
}

function isPaused(db: Database, scope: CostScope): boolean {
  return getRow(db, 'SELECT 1 AS one FROM cost_cap WHERE scope = ? AND paused_at IS NOT NULL', scope) !== null
}

const capOf = (db: Database, scope: CostScope): number => Number(getRow(db, 'SELECT limit_micros FROM cost_cap WHERE scope = ?', scope)?.['limit_micros'] ?? 0)

function overCap(db: Database, scope: CostScope, now: number): string | null {
  const cap = capOf(db, scope)
  if (cap <= 0) return null
  const spent = scopeSpent(db, scope, now)
  return spent >= cap ? `${scope} spent ${usd(spent)} of its ${usd(cap)} cap` : null
}

export interface CapRow { scope: string; limitMicros: number; spentMicros: number; pausedAt: number | null; reason: string | null }

export function listCaps(db: Database, now: number = Date.now()): CapRow[] {
  ensureCostSchema(db)
  return allRows(db, 'SELECT * FROM cost_cap ORDER BY scope').map((r) => ({
    scope: String(r['scope']), limitMicros: Number(r['limit_micros']), spentMicros: scopeSpent(db, String(r['scope']) as CostScope, now),
    pausedAt: r['paused_at'] == null ? null : Number(r['paused_at']), reason: r['reason'] == null ? null : String(r['reason']),
  }))
}

export interface GateResult { allowed: boolean; reason: string | null; estimate: Estimate }

/** Ask before starting a routine run / DAG task: paused scope, the day cap, then its own cap. A refusal is announced once per scope. */
export function costGate(db: Database, q: { kind: CostRunKind; ref: string; workspaceId?: string | null }, now: () => number = Date.now, notify: Notify = inboxNotify): GateResult {
  ensureCostSchema(db)
  const scope: CostScope = `${q.kind}:${q.ref}`
  const estimate = estimateCost(db, q)
  const paused = getRow(db, 'SELECT reason FROM cost_cap WHERE scope = ? AND paused_at IS NOT NULL', scope)
  if (paused) return { allowed: false, reason: `paused: ${String(paused['reason'] ?? 'by cost guard')}`, estimate }
  for (const s of ['day', scope] as CostScope[]) {
    const over = overCap(db, s, now())
    if (!over) continue
    notify(db, { scope: s, workspaceId: q.workspaceId ?? null, title: `Cost cap reached: ${s === 'day' ? 'daily spend' : `${q.kind} ${q.ref}`}`, body: `${over}. New runs wait until the cap is raised${s.startsWith('dag:') ? '' : ' or the UTC day ends'}.` })
    return { allowed: false, reason: over, estimate }
  }
  return { allowed: true, reason: null, estimate }
}

/**
 * Ask before a bake-off of `count` candidates: refused when the day cap is used up or cannot cover
 * `count` x the median past candidate cost. With no past candidates only a used-up cap refuses.
 */
export function bakeoffGate(db: Database, q: { count: number; workspaceId?: string | null }, now: () => number = Date.now, notify: Notify = inboxNotify): GateResult {
  ensureCostSchema(db)
  const per = estimateCost(db, { kind: 'bakeoff', ref: '' }) // every bake-off is new: the kind median is the basis
  const estimate: Estimate = { ...per, medianMicros: per.medianMicros === null ? null : per.medianMicros * q.count }
  const cap = capOf(db, 'day')
  if (cap <= 0) return { allowed: true, reason: null, estimate }
  const spent = scopeSpent(db, 'day', now())
  const need = estimate.medianMicros ?? 0
  if (spent < cap && spent + need <= cap) return { allowed: true, reason: null, estimate }
  const reason = spent >= cap
    ? `Daily cost cap reached: spent ${usd(spent)} of ${usd(cap)}. Raise the cap or wait for the UTC day to end before starting a bake-off.`
    : `A bake-off of ${q.count} candidates is estimated at ${usd(need)}, but only ${usd(cap - spent)} of the ${usd(cap)} daily cost cap remains. Use fewer candidates or raise the cap.`
  notify(db, { scope: 'day', workspaceId: q.workspaceId ?? null, title: 'Bake-off refused: daily cost cap', body: reason })
  return { allowed: false, reason, estimate }
}
