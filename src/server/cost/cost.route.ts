// HTTP for the Cost panel. Root token / same-origin UI only (not in `isNodeTokenPath`):
//   GET  /api/cost                        -> CostResponse (today + 7 days, caps, labels, pricing source)
//   GET  /api/cost/estimate?kind=&ref=    -> Estimate (median of similar runs)
//   PUT  /api/cost/caps   {scope, limitMicros}
//   POST /api/cost/resume {scope}
import type { Database } from 'bun:sqlite'
import { LEDGER_OFF, type RouteResult } from '../apiShared.types'
import { utcDayStart } from '../central/guard/budgetStore'
import { PRICING_CHECKED_AT, PRICING_SOURCE_URL } from './costPricing'
import { spendSummary, type SpendSummary } from './costStore'
import { estimateCost, listCaps, resumeCost, setCostCap, type CapRow, type CostScope } from './costOracle'

export const COST_PATH = '/api/cost'
export const COST_BODY_MAX_BYTES = 4096
const DAY_MS = 86_400_000
const WEEK_DAYS = 7
const SCOPE_RE = /^(day|(routine|dag):[\w.:-]{1,128})$/

export interface CostResponse {
  today: SpendSummary
  week: SpendSummary
  caps: CapRow[]
  /** Display names for workspace and node ids seen in the groups. */
  labels: Record<string, string>
  pricing: { source: string; checkedAt: string }
}

export interface CostRouteDeps {
  db: Database | null
  now?: number
  /** Called before a read so the numbers include the latest Central turns. */
  sync?: () => void
  label?: (kind: 'workspace' | 'node', id: string) => string
}

function parseBody(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const bad = (error: string): RouteResult => ({ status: 400, body: { error } })

/** null = not a cost path. */
export async function costRoute(path: string, method: string, query: URLSearchParams, body: () => Promise<string>, deps: CostRouteDeps): Promise<RouteResult | null> {
  if (path !== COST_PATH && !path.startsWith(`${COST_PATH}/`)) return null
  const db = deps.db
  if (!db) return LEDGER_OFF
  const now = deps.now ?? Date.now()
  if (path === COST_PATH) {
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
    deps.sync?.()
    const startOfToday = utcDayStart(now)
    const today = spendSummary(db, startOfToday)
    const week = spendSummary(db, startOfToday - (WEEK_DAYS - 1) * DAY_MS)
    const labels: Record<string, string> = {}
    if (deps.label) {
      for (const s of [today, week]) {
        for (const g of s.byWorkspace) if (g.key) labels[`workspace:${g.key}`] = deps.label('workspace', g.key)
        for (const g of s.byNode) if (g.key) labels[`node:${g.key}`] = deps.label('node', g.key)
      }
    }
    const res: CostResponse = { today, week, caps: listCaps(db, now), labels, pricing: { source: PRICING_SOURCE_URL, checkedAt: PRICING_CHECKED_AT } }
    return { status: 200, body: res }
  }
  if (path === `${COST_PATH}/estimate`) {
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
    const kind = query.get('kind')
    const ref = query.get('ref') ?? ''
    if ((kind !== 'routine' && kind !== 'dag') || !SCOPE_RE.test(`${kind}:${ref}`)) return bad('invalid_kind_or_ref')
    return { status: 200, body: estimateCost(db, { kind, ref }) }
  }
  const write = path === `${COST_PATH}/caps` ? 'PUT' : path === `${COST_PATH}/resume` ? 'POST' : null
  if (!write) return { status: 404, body: { error: 'unknown_cost_route' } }
  if (method !== write) return { status: 405, body: { error: 'method_not_allowed' } }
  const input = parseBody(await body())
  const scope = input?.scope
  if (typeof scope !== 'string' || !SCOPE_RE.test(scope)) return bad('invalid_scope')
  if (write === 'POST') {
    resumeCost(db, scope as CostScope)
    return { status: 200, body: { ok: true } }
  }
  const limit = input?.limitMicros
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) return bad('invalid_limit')
  setCostCap(db, scope as CostScope, limit)
  return { status: 200, body: { ok: true } }
}
