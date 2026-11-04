// Plan node model (F4-f), pure: draft edits, cost text and which worker nodes/cables the canvas gains
// as the approved DAG dispatches. The canvas is the map of the DAG: one Diff node per dispatched task
// (on that worker's worktree), cabled from the tasks it depends on, or from the Plan node itself.
import type { Edge, Node } from '@xyflow/react'
import type { PlanTaskData } from '../shared/workspace'
import { bridgeExists } from './floatingEdge'
import { toFlowEdge } from './store'

export const PLAN_SIZE = { width: 640, height: 460 }
export const WORKER_SIZE = { width: 520, height: 340 }
const GAP = 48

export type TaskStatus = 'pending' | 'running' | 'blocked' | 'done' | 'failed'
export interface Estimate { medianMicros: number | null; samples: number; basis: 'ref' | 'kind' | 'none'; tasks: number; totalMicros: number | null }
export interface DagTaskView { id: string; key: string; kind: 'work' | 'gate'; deps: string[]; status: TaskStatus; lastError: string | null; brief: Record<string, unknown> }
export interface DispatchView { id: string; taskId: string; nodeId: string; worktree: string | null; branch: string | null; status: string }
export interface DagView {
  dag: { id: string; title: string; status: 'active' | 'done' | 'failed' | 'cancelled' }
  tasks: DagTaskView[]
  gates: { id: string; taskId: string; question: string; status: string }[]
  dispatches: DispatchView[]
  waves: string[][]
  estimate: Estimate
}

/** Drops a task and every dependency on it (the rest of the plan stays valid). */
export function removeTask(tasks: readonly PlanTaskData[], key: string): PlanTaskData[] {
  return tasks.filter((t) => t.key !== key).map((t) => (t.deps.includes(key) ? { ...t, deps: t.deps.filter((d) => d !== key) } : t))
}

const usd = (micros: number): string => `$${(micros / 1e6).toFixed(2)}`

export function estimateText(e: Estimate | null | undefined): string {
  if (!e) return ''
  const runs = `${e.tasks} agent run${e.tasks === 1 ? '' : 's'}`
  if (e.totalMicros === null || e.medianMicros === null) return `Estimate: unknown, no cost history yet (${runs})`
  return `Estimate: ~${usd(e.totalMicros)} (${runs} × ${usd(e.medianMicros)}, median of ${e.samples} past run${e.samples === 1 ? '' : 's'})`
}

/** The newest dispatch of each task: a retry replaces the worker the canvas shows. */
function latestByTask(dispatches: readonly DispatchView[]): Map<string, DispatchView> {
  const out = new Map<string, DispatchView>()
  for (const d of dispatches) out.set(d.taskId, d)
  return out
}

/**
 * Worker nodes and cables still missing from the canvas. `skip` = dispatch ids already wired once (a
 * worker the user closed stays closed). Cables are the DAG edges: dep worker -> worker, or plan -> worker
 * when the dependency is a gate or not dispatched yet.
 */
export function workerWiring(plan: Pick<Node, 'id' | 'position'> & { width?: number }, view: DagView, nodes: readonly Pick<Node, 'id'>[], edges: readonly Edge[], skip: readonly string[]): { nodes: Node[]; edges: Edge[]; wired: string[] } {
  const live = new Set(nodes.map((n) => n.id))
  const byTask = latestByTask(view.dispatches)
  const keyToTask = new Map(view.tasks.map((t) => [t.key, t]))
  const waveOf = new Map(view.waves.flatMap((w, i) => w.map((k) => [k, i] as const)))
  const rowOf = new Map<number, number>()
  const add: Node[] = []
  const cables: Edge[] = [...edges]
  const fresh: Edge[] = []
  const wired: string[] = []
  const x0 = plan.position.x + (plan.width ?? PLAN_SIZE.width) + GAP
  for (const task of view.tasks) {
    const d = byTask.get(task.id)
    if (!d || !d.worktree || skip.includes(d.id)) continue
    wired.push(d.id)
    if (!live.has(d.nodeId)) {
      const wave = waveOf.get(task.key) ?? 0
      const row = rowOf.get(wave) ?? 0
      rowOf.set(wave, row + 1)
      add.push({
        id: d.nodeId, type: 'diff', ...WORKER_SIZE,
        position: { x: x0 + wave * (WORKER_SIZE.width + GAP), y: plan.position.y + row * (WORKER_SIZE.height + GAP) },
        data: { id: d.nodeId, kind: 'diff', cwd: d.worktree, title: `${view.dag.title}: ${task.key}` },
      })
      live.add(d.nodeId)
    }
    const sources = task.deps.length === 0 ? [plan.id] : task.deps.map((k) => {
      const dep = keyToTask.get(k)
      const dd = dep && dep.kind === 'work' ? byTask.get(dep.id) : undefined
      return dd && live.has(dd.nodeId) ? dd.nodeId : plan.id
    })
    for (const source of new Set(sources)) {
      if (bridgeExists(cables, source, d.nodeId)) continue
      const e = toFlowEdge({ id: `bridge-${source}-${d.nodeId}`, source, target: d.nodeId, kind: 'context' })
      cables.push(e)
      fresh.push(e)
    }
  }
  return { nodes: add, edges: fresh, wired }
}
