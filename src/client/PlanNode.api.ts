// Same-origin client of `/api/dag*` for the Plan node (src/server/dag/dag.api.ts, dag.plan.ts). Every
// failure throws one Error naming the operation and the server's reason.
import type { PlanTaskData } from '../shared/workspace'
import type { DagView, Estimate } from './PlanNode.model'

const DAG_PATH = '/api/dag'

async function call<T>(op: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit | undefined = body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  const res = await fetch(path, init)
  const out = (await res.json().catch(() => ({}))) as T & { detail?: string; error?: string }
  if (!res.ok) throw new Error(`${op}: ${out.detail ?? out.error ?? `HTTP ${res.status}`}`)
  return out
}

export interface PlanDraftData { title: string; tasks: PlanTaskData[] }
export type PlanJob =
  | { status: 'drafting' }
  | { status: 'ready'; draft: PlanDraftData; waves: string[][]; estimate: Estimate; projectId: string; repo: string }
  | { status: 'failed'; error: string }

export const startPlan = (intent: string, workspaceId: string): Promise<{ planId: string }> =>
  call('Draft plan', `${DAG_PATH}/plan`, { intent, workspaceId })

export const fetchPlan = (planId: string): Promise<PlanJob> => call('Load plan draft', `${DAG_PATH}/plan/${encodeURIComponent(planId)}`)

export const previewPlan = (draft: PlanDraftData): Promise<{ draft: PlanDraftData; waves: string[][]; estimate: Estimate }> =>
  call('Check plan', `${DAG_PATH}/plan/preview`, draft)

export const approvePlan = (input: { projectId: string; repo: string; title: string; tasks: PlanTaskData[] }): Promise<{ dag: { id: string } }> =>
  call('Approve plan', DAG_PATH, input)

export const fetchDag = (id: string): Promise<DagView> => call('Load DAG', `${DAG_PATH}/${encodeURIComponent(id)}`)
