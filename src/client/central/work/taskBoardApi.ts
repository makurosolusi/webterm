import type { FindingView } from '../../../shared/centralHealth'
import type { BoardColumn, GoalPage, ReminderPage, TaskDetail as TaskDetailPage } from '../../../shared/centralWork'
import { request } from '../../inboxTransport'
import { InboxApiError } from '../../inboxTypes'
import { CENTRAL_API, CENTRAL_PAGE_SIZE, centralControlApi } from '../centralControlApi'
import type { ColumnState, TaskAction } from './taskBoardModel'

const TASKS_PATH = `${CENTRAL_API}/tasks`
const WORK_SETTINGS_PATH = `${CENTRAL_API}/work-settings`
const GOALS_PATH = `${CENTRAL_API}/goals`
const REMINDERS_PATH = `${CENTRAL_API}/reminders`
const FINDINGS_PATH = `${CENTRAL_API}/health/findings`
/** Review checks shown on a task: open and dismissed, never the fixed ones. */
const TASK_FINDING_STATUSES = 'open,dismissed'
const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** A page request. */
export interface PageRange { limit: number; offset: number }

/** What the board needs from the server. */
export interface TaskBoardClient {
  listColumn(column: BoardColumn, projectId: string | undefined, range: PageRange, signal?: AbortSignal): Promise<ColumnState>
  getTask(id: string, range: PageRange, signal?: AbortSignal): Promise<TaskDetailPage>
  act(id: string, action: TaskAction, body?: Record<string, string>): Promise<void>
  getAutoDone(projectId: string, signal?: AbortSignal): Promise<boolean>
  setAutoDone(projectId: string, autoDone: boolean): Promise<void>
  listProjects(signal?: AbortSignal): Promise<Array<{ id: string; name: string }>>
  listGoals(projectId: string | undefined, range: PageRange, signal?: AbortSignal): Promise<GoalPage>
  activateGoal(projectId: string, version: number): Promise<void>
  abandonGoal(projectId: string, version: number): Promise<void>
  listReminders(range: PageRange, signal?: AbortSignal): Promise<ReminderPage>
  cancelReminder(id: string): Promise<void>
  /** First page of the review-check findings recorded for a task. */
  listTaskFindings(taskId: string, signal?: AbortSignal): Promise<{ items: FindingView[]; hasMore: boolean }>
}

const malformed = (what: string): InboxApiError => new InboxApiError(`${what} response malformed`, 502, 'bad_response')
const post = (path: string, body: unknown): Promise<unknown> => request(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) })
const query = (params: Record<string, string | number | undefined>): string =>
  new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]]))).toString()
const listPage = async <T>(what: string, path: string, signal?: AbortSignal): Promise<{ items: T[]; hasMore: boolean }> => {
  const body = await request<{ items?: T[]; hasMore?: unknown }>(path, { signal })
  if (!Array.isArray(body?.items)) throw malformed(what)
  return { items: body.items, hasMore: body.hasMore === true }
}

/** Default client over the live server. */
export const taskBoardApi: TaskBoardClient = {
  async listColumn(column, projectId, { limit, offset }, signal) {
    const body = await request<Partial<ColumnState>>(`${TASKS_PATH}?${query({ column, projectId, limit, offset })}`, { signal })
    if (!Array.isArray(body?.items)) throw malformed('Task list')
    return { items: body.items, hasMore: body.hasMore === true }
  },
  async getTask(id, { limit, offset }, signal) {
    const body = await request<Partial<TaskDetailPage>>(`${TASKS_PATH}/${encodeURIComponent(id)}?${query({ limit, offset })}`, { signal })
    if (!body?.task || !Array.isArray(body.assignments) || !Array.isArray(body.timeline)) throw malformed('Task detail')
    return { task: body.task, assignments: body.assignments, timeline: body.timeline, hasMoreTimeline: body.hasMoreTimeline === true }
  },
  async act(id, action, body = {}) {
    const reply = await post(`${TASKS_PATH}/${encodeURIComponent(id)}/${action}`, body) as { error?: unknown } | undefined
    if (typeof reply?.error === 'string') throw new InboxApiError(`Task ${action} on ${id} refused`, 409, reply.error)
  },
  async getAutoDone(projectId, signal) {
    const body = await request<{ autoDone?: unknown }>(`${WORK_SETTINGS_PATH}?${query({ projectId })}`, { signal })
    return body?.autoDone === true
  },
  async setAutoDone(projectId, autoDone) {
    await post(WORK_SETTINGS_PATH, { projectId, autoDone })
  },
  async listProjects(signal) {
    return (await centralControlApi.listBoardNodes(0, undefined, signal)).projects
  },
  listGoals: (projectId, { limit, offset }, signal) => listPage('Goal list', `${GOALS_PATH}?${query({ projectId, limit, offset })}`, signal),
  async activateGoal(projectId, version) {
    await post(`${GOALS_PATH}/${encodeURIComponent(projectId)}/activate`, { version })
  },
  async abandonGoal(projectId, version) {
    await post(`${GOALS_PATH}/${encodeURIComponent(projectId)}/abandon`, { version })
  },
  listReminders: ({ limit, offset }, signal) => listPage('Reminder list', `${REMINDERS_PATH}?${query({ limit, offset })}`, signal),
  async cancelReminder(id) {
    await post(`${REMINDERS_PATH}/${encodeURIComponent(id)}/cancel`, {})
  },
  listTaskFindings: (taskId, signal) =>
    listPage('Review checks', `${FINDINGS_PATH}?${query({ taskId, status: TASK_FINDING_STATUSES, limit: CENTRAL_PAGE_SIZE, offset: 0 })}`, signal),
}
