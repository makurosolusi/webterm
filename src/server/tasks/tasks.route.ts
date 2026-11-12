// HTTP binding of workspace tasks, same `{status, body} | null` contract as workspaceWorktree.route.ts.
//
//   GET  /api/tasks?workspace=<id>                 {tasks: WorkspaceTask[]}
//   POST /api/tasks/run {workspace, task, node}    type the task's line into terminal node `node`
//
// The client creates the terminal node first; the server types the line once that PTY is live
// (VS Code `terminal.sendText` after creating the task terminal). The line is looked up by task id
// from the workspace's own files, never taken from the request. POST is human-UI only.
import type { IncomingMessage } from 'node:http'
import { isSafeNodeId, type Workspace } from '../../shared/workspace'
import { submitToNode } from '../agentSubmit'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import type { AppendEventInput } from '../events/eventModel'
import { isValidNodeToken } from '../hooksTokens'
import { listTasks, nodeTaskFs, type TaskFs } from './tasks.list'

export const TASKS_PATH = '/api/tasks'
export const TASK_START_WAIT_MS = 10_000
const POLL_MS = 100

type Result = { status: number; body: unknown } | null
const bad = (message: string): Result => ({ status: 400, body: { error: 'bad_request', message } })

export interface TasksRouteDeps {
  workspace(id: string): Promise<Workspace | null>
  sessions(): Promise<{ isLive(id: string): boolean; input(id: string, data: string): void }>
  record(input: AppendEventInput): void
  fs?: TaskFs
  isNodeToken?: (token: string) => boolean
  sleep?: (ms: number) => Promise<void>
  waitMs?: number
}

const defaults: TasksRouteDeps = {
  workspace: async (id) => (await import('../db')).db.get(id),
  sessions: async () => (await import('../sessions')).sessions,
  record: (input) => void import('../events/producers').then((m) => m.recordEvent(input)),
}

export async function tasksRoute(req: IncomingMessage, url: URL, body: () => Promise<string>, deps: TasksRouteDeps = defaults): Promise<Result> {
  const path = url.pathname
  if (path !== TASKS_PATH && path !== `${TASKS_PATH}/run`) return null
  const method = req.method ?? 'GET'
  const fs = deps.fs ?? nodeTaskFs
  if (path === TASKS_PATH) {
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
    const ws = await deps.workspace(url.searchParams.get('workspace') ?? '')
    return { status: 200, body: { tasks: ws?.cwd ? await listTasks(ws.cwd, fs) : [] } }
  }
  if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  const denial = uiOnlyDenial(req, url, deps.isNodeToken ?? isValidNodeToken)
  if (denial) return { status: 403, body: { error: denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_run_tasks' : denial, message: 'Tasks are started from the webterm UI only.' } }
  let b: { workspace?: unknown; task?: unknown; node?: unknown }
  try { b = JSON.parse(await body()) } catch { return bad('bad json') }
  if (!b || typeof b.workspace !== 'string' || typeof b.task !== 'string') return bad('workspace and task are required')
  if (!isSafeNodeId(b.node)) return bad('node must be a node id')
  const ws = await deps.workspace(b.workspace)
  if (!ws?.cwd) return { status: 404, body: { error: 'not_found', message: 'Workspace not found or has no folder.' } }
  const task = (await listTasks(ws.cwd, fs)).find((t) => t.id === b.task)
  if (!task) return { status: 404, body: { error: 'unknown_task', message: `No task ${b.task} in this workspace.` } }
  const sessions = await deps.sessions()
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  for (let waited = 0; !sessions.isLive(b.node); waited += POLL_MS) {
    if (waited >= (deps.waitMs ?? TASK_START_WAIT_MS)) return { status: 504, body: { error: 'terminal_not_ready', message: 'The task terminal did not start in time.' } }
    await sleep(POLL_MS)
  }
  // A task terminal is a plain shell the client just created: the helper's one-write shell branch runs the line.
  const shell = { input: (id: string, d: string) => sessions.input(id, d), statusOf: () => undefined, screenSource: () => undefined, agentIdOf: () => undefined }
  await submitToNode(shell, b.node, task.run)
  deps.record({
    kind: 'task.run', source: 'tasks', actor: 'human-ui', subject: `node:${b.node}`, nodeId: b.node, workspaceId: ws.id,
    trust: 'trusted', payload: { task: task.name, source: task.source },
  })
  return { status: 202, body: { task } }
}
