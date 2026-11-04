// HTTP binding of the Problems service, same `{status, body} | null` contract as
// workspaceWorktree.route.ts.
//
//   GET  /api/problems?workspace=<id>[&limit=&offset=]  ProblemsState, problems paged (default 200)
//   POST /api/problems/run  {workspace}                 start tsc --watch + run eslint once
//   POST /api/problems/stop {workspace}                 stop the watcher
//   POST /api/problems/fix  {workspace, to}             queue the list for agent node `to` (outbox)
//
// POSTs spawn workspace binaries or type into an agent, so they are human-UI only (`uiOnlyDenial`).
import type { IncomingMessage } from 'node:http'
import { isSafeNodeId, type Workspace } from '../../shared/workspace'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import { isValidNodeToken } from '../hooksTokens'
import type { EnqueueInput } from '../outbox/outboxStore'
import { OUTBOX_BODY_MAX_CHARS } from '../outbox/outbox.route'
import { formatProblemsForAgent } from './problems.parse'
import { ProblemsService } from './problems.service'

export const PROBLEMS_PATH = '/api/problems'
const PAGE_DEFAULT = 200

type Result = { status: number; body: unknown } | null
const bad = (message: string): Result => ({ status: 400, body: { error: 'bad_request', message } })

export interface ProblemsRouteDeps {
  service(): Promise<ProblemsService>
  workspace(id: string): Promise<Workspace | null>
  outbox(): Promise<{ refusal(to: string): string | null; enqueue(input: EnqueueInput): unknown }>
  isNodeToken?: (token: string) => boolean
}

let service: ProblemsService | undefined
async function defaultService(): Promise<ProblemsService> {
  if (service) return service
  const { productionProblemsDeps } = await import('./problems.process')
  service = new ProblemsService(productionProblemsDeps())
  process.once('exit', () => service?.stopAll())
  return service
}

const defaults: ProblemsRouteDeps = {
  service: defaultService,
  workspace: async (id) => (await import('../db')).db.get(id),
  outbox: async () => (await import('../outbox/outboxRuntime')).startOutbox(),
}

function intParam(v: string | null, dflt: number): number | null {
  if (v === null || v === '') return dflt
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}

export async function problemsRoute(req: IncomingMessage, url: URL, body: () => Promise<string>, deps: ProblemsRouteDeps = defaults): Promise<Result> {
  const path = url.pathname
  if (path !== PROBLEMS_PATH && !path.startsWith(`${PROBLEMS_PATH}/`)) return null
  const method = req.method ?? 'GET'
  if (method === 'GET' && path === PROBLEMS_PATH) {
    const ws = url.searchParams.get('workspace')
    if (!ws) return bad('workspace is required')
    const limit = intParam(url.searchParams.get('limit'), PAGE_DEFAULT)
    const offset = intParam(url.searchParams.get('offset'), 0)
    if (!limit || offset === null) return bad('limit >= 1, offset >= 0')
    const s = (await deps.service()).state(ws)
    return { status: 200, body: { ...s, total: s.problems.length, problems: s.problems.slice(offset, offset + limit) } }
  }
  const verb = path.slice(PROBLEMS_PATH.length + 1)
  if (method !== 'POST' || !['run', 'stop', 'fix'].includes(verb)) return null
  const denial = uiOnlyDenial(req, url, deps.isNodeToken ?? isValidNodeToken)
  if (denial) return { status: 403, body: { error: denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_run_problems' : denial, message: 'Problems are run from the webterm UI only.' } }
  let b: { workspace?: unknown; to?: unknown }
  try { b = JSON.parse(await body()) } catch { return bad('bad json') }
  if (!b || typeof b.workspace !== 'string') return bad('workspace is required')
  const ws = await deps.workspace(b.workspace)
  if (!ws?.cwd) return { status: 404, body: { error: 'not_found', message: 'Workspace not found or has no folder.' } }
  const svc = await deps.service()
  if (verb === 'stop') { svc.stop(ws.id); return { status: 200, body: svc.state(ws.id) } }
  if (verb === 'run') return { status: 200, body: await svc.run(ws.id, ws.cwd) }
  if (!isSafeNodeId(b.to)) return bad('to must be a node id')
  const s = svc.state(ws.id)
  if (s.problems.length === 0) return { status: 409, body: { error: 'no_problems', message: 'There are no problems to send.' } }
  const ob = await deps.outbox()
  const refusal = ob.refusal(b.to)
  if (refusal) return { status: 404, body: { error: 'bad_target', message: refusal } }
  const res = ob.enqueue({
    to: b.to, body: formatProblemsForAgent(s.problems, ws.cwd, OUTBOX_BODY_MAX_CHARS), kind: 'visible',
    // Same snapshot sent twice is one message (outbox dedupe on operationId).
    operationId: `problems:${ws.id}:${s.updatedAt ?? 0}`.slice(0, 200), createdBy: 'human-ui',
  })
  return { status: 202, body: res }
}
