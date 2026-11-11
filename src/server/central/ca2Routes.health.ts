// Project health for the board's Health tab: summary, findings, manual scan, dismiss/reopen. Not node-token
// paths (auth.ts `isNodeTokenPath`); writes need a `human:*` actor. Lock: routes/route.uiOnly.policy.bun.test.ts.
import type { FindingOrigin, FindingStatus, FindingView, HealthLevel, HealthRule } from '../../shared/centralHealth'
import type { RouteResult } from '../apiShared.types'
import { getRow } from '../ledger/ledgerCore'
import { redactSecrets } from '../redactSecrets'
import type { Ca2Handle } from './ca2Boot'
import { HUMAN_PREFIX } from './ca2Routes.act'
import { pageOf } from './ca2Routes.read'
import { syncDismissalMemory } from './health/healthMemory'
import { healthServiceFor } from './health/healthService'
import { HealthStoreError, createHealthStore, type HealthStore } from './health/healthStore'
import { isSafeId } from './tools/defs/read.shared'

const SUMMARY = '/api/central/health/summary'
const FINDINGS = '/api/central/health/findings'
const SCAN = '/api/central/health/scan'
const ACTION = /^\/api\/central\/health\/findings\/([^/]+)\/(dismiss|reopen)$/
const STATUSES: readonly FindingStatus[] = ['open', 'fixed', 'dismissed']
const LEVELS: readonly HealthLevel[] = ['high', 'medium', 'low']
const RULES: readonly HealthRule[] = ['file_size', 'unreferenced_module', 'todo_no_context', 'empty_catch', 'new_file_no_test', 'analysis']
const ORIGINS: readonly FindingOrigin[] = ['scan', 'review', 'analysis']
const STORE_STATUS = { not_found: 404, invalid: 400, conflict: 409 } as const
const STORE_CODE = { not_found: 'finding_not_found', invalid: 'invalid_reason', conflict: 'illegal_transition' } as const

type Body = Record<string, unknown>
const fail = (status: number, error: string): RouteResult => ({ status, body: { error } })
const notAllowed = fail(405, 'method_not_allowed')
const bodyOf = (raw: unknown): Body => (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Body) : {})
const decode = (s: string): string | null => { try { return decodeURIComponent(s) } catch { return null } }
const projectExists = (h: Ca2Handle, id: string): boolean => getRow(h.db, 'SELECT 1 AS one FROM project WHERE id = ?', id) !== null
/** Repo text (evidence, titles) can carry a secret a developer committed; it never leaves unredacted. */
const clean = (f: FindingView): FindingView => ({ ...f, title: redactSecrets(f.title), evidence: redactSecrets(f.evidence), suggestion: redactSecrets(f.suggestion) })

/** Whether `path` is a health route. */
export const isHealthPath = (path: string): boolean => path === SUMMARY || path === FINDINGS || path === SCAN || ACTION.test(path)

/** Comma list of allowed values; undefined when absent, null when any value is unknown. */
function listParam<T extends string>(q: URLSearchParams, key: string, allowed: readonly T[]): T[] | undefined | null {
  const raw = q.get(key)
  if (raw === null || raw.trim() === '') return undefined
  const values = raw.split(',').map((v) => v.trim())
  return values.every((v) => (allowed as readonly string[]).includes(v)) ? (values as T[]) : null
}

function summary(h: Ca2Handle, store: HealthStore, q: URLSearchParams): RouteResult {
  const projectId = q.get('projectId')
  if (!isSafeId(projectId)) return fail(400, 'invalid_project')
  if (!projectExists(h, projectId)) return fail(404, 'project_not_found')
  return { status: 200, body: { ...store.summary(projectId), running: healthServiceFor(h.db, h.now).running(projectId) } }
}

