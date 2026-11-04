// Plan node (F4-f, Jules-style plan approval): an intent typed in ⌘K becomes a DAG draft drawn here as
// waves of tasks with gates and a cost estimate. Nothing runs and no code changes until "Approve and
// run" (a human-only `POST /api/dag`); after that the node shows live task status and the canvas gains
// one worker node per dispatched task, cabled along the DAG edges (PlanNode.model `workerWiring`).
import { memo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { Button as VscodeButton, ToolbarButton, ToolbarContainer } from '@/vscode/register'
import type { PlanTaskData } from '../shared/workspace'
import { approvePlan, previewPlan } from './PlanNode.api'
import { PlanGraph } from './PlanNode.graph'
import { usePlanNode } from './PlanNode.hooks'
import { estimateText, removeTask, type TaskStatus } from './PlanNode.model'
import './PlanNode.css'

export const PLAN_TEXT = {
  drafting: 'Drafting a plan… Claude reads the repo only; nothing is changed.',
  approve: 'Approve and run',
  approveHint: 'Creates the DAG and starts workers. Nothing has run before this.',
  redraft: 'Draft again',
  edit: 'Edit JSON',
  apply: 'Apply edits',
  noDraft: 'No draft yet.',
  noWorkspace: 'Open a workspace with a folder to plan in.',
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function PlanNode({ id, data, selected }: NodeProps) {
  const rf = useReactFlow()
  const d = data as { plan?: unknown; color?: string }
  const swatch = d.color ?? '#a970ff'
  const { plan, patch, preview, previewError, view, viewError } = usePlanNode(id, d.plan)
  const [editing, setEditing] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const draft = plan.draft

  const setTasks = (tasks: PlanTaskData[]) => draft && patch({ draft: { ...draft, tasks } })
  const onApply = async () => {
    if (!draft || editing === null) return
    let tasks: unknown
    try { tasks = JSON.parse(editing) } catch (e) { setMsg(`Edits are not valid JSON: ${errText(e)}`); return }
    try {
      const checked = await previewPlan({ title: draft.title, tasks: tasks as PlanTaskData[] })
      patch({ draft: checked.draft })
      setEditing(null)
      setMsg('')
    } catch (e) { setMsg(errText(e)) }
  }
  const onApprove = async () => {
    if (!draft || !plan.projectId || !plan.repo) return
    setBusy(true)
    try {
      const r = await approvePlan({ projectId: plan.projectId, repo: plan.repo, title: draft.title, tasks: draft.tasks })
      patch({ dagId: r.dag.id })
      setMsg('')
    } catch (e) { setMsg(errText(e)) } finally { setBusy(false) }
  }
  const redraft = () => { setEditing(null); setMsg(''); patch({ draft: undefined, error: undefined, planId: undefined }) }

  const status: Record<string, TaskStatus> | undefined = view ? Object.fromEntries(view.tasks.map((t) => [t.key, t.status])) : undefined
  const tasks: PlanTaskData[] = view ? view.tasks.map((t) => ({ key: t.key, kind: t.kind, deps: t.deps, brief: t.brief })) : draft?.tasks ?? []
  const waves = view?.waves ?? preview?.waves ?? []
  const gates = tasks.filter((t) => t.kind === 'gate').length
  const pendingGates = view?.gates.filter((g) => g.status === 'pending').length ?? 0
  const title = view?.dag.title ?? draft?.title ?? 'Plan'

  const body = () => {
    if (!plan.workspaceId && !plan.dagId) return <p className="plan-node__notice">{PLAN_TEXT.noWorkspace}</p>
    if (plan.error) return <p className="plan-node__notice plan-node__notice--error" role="alert">{plan.error}</p>
    if (!draft && !view) return <p className="plan-node__notice" role="status">{plan.planId ? PLAN_TEXT.drafting : PLAN_TEXT.noDraft}</p>
    if (editing !== null) return <textarea className="plan-node__json" aria-label="Plan tasks as JSON" value={editing} onChange={(e) => setEditing(e.target.value)} />
    return <PlanGraph tasks={tasks} waves={waves} status={status} onRemove={view ? undefined : (k) => setTasks(removeTask(tasks, k))} />
  }

  return (
    <>
      <NodeResizer isVisible={!!selected} minWidth={420} minHeight={240} color={swatch} />
      <div className={`term-node plan-node${selected ? ' term-node--selected' : ''}`} style={{ '--node-swatch': swatch } as CSSProperties}>
        <div className="node-header">
          <span className="node-title plan-node__title" title={plan.intent}>
            <span className="codicon codicon-type-hierarchy" aria-hidden="true" />
            {title}
            <span className="plan-node__desc">{view ? view.dag.status : draft ? 'draft, not running' : ''}</span>
          </span>
          <span className="plan-node__spacer" />
          <ToolbarContainer className="nodrag plan-node__actions">
            {draft && !view && editing === null && <VscodeButton secondary onClick={() => setEditing(JSON.stringify(draft.tasks, null, 2))}>{PLAN_TEXT.edit}</VscodeButton>}
            {editing !== null && <VscodeButton secondary onClick={() => void onApply()}>{PLAN_TEXT.apply}</VscodeButton>}
            {!plan.dagId && (draft || plan.error) && <VscodeButton secondary onClick={redraft}>{PLAN_TEXT.redraft}</VscodeButton>}
            {draft && !plan.dagId && (
              <VscodeButton title={PLAN_TEXT.approveHint} disabled={busy || editing !== null || !preview || !plan.projectId} onClick={() => void onApprove()}>{PLAN_TEXT.approve}</VscodeButton>
            )}
            <ToolbarButton label="Close" title="Close" onClick={() => void rf.deleteElements({ nodes: [{ id }] })}><span className="codicon codicon-close" aria-hidden="true" /></ToolbarButton>
          </ToolbarContainer>
        </div>
        <div className="plan-node__summary nodrag">
          <span className="plan-node__intent">{plan.intent}</span>
          {tasks.length > 0 && <span>{tasks.length} task{tasks.length === 1 ? '' : 's'} · {waves.length} wave{waves.length === 1 ? '' : 's'} · {gates} gate{gates === 1 ? '' : 's'}</span>}
          {(view?.estimate ?? preview?.estimate) && <span>{estimateText(view?.estimate ?? preview?.estimate)}</span>}
          {pendingGates > 0 && <span className="plan-node__wait">{pendingGates} decision{pendingGates === 1 ? '' : 's'} waiting in Inbox</span>}
        </div>
        {(msg || previewError || viewError) && <div className="plan-node__msg nodrag" role="status">{msg || previewError || viewError}</div>}
        <div className="node-body plan-node__body nodrag nowheel nokey">{body()}</div>
        <Handle id="link-out" type="source" position={Position.Right} className="bridge-handle" />
        <Handle id="link-in" type="target" position={Position.Left} className="bridge-handle" />
      </div>
    </>
  )
}

export default memo(PlanNode)
