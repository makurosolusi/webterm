// The Central task board: `/api/central/tasks*` and `/api/central/work-settings`. Not a node-token path
// (auth.ts `isNodeTokenPath`), so the outer gate admits only the page and the root token; these routes
// run with spawned agents on or off. Lock: routes/route.uiOnly.policy.bun.test.ts.
import { BOARD_COLUMNS, type BoardColumn, type TaskActionResult, type TaskDetail, type TaskPage, type TaskView, type WorkSettings, type WorkStatus } from '../../shared/centralWork'
import { projectParam } from '../apiShared.params'
import type { RouteResult } from '../apiShared.types'
import type { Ca2Handle } from './ca2Boot'
import { HUMAN_PREFIX } from './ca2Routes.act'
import { pageOf } from './ca2Routes.read'
import { cleanAssignment, cleanEvent, taskCards } from './work/workBoard'
import { finishTask } from './work/workLifecycle'
import { WorkError, type WorkActor, type WorkStore } from './work/workModel'
import { readAutoDone, writeAutoDone } from './work/workSettings'
import { createWorkStore } from './work/workStore'
import { reopenAutoDone } from './work/workReopen'
import { recordAutoDoneSet } from './work/workAutoDoneOffer'

const TASKS = '/api/central/tasks'
const SETTINGS = '/api/central/work-settings'
const TASK = /^\/api\/central\/tasks\/([^/]+)$/
const TASK_ACTION = /^\/api\/central\/tasks\/([^/]+)\/(approve|changes|cancel|retry|reopen)$/
const NOTE_MAX = 2000
type Action = 'approve' | 'changes' | 'cancel' | 'retry' | 'reopen'
/** The state machine has more edges into `todo` than these buttons mean. */
const ONLY_FROM: Partial<Record<Action, WorkStatus>> = { approve: 'needs_review', changes: 'needs_review', retry: 'failed' }

type Body = Record<string, unknown>
const fail = (status: number, error: string): RouteResult => ({ status, body: { error } })
const ok = <T>(body: T): RouteResult => ({ status: 200, body })
const notAllowed = fail(405, 'method_not_allowed')
const bodyOf = (raw: unknown): Body => (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Body) : {})
const decode = (s: string): string | null => { try { return decodeURIComponent(s) } catch { return null } }
const validNote = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= NOTE_MAX

/** Whether `path` is one of the task board routes. */
export const isWorkPath = (path: string): boolean => path === TASKS || path === SETTINGS || TASK.test(path) || TASK_ACTION.test(path)

const card = (h: Ca2Handle, task: TaskView) => taskCards(h.db, [task])[0]

function listView(h: Ca2Handle, store: WorkStore, q: URLSearchParams): RouteResult {
  const page = pageOf(q)
  if (!page) return fail(400, 'invalid_page')
  const column = q.get('column')
  if (column !== null && !Object.hasOwn(BOARD_COLUMNS, column)) return fail(400, 'invalid_column')
  const projectId = q.get('projectId')?.trim()
  const filter = { ...(column ? { statuses: BOARD_COLUMNS[column as BoardColumn] } : {}), ...(projectId ? { projectId } : {}) }
  const hasMore = store.listTasks({ ...filter, limit: 1, offset: page.offset + page.limit }).length > 0
  return ok<TaskPage>({ items: taskCards(h.db, store.listTasks({ ...filter, ...page })), hasMore })
}

function detailView(h: Ca2Handle, store: WorkStore, id: string, q: URLSearchParams): RouteResult {
  const page = pageOf(q)
  if (!page) return fail(400, 'invalid_page')
  const task = store.getTask(id)
  if (!task) return fail(404, 'task_not_found')
  return ok<TaskDetail>({
    task: card(h, task), assignments: store.assignmentsOfTask(id).map(cleanAssignment), timeline: store.timeline(id, page).map(cleanEvent),
    hasMoreTimeline: store.timeline(id, { limit: 1, offset: page.offset + page.limit }).length > 0,
  })
}

