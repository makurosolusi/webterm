// Plan node lifecycle (F4-f): draft on mount -> poll the draft -> preview (waves + estimate) while it is
// edited -> after approval, mirror `/api/dag/:id` and wire worker nodes as they are dispatched.
// The node's `data.plan` is the persisted state; everything else here is derived and refetched.
import { useCallback, useEffect, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { validPlanData, type PlanNodeData } from '../shared/workspace'
import { fetchDag, fetchPlan, previewPlan, startPlan } from './PlanNode.api'
import { workerWiring, type DagView, type Estimate } from './PlanNode.model'

export const PLAN_POLL_MS = 1500
export const DAG_POLL_MS = 2000
const LOST = 'The draft was lost (the server restarted). Draft again.'
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Node ids whose draft request is in flight: StrictMode/remounts must not start a second (paid) planner run. */
const starting = new Set<string>()

export function usePlanNode(id: string, raw: unknown) {
  const rf = useReactFlow()
  const plan = validPlanData(raw) ?? { intent: '' }
  const patch = useCallback((p: Partial<PlanNodeData>) => {
    rf.updateNodeData(id, (n) => ({ plan: { ...(validPlanData((n.data as { plan?: unknown }).plan) ?? { intent: '' }), ...p } }))
  }, [rf, id])
  const { intent, workspaceId, planId, draft, dagId, error } = plan

  // 1. Draft once: no draft, no job, no dag, no error.
  useEffect(() => {
    if (!intent || !workspaceId || draft || planId || dagId || error || starting.has(id)) return
    starting.add(id)
    startPlan(intent, workspaceId)
      .then((r) => patch({ planId: r.planId }))
      .catch((e: unknown) => patch({ error: errText(e) }))
      .finally(() => starting.delete(id))
  }, [id, intent, workspaceId, draft, planId, dagId, error, patch])

  // 2. Poll the job until it is ready or failed.
  useEffect(() => {
    if (!planId) return
    const t = setInterval(() => {
      fetchPlan(planId).then((job) => {
        if (job.status === 'ready') patch({ planId: undefined, draft: job.draft, projectId: job.projectId, repo: job.repo })
        else if (job.status === 'failed') patch({ planId: undefined, error: job.error })
      }).catch(() => patch({ planId: undefined, error: LOST }))
    }, PLAN_POLL_MS)
    return () => clearInterval(t)
  }, [planId, patch])

  // 3. Waves + estimate of the draft as it stands (server-validated, no planner run).
  const [preview, setPreview] = useState<{ waves: string[][]; estimate: Estimate } | null>(null)
  const [previewError, setPreviewError] = useState('')
  useEffect(() => {
    if (!draft || dagId) return
    let live = true
    previewPlan(draft).then((p) => { if (live) { setPreview(p); setPreviewError('') } }).catch((e: unknown) => { if (live) { setPreview(null); setPreviewError(errText(e)) } })
    return () => { live = false }
  }, [draft, dagId])

  // 4. Approved: mirror the dag and wire each dispatched worker to the plan.
  const [view, setView] = useState<DagView | null>(null)
  const [viewError, setViewError] = useState('')
  useEffect(() => {
    if (!dagId) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      fetchDag(dagId).then((v) => {
        if (!live) return
        setView(v)
        setViewError('')
        const self = rf.getNode(id)
        const cur = validPlanData((self?.data as { plan?: unknown } | undefined)?.plan)
        if (self) {
          const w = workerWiring(self, v, rf.getNodes(), rf.getEdges(), cur?.wired ?? [])
          if (w.nodes.length) rf.addNodes(w.nodes)
          if (w.edges.length) rf.addEdges(w.edges)
          if (w.wired.some((d) => !(cur?.wired ?? []).includes(d))) patch({ wired: [...new Set([...(cur?.wired ?? []), ...w.wired])] })
        }
        if (v.dag.status === 'active') timer = setTimeout(load, DAG_POLL_MS)
      }).catch((e: unknown) => { if (live) { setViewError(errText(e)); timer = setTimeout(load, DAG_POLL_MS * 5) } })
    }
    load()
    return () => { live = false; clearTimeout(timer) }
  }, [dagId, id, rf, patch])

  return { plan, patch, preview, previewError, view, viewError }
}