function findings(h: Ca2Handle, store: HealthStore, q: URLSearchParams): RouteResult {
  const page = pageOf(q)
  if (!page) return fail(400, 'invalid_page')
  const statuses = listParam(q, 'status', STATUSES)
  const severities = listParam(q, 'severity', LEVELS)
  const rules = listParam(q, 'rule', RULES)
  const origins = listParam(q, 'origin', ORIGINS)
  if (statuses === null) return fail(400, 'invalid_status')
  if (severities === null) return fail(400, 'invalid_severity')
  if (rules === null) return fail(400, 'invalid_rule')
  if (origins === null) return fail(400, 'invalid_origin')
  const taskId = q.get('taskId') ?? undefined
  if (taskId !== undefined && !isSafeId(taskId)) return fail(400, 'invalid_task')
  let projectId = q.get('projectId') ?? undefined
  if (projectId !== undefined && !isSafeId(projectId)) return fail(400, 'invalid_project')
  if (projectId === undefined) {
    if (taskId === undefined) return fail(400, 'invalid_project')
    const task = getRow(h.db, 'SELECT project_id FROM central_task WHERE id = ?', taskId)
    if (!task) return fail(404, 'task_not_found')
    projectId = String(task['project_id'])
  } else if (!projectExists(h, projectId)) return fail(404, 'project_not_found')
  const filter = { projectId, ...(statuses ? { statuses } : {}), ...(severities ? { severities } : {}), ...(rules ? { rules } : {}), ...(origins ? { origins } : {}), ...(taskId ? { taskId } : {}) }
  const hasMore = store.list({ ...filter, limit: 1, offset: page.offset + page.limit }).length > 0
  return { status: 200, body: { items: store.list({ ...filter, ...page }).map(clean), hasMore } }
}

function scan(h: Ca2Handle, store: HealthStore, { projectId }: Body): RouteResult {
  if (!isSafeId(projectId)) return fail(400, 'invalid_project')
  if (!projectExists(h, projectId)) return fail(404, 'project_not_found')
  const service = healthServiceFor(h.db, h.now)
  if (service.running(projectId)) return fail(409, 'scan_running')
  void service.runScan(projectId, 'scan') // never rejects; the row is written before this returns
  return { status: 202, body: store.latestScan(projectId) }
}

/** Dismiss/reopen; the decision is mirrored into project memory, whose failure is logged and never fails the action. */
function action(h: Ca2Handle, store: HealthStore, rawId: string, verb: string, body: Body, actor: string): RouteResult {
  const id = decode(rawId)
  if (!isSafeId(id)) return fail(400, 'invalid_id')
  if (verb === 'dismiss' && typeof body.reason !== 'string') return fail(400, 'invalid_reason')
  let next: FindingView
  try {
    next = verb === 'dismiss' ? store.dismiss(id, body.reason as string, actor) : store.reopen(id, actor)
  } catch (err) {
    if (err instanceof HealthStoreError) return fail(STORE_STATUS[err.code], STORE_CODE[err.code])
    throw err
  }
  syncDismissalMemory(h.db, next, h.now())
  return { status: 200, body: clean(next) }
}

/** Answers a path `isHealthPath` accepted. */
export async function healthDispatch(
  h: Ca2Handle, req: { method: string; path: string; query: URLSearchParams; body: () => Promise<unknown> }, actor: string,
): Promise<RouteResult> {
  const { method, path, query } = req
  if (method === 'POST' && !actor.startsWith(HUMAN_PREFIX)) return fail(403, 'human_only')
  const store = createHealthStore(h.db, h.now)
  if (path === SUMMARY) return method === 'GET' ? summary(h, store, query) : notAllowed
  if (path === FINDINGS) return method === 'GET' ? findings(h, store, query) : notAllowed
  if (method !== 'POST') return notAllowed
  if (path === SCAN) return scan(h, store, bodyOf(await req.body()))
  const m = ACTION.exec(path)
  return action(h, store, m?.[1] ?? '', m?.[2] ?? '', bodyOf(await req.body()), actor)
}