function applyAction(store: WorkStore, id: string, action: Action, body: Body, actor: WorkActor): TaskView {
  if (action === 'approve') return finishTask(store, id, 'done', { actor })
  if (action === 'changes') return finishTask(store, id, 'todo', { actor, reason: String(body.note).trim(), endReason: 'changes_requested' })
  if (action === 'retry') return finishTask(store, id, 'todo', { actor, endReason: 'retried' })
  return finishTask(store, id, 'cancelled', { actor, endReason: 'cancelled', ...(typeof body.reason === 'string' ? { reason: body.reason.trim() } : {}) })
}

function actionRoute(h: Ca2Handle, store: WorkStore, id: string, action: Action, body: Body, actor: WorkActor): RouteResult {
  if (action === 'changes' && !validNote(body.note)) return fail(400, 'invalid_note')
  if (action === 'cancel' && body.reason !== undefined && !(typeof body.reason === 'string' && body.reason.length <= NOTE_MAX)) return fail(400, 'invalid_reason')
  const task = store.getTask(id)
  if (!task) return fail(404, 'task_not_found')
  const from = ONLY_FROM[action]
  if (from && task.status !== from) return fail(409, 'illegal_transition')
  try {
    return ok<TaskActionResult>({ task: card(h, applyAction(store, id, action, body, actor)) })
  } catch (err) {
    if (err instanceof WorkError) return fail(err.code === 'task_not_found' ? 404 : 409, err.code)
    throw err
  }
}

function readSettings(h: Ca2Handle, q: URLSearchParams): RouteResult {
  const projectId = projectParam(q)
  if (projectId === null) return fail(400, 'invalid_project')
  const autoDone = readAutoDone(h.db, projectId)
  return autoDone === null ? fail(404, 'project_not_found') : ok<WorkSettings>({ autoDone })
}

function writeSettings(h: Ca2Handle, { projectId, autoDone }: Body, actor: string): RouteResult {
  if (typeof projectId !== 'string' || projectId === '') return fail(400, 'invalid_project')
  if (typeof autoDone !== 'boolean') return fail(400, 'invalid_auto_done')
  if (!writeAutoDone(h.db, projectId, autoDone, h.now())) return fail(404, 'project_not_found')
  recordAutoDoneSet(h.db, projectId, autoDone, actor, h.now())
  return ok({ projectId, autoDone })
}

function reopenRoute(h: Ca2Handle, store: WorkStore, id: string, actor: WorkActor): RouteResult {
  const result = reopenAutoDone(h.db, store, id, actor, h.now())
  return result.ok ? ok<TaskActionResult>({ task: card(h, result.task) }) : { status: result.status, body: { error: result.error, message: result.message } }
}

/** Answers a path `isWorkPath` accepted. Writes and the auto-done switch need a `human:*` actor. */
export async function workDispatch(
  h: Ca2Handle, req: { method: string; path: string; query: URLSearchParams; body: () => Promise<unknown> }, actor: string,
): Promise<RouteResult> {
  const { method, path, query } = req
  if ((method === 'POST' || path === SETTINGS) && !actor.startsWith(HUMAN_PREFIX)) return fail(403, 'human_only')
  if (path === SETTINGS) {
    if (method === 'GET') return readSettings(h, query)
    return method === 'POST' ? writeSettings(h, bodyOf(await req.body()), actor) : notAllowed
  }
  const store = createWorkStore(h.db, h.now)
  if (path === TASKS) return method === 'GET' ? listView(h, store, query) : notAllowed
  const action = TASK_ACTION.exec(path)
  const id = decode((action ?? TASK.exec(path))?.[1] ?? '')
  if (id === null) return fail(400, 'invalid_id')
  if (!action) return method === 'GET' ? detailView(h, store, id, query) : notAllowed
  if (method !== 'POST') return notAllowed
  const human: WorkActor = { kind: 'human', id: actor.slice(HUMAN_PREFIX.length) }
  if (action[2] === 'reopen') return reopenRoute(h, store, id, human)
  return actionRoute(h, store, id, action[2] as Action, bodyOf(await req.body()), human)
}
