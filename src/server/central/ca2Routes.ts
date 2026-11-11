// Mounts the Central Agent v2 control-panel endpoints (WS-19). Nothing answers while CA2 is inert
// (`activeCa2()` is null), so with Central off these paths keep falling through to 404 (the panel only
// opens while Central is on). With Central on, a family whose feature is off (agents, skills) answers
// 503 `agents_off` / `skills_off`, the same `<feature>_off` shape as `ledger_off` / `central_off`.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RouteResult } from '../apiShared.types'
import { cappedBodyGetter } from '../cappedRequestBody'
import { panicSnapshotAll } from '../checkpoint/checkpoint.service'
import { createLogger } from '../logs'
import { activeCa2 } from './ca2Active'
import type { Ca2Handle } from './ca2Boot'
import { type SkillAction, closeAgent, closeAllAgents, relayAgent, skillAction } from './ca2Routes.act'
import { agentsView, memoryView, skillsView, statusView } from './ca2Routes.read'
import { type BoardDeps, nodesView } from './ca2Routes.nodes'
import { isMemoryPath, memoryDispatch } from './ca2Routes.memory'
import { isWorkPath, workDispatch } from './ca2Routes.work'
import { goalsDispatch, isGoalsPath } from './ca2Routes.goals'
import { checkinDispatch, isCheckinPath } from './ca2Routes.checkin'
import { healthDispatch, isHealthPath } from './ca2Routes.health'
import { type ControlRequest, controlRoute } from './guard/haltApi'
import { toolsView } from './toolsCatalog.api'

const BASE = '/api/central'
const BODY_MAX_BYTES = 64 * 1024
const AGENT_ACTION = /^\/api\/central\/agents\/([^/]+)\/(relay|close)$/
const SKILL_ACTION = /^\/api\/central\/skills\/([^/]+)\/(approve|rollback|reject)$/
/** The transport only admits the root credential, so that is the identity every action runs as. */
const ROOT_ACTOR = { kind: 'root', id: 'root' } as const
const ROOT_HUMAN = 'human:root'
const log = createLogger('central.ca2')

/** Whether `path` belongs to the CA2 panel families (used to answer 405 instead of falling through). */
export const isCa2Path = (path: string): boolean =>
  ['/status', '/agents', '/nodes', '/skills', '/memory', '/tools', '/control', '/halt'].some((p) => path === BASE + p) || AGENT_ACTION.test(path) || SKILL_ACTION.test(path) || isWorkPath(path) || isGoalsPath(path) || isMemoryPath(path) || isCheckinPath(path) || isHealthPath(path)

const notAllowed: RouteResult = { status: 405, body: { error: 'method_not_allowed' } }
const decode = (s: string): string | null => { try { return decodeURIComponent(s) } catch { return null } }

/** Pure dispatcher: `null` = not a CA2 path; tests call this without HTTP. */
export async function ca2Dispatch(
  h: Ca2Handle, req: { method: string; path: string; query: URLSearchParams; body: () => Promise<unknown> }, actor = ROOT_HUMAN, board?: BoardDeps,
): Promise<RouteResult | null> {
  const { method, path, query } = req
  if (!isCa2Path(path)) return null
  if (isWorkPath(path)) return workDispatch(h, req, actor)
  if (isGoalsPath(path)) return goalsDispatch(h, req, actor)
  if (isCheckinPath(path)) return checkinDispatch(h, req, actor)
  if (isHealthPath(path)) return healthDispatch(h, req, actor)
  if (isMemoryPath(path)) return memoryDispatch(h, req, actor)
  const reads: Record<string, () => RouteResult | Promise<RouteResult>> = {
    '/nodes': () => nodesView(h, query, board),
    '/status': () => statusView(h), '/memory': () => memoryView(h, query),
    '/agents': () => agentsView(h, query), '/skills': () => skillsView(h, query), '/tools': () => toolsView(h),
  }
  const read = reads[path.slice(BASE.length)]
  if (read) return method === 'GET' ? read() : notAllowed
  const agent = AGENT_ACTION.exec(path)
  const skill = SKILL_ACTION.exec(path)
  if (agent || skill) {
    if (method !== 'POST') return notAllowed
    const id = decode((agent ?? skill)?.[1] ?? '')
    if (id === null) return { status: 400, body: { error: 'invalid_id' } }
    if (agent) return agent[2] === 'relay' ? relayAgent(h, id, await req.body()) : closeAgent(h, id)
    return skillAction(h, id, skill?.[2] as SkillAction, await req.body(), actor)
  }
  if (path === `${BASE}/control` || path === `${BASE}/halt`) {
    const control: ControlRequest = { method, path, query, body: method === 'GET' ? undefined : await req.body(), actor: ROOT_ACTOR }
    return controlRoute(control, { db: h.db, now: h.now, env: h.env, onHalt: ({ reason }) => Promise.all([panicSnapshotAll(), closeAllAgents(h, reason)]).then(() => undefined) }) // F3-c panic snapshot alongside the kill
  }
  return null
}

async function parsedBody(read: () => Promise<string>): Promise<unknown> {
  const text = await read()
  return text.trim() === '' ? {} : JSON.parse(text)
}

/** Node adapter for `api.ts`; `true` = response sent. */
export async function ca2Route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const h = activeCa2()
  if (!h || !isCa2Path(url.pathname)) return false
  const method = req.method || 'GET'
  let result: RouteResult | null
  try {
    result = await ca2Dispatch(h, { method, path: url.pathname, query: url.searchParams, body: () => parsedBody(cappedBodyGetter(req, method, BODY_MAX_BYTES)) })
  } catch (err) {
    // Body too large / malformed JSON are caller errors; anything else is ours and is logged without payload.
    const callerError = err instanceof SyntaxError || (err instanceof Error && err.name === 'BodyReadError')
    if (!callerError) log.error('ca2.route_failed', 'central panel route failed', { path: url.pathname, error: err instanceof Error ? err.message : String(err) })
    result = { status: callerError ? 400 : 500, body: { error: callerError ? 'invalid_body' : 'internal_error' } }
  }
  if (!result) return false
  res.statusCode = result.status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(result.body))
  return true
}
