// Deep analysis for the board's Health tab (H4): start one (POST, `human:*` actor) and read its state (GET).
// Not a node-token path (auth.ts `isNodeTokenPath`); lock: routes/route.uiOnly.policy.bun.test.ts.
import type { RouteResult } from '../apiShared.types'
import { getRow } from '../ledger/ledgerCore'
import type { Ca2Handle } from './ca2Boot'
import { HUMAN_PREFIX } from './ca2Routes.act'
import { healthAnalyzerFor } from './health/healthAnalyze'
import { isSafeId } from './tools/defs/read.shared'

const ANALYZE = '/api/central/health/analyze'

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): RouteResult => ({ status, body: { error, ...extra } })
const projectExists = (h: Ca2Handle, id: string): boolean => getRow(h.db, 'SELECT 1 AS one FROM project WHERE id = ?', id) !== null

/** Whether `path` is the analysis route. */
export const isHealthAnalyzePath = (path: string): boolean => path === ANALYZE

/** Answers a path `isHealthAnalyzePath` accepted. */
export async function healthAnalyzeDispatch(
  h: Ca2Handle, req: { method: string; query: URLSearchParams; body: () => Promise<unknown> }, actor: string,
): Promise<RouteResult> {
  if (req.method !== 'GET' && req.method !== 'POST') return fail(405, 'method_not_allowed')
  if (req.method === 'POST' && !actor.startsWith(HUMAN_PREFIX)) return fail(403, 'human_only')
  const raw = req.method === 'GET' ? req.query.get('projectId') : ((await req.body()) as { projectId?: unknown } | null)?.projectId
  if (!isSafeId(raw)) return fail(400, 'invalid_project')
  if (!projectExists(h, raw)) return fail(404, 'project_not_found')
  const analyzer = healthAnalyzerFor(h.db, h.now)
  if (req.method === 'GET') {
    return { status: 200, body: { scan: analyzer.latest(raw), running: analyzer.running(raw), retryAt: analyzer.retryAt(raw), dropped: analyzer.dropped(raw) } }
  }
  const started = analyzer.start(raw)
  if (started.ok) return { status: 202, body: started.scan }
  return started.code === 'cooldown' ? fail(429, 'cooldown', { retryAt: started.retryAt }) : fail(409, 'analysis_running')
}
