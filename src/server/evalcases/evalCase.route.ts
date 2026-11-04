// HTTP for eval cases. Root token / same-origin UI only (not in `isNodeTokenPath`): an agent never
// grades, promotes or reads the rejections of its own work.
//   GET  /api/evalcases?status=new|promoted|dismissed&limit=&offset=  -> {cases, total}  (captures first)
//   GET  /api/evalcases/export                                       -> the promoted dataset document
//   POST /api/evalcases/:id/promote {reason?}   POST /api/evalcases/:id/dismiss {reason?}  -> {case}
import type { Database } from 'bun:sqlite'
import { LEDGER_OFF, type RouteResult } from '../apiShared.types'
import { BodyReadError } from '../cappedRequestBody'
import { syncEvalCases } from './evalCase.capture'
import { decideEvalCase, EVAL_STATUSES, EvalCaseError, exportEvalCases, listEvalCases } from './evalCase.store'
import type { EvalCaseStatus } from './evalCase.model'

export const EVAL_CASES_PATH = '/api/evalcases'
export const EVAL_CASES_BODY_MAX_BYTES = 8 * 1024

export interface EvalCasesDeps {
  db: Database
  now: () => number
  /** Broker secret values to mask (production: `brokerSecretValues()`). */
  secrets: () => readonly string[]
}

export const isEvalCasesPath = (p: string): boolean => p === EVAL_CASES_PATH || p.startsWith(`${EVAL_CASES_PATH}/`)

async function productionDeps(): Promise<EvalCasesDeps | null> {
  const [{ activeLedgerRuntime }, { brokerSecretValues }] = await Promise.all([import('../ledger/ledgerRuntimeState'), import('../central/runtime/runtimeEvents')])
  const ledger = activeLedgerRuntime()
  return ledger ? { db: ledger.db, now: Date.now, secrets: () => brokerSecretValues() } : null
}

async function readReason(read: () => Promise<string>): Promise<{ reason: unknown } | RouteResult> {
  let raw: string
  try { raw = await read() } catch (err) {
    if (err instanceof BodyReadError) return { status: err.reason === 'too_large' ? 413 : 400, body: { error: err.reason } }
    throw err
  }
  if (raw === '') return { reason: undefined }
  try {
    const v: unknown = JSON.parse(raw)
    if (v && typeof v === 'object' && !Array.isArray(v)) return { reason: (v as Record<string, unknown>)['reason'] }
  } catch { /* falls through to the 400 below: a bad body is the caller's mistake */ }
  return { status: 400, body: { error: 'invalid_json' } }
}

const num = (v: string | null): number | undefined => (v === null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v))

/** null = not an eval-cases path. */
export async function evalCasesRoute(url: URL, method: string, body: () => Promise<string>, given?: EvalCasesDeps): Promise<RouteResult | null> {
  const path = url.pathname
  if (!isEvalCasesPath(path)) return null
  const deps = given ?? (await productionDeps())
  if (!deps) return LEDGER_OFF
  const [id = '', action = '', extra] = path.slice(EVAL_CASES_PATH.length + 1).split('/')
  if (path === EVAL_CASES_PATH || id === 'export') {
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
    syncEvalCases(deps.db, { now: deps.now(), secrets: deps.secrets() })
    if (id === 'export') return { status: 200, body: exportEvalCases(deps.db, deps.now()) }
    const status = url.searchParams.get('status')
    if (status !== null && !EVAL_STATUSES.includes(status as EvalCaseStatus)) return { status: 400, body: { error: 'invalid_status' } }
    const page = listEvalCases(deps.db, { ...(status ? { status: status as EvalCaseStatus } : {}), limit: num(url.searchParams.get('limit')), offset: num(url.searchParams.get('offset')) })
    return { status: 200, body: page }
  }
  if (extra !== undefined || (action !== 'promote' && action !== 'dismiss')) return { status: 404, body: { error: 'not_found' } }
  if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  const parsed = await readReason(body)
  if ('status' in parsed) return parsed
  try {
    const decided = decideEvalCase(deps.db, decodeURIComponent(id), action === 'promote' ? 'promoted' : 'dismissed', { now: deps.now(), reason: parsed.reason, secrets: deps.secrets() })
    return { status: 200, body: { case: decided } }
  } catch (err) {
    if (err instanceof EvalCaseError) return { status: err.code === 'not_found' ? 404 : 400, body: { error: err.code } }
    if (err instanceof URIError) return { status: 400, body: { error: 'invalid_id' } }
    throw err
  }
}
