// Project goals on the Central board: `/api/central/goals*`. Like the task board, not a node-token path; the
// lifecycle writes speak for the human. Lock: routes/route.uiOnly.policy.bun.test.ts.
import type { GoalPage } from '../../shared/centralWork'
import type { RouteResult } from '../apiShared.types'
import type { Ca2Handle } from './ca2Boot'
import { HUMAN_PREFIX } from './ca2Routes.act'
import { pageOf } from './ca2Routes.read'
import { GoalError, type GoalErrorCode } from './goalModel'
import { abandonGoal, activateGoal, goalCards } from './goalStore'

const GOALS = '/api/central/goals'
const GOAL_ACTION = /^\/api\/central\/goals\/([^/]+)\/(activate|abandon)$/
const ABANDONED_FROM_BOARD = 'Abandoned from the board'
const ERROR_STATUS: Partial<Record<GoalErrorCode, number>> = { stale_version: 409, illegal_transition: 409, goal_active: 409, project_not_found: 404, forbidden: 403, corrupt_goal: 500 }

type Body = Record<string, unknown>
const fail = (status: number, error: string): RouteResult => ({ status, body: { error } })
const notAllowed = fail(405, 'method_not_allowed')
const bodyOf = (raw: unknown): Body => (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Body) : {})
const decode = (s: string): string | null => { try { return decodeURIComponent(s) } catch { return null } }

/** Whether `path` is one of the goal routes. */
export const isGoalsPath = (path: string): boolean => path === GOALS || GOAL_ACTION.test(path)

function listView(h: Ca2Handle, q: URLSearchParams): RouteResult {
  const page = pageOf(q)
  if (!page) return fail(400, 'invalid_page')
  const projectId = q.get('projectId')?.trim()
  return { status: 200, body: goalCards(h.db, { ...page, ...(projectId ? { projectId } : {}) }) satisfies GoalPage }
}

function actionRoute(h: Ca2Handle, projectId: string, verb: string, body: Body, actor: string): RouteResult {
  const input = { projectId, expectedVersion: body.version as number, actor: { id: actor, kind: 'human' }, now: h.now() }
  try {
    if (verb === 'activate') activateGoal(h.db, input)
    else abandonGoal(h.db, { ...input, reason: (body.reason ?? ABANDONED_FROM_BOARD) as string })
  } catch (err) {
    if (err instanceof GoalError) return fail(ERROR_STATUS[err.code] ?? 400, err.code)
    throw new Error(`${verb} goal of project ${projectId}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  const [goal] = goalCards(h.db, { projectId, limit: 1, offset: 0 }).items
  return goal ? { status: 200, body: { goal } } : fail(500, 'corrupt_goal')
}

/** Answers a path `isGoalsPath` accepted. Writes need a `human:*` actor. */
export async function goalsDispatch(
  h: Ca2Handle, req: { method: string; path: string; query: URLSearchParams; body: () => Promise<unknown> }, actor: string,
): Promise<RouteResult> {
  const { method, path, query } = req
  if (method === 'POST' && !actor.startsWith(HUMAN_PREFIX)) return fail(403, 'human_only')
  if (path === GOALS) return method === 'GET' ? listView(h, query) : notAllowed
  if (method !== 'POST') return notAllowed
  const match = GOAL_ACTION.exec(path)
  const projectId = decode(match?.[1] ?? '')
  if (projectId === null) return fail(400, 'invalid_id')
  return actionRoute(h, projectId, match?.[2] as string, bodyOf(await req.body()), actor)
}
