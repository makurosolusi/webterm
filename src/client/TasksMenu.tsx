// Task runner (VS Code "Run Task" quick pick over NPM scripts; Orca orca.yaml scripts): a status
// bar item lists the workspace's package.json scripts and webterm.yaml / orca.yaml tasks; picking
// one opens a new terminal node and the server types the task's line into it (src/server/tasks/).
import { useCallback, useMemo, useState } from 'react'
import type { XYPosition } from '@xyflow/react'
import type { VscodeStatusItem } from '@/components/vscode/vscodeStatusBar'
import { VscodeQuickPick, type VscodeQuickPickItem } from '@/components/vscode/vscodeQuickPick'
import type { WorkspaceTask } from '../server/tasks/tasks.list'
import type { Workspace, WsNode } from '../shared/workspace'
import { tokenQuery } from './api'
import { codicon } from './dockCodicon'
import { randomId } from './randomId'

const withToken = (path: string): string => [path, tokenQuery()].filter(Boolean).join(path.includes('?') ? '&' : '?')

export async function fetchTasks(workspaceId: string, fetchFn: typeof fetch = fetch): Promise<WorkspaceTask[]> {
  const res = await fetchFn(withToken(`/api/tasks?workspace=${encodeURIComponent(workspaceId)}`))
  if (!res.ok) throw new Error(`Load tasks: HTTP ${res.status}`)
  return ((await res.json()) as { tasks: WorkspaceTask[] }).tasks
}

export async function runTask(workspaceId: string, taskId: string, nodeId: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(withToken('/api/tasks/run'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: workspaceId, task: taskId, node: nodeId }),
  })
  if (!res.ok) {
    const out = (await res.json().catch(() => ({}))) as { message?: string }
    throw new Error(`Run task ${taskId}: ${out.message ?? `HTTP ${res.status}`}`)
  }
}

export const taskPickItems = (tasks: WorkspaceTask[]): VscodeQuickPickItem[] =>
  tasks.map((t) => ({ id: t.id, label: t.name, description: t.source, detail: t.detail.split('\n')[0], group: t.source }))

type AddFlowNode = (make: (n: number, ws: Workspace) => Omit<WsNode, 'x' | 'y'>, at?: XYPosition) => void

/** Status bar item + quick pick for the active workspace's tasks. */
export function useTasksMenu(workspaceId: string | null, addFlowNode: AddFlowNode) {
  const [tasks, setTasks] = useState<WorkspaceTask[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const openMenu = useCallback(() => {
    if (!workspaceId) return
    setError(null)
    fetchTasks(workspaceId).then(setTasks, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [workspaceId])
  const pick = useCallback((id: string) => {
    const task = tasks?.find((t) => t.id === id)
    setTasks(null)
    if (!task || !workspaceId) return
    const nodeId = randomId()
    addFlowNode((_, ws) => ({ id: nodeId, kind: 'terminal', cwd: ws.cwd, title: task.name }))
    runTask(workspaceId, task.id, nodeId).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [tasks, workspaceId, addFlowNode])

  const statusItems = useMemo<VscodeStatusItem[]>(() => (workspaceId ? [{
    id: 'tasks', label: error ? 'Task failed' : 'Tasks', icon: codicon('run-all'), tone: error ? 'error' : 'default',
    tooltip: error ?? 'Run a task (package.json scripts, webterm.yaml / orca.yaml)', ariaLabel: 'Run a task', onClick: openMenu,
  }] : []), [workspaceId, error, openMenu])

  const menu = tasks && (
    <VscodeQuickPick open onClose={() => setTasks(null)} ariaLabel="Run Task" placeholder="Select a task to run"
      items={taskPickItems(tasks)} onSelect={pick} emptyText="No tasks found in package.json, webterm.yaml or orca.yaml" />
  )
  return { statusItems, menu }
}
