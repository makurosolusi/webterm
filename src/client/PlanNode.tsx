// Plan node (F4-f, Jules-style plan approval): an intent typed in ⌘K becomes a DAG draft drawn here as
// waves of tasks with gates and a cost estimate. Nothing runs and no code changes until "Approve and
// run" (a human-only `POST /api/dag`); after that the node shows live task status and the canvas gains
// one worker node per dispatched task, cabled along the DAG edges (PlanNode.model `workerWiring`).
import { memo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { NodeLayoutResizer, NodeResizeToggle } from './nodeResize/NodeLayoutResizer'
import { Button as VscodeButton, ToolbarButton, ToolbarContainer } from '@/vscode/register'
import { ActionResult, errorCause, useAction } from '@/components/ui/action'
import type { PlanTaskData } from '../shared/workspace'
import { approvePlan, previewPlan } from './PlanNode.api'
import { PlanGraph } from './PlanNode.graph'
import { usePlanNode } from './PlanNode.hooks'
import { estimateText, removeTask, type TaskStatus } from './PlanNode.model'
import './PlanNode.css'
import { NodeNameLabel } from './nodeName.label'
import { useNodeHost } from './tabLayout.context'
import TabNodeActions, { type TabAction } from './tabLayout.nodeActions'

export const PLAN_TEXT = {
  drafting: 'Drafting a plan… Claude reads the repo only; nothing is changed.',
  approve: 'Approve and run',
  approveHint: 'Creates the DAG and starts workers. Nothing has run before this.',
  redraft: 'Draft again',
  edit: 'Edit JSON',
  apply: 'Apply edits',
  applying: 'Checking…',
  approving: 'Starting…',
  noDraft: 'No draft yet.',
  noWorkspace: 'Open a workspace with a folder to plan in.',
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function PlanNode({ id, data, selected }: NodeProps) {
  const rf = useReactFlow()
  const d = data as { plan?: unknown; color?: string; name?: string }
  const swatch = d.color ?? '#a970ff'
  const { plan, patch, preview, previewError, view, viewError } = usePlanNode(id, d.plan)
  const [editing, setEditing] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const edited = useRef<unknown>(null)
  const draft = plan.draft

  const setTasks = (tasks: PlanTaskData[]) => draft && patch({ draft: { ...draft, tasks } })
  const apply = useAction(async () => {
    if (!draft) return
    const checked = await previewPlan({ title: draft.title, tasks: edited.current as PlanTaskData[] })
    patch({ draft: checked.draft })
    setEditing(null)
    setMsg('')
  }, { label: PLAN_TEXT.apply, success: () => 'Edits applied', failure: errorCause })
  // Invalid JSON is caught before anything is sent: it shows as the node message.
  const onApply = (): void => {
    if (!draft || editing === null) return
    try { edited.current = JSON.parse(editing) } catch (e) { setMsg(`Edits are not valid JSON: ${errText(e)}`); return }
    void apply.run()
  }
  const approve = useAction(async () => {
    if (!draft || !plan.projectId || !plan.repo) return
    const r = await approvePlan({ projectId: plan.projectId, repo: plan.repo, title: draft.title, tasks: draft.tasks })
    patch({ dagId: r.dag.id })
    setMsg('')
  }, { label: PLAN_TEXT.approve, success: () => 'Plan started', failure: errorCause })
  const onApprove = (): void => { void approve.run() }
  const busy = apply.busy || approve.busy
  const redraft = () => { setEditing(null); setMsg(''); patch({ draft: undefined, error: undefined, planId: undefined }) }

  const status: Record<string, TaskStatus> | undefined = view ? Object.fromEntries(view.tasks.map((t) => [t.key, t.status])) : undefined
  const tasks: PlanTaskData[] = view ? view.tasks.map((t) => ({ key: t.key, kind: t.kind, deps: t.deps, brief: t.brief })) : draft?.tasks ?? []
  const waves = view?.waves ?? preview?.waves ?? []
  const gates = tasks.filter((t) => t.kind === 'gate').length
  const pendingGates = view?.gates.filter((g) => g.status === 'pending').length ?? 0
  const title = view?.dag.title ?? draft?.title ?? 'Plan'
  // Tab mode: the tab is the header, so the header's actions move to the tab strip and tab menu.
  const host = useNodeHost()
  const tabActions: TabAction[] = [
    ...(draft && !view && editing === null ? [{ id: 'edit', label: PLAN_TEXT.edit, onSelect: () => setEditing(JSON.stringify(draft.tasks, null, 2)) }] : []),
    ...(editing !== null ? [{ id: 'apply', label: apply.busy ? PLAN_TEXT.applying : PLAN_TEXT.apply, disabled: apply.busy, busy: apply.busy, onSelect: onApply }] : []),
    ...(!plan.dagId && (draft || plan.error) ? [{ id: 'redraft', label: PLAN_TEXT.redraft, onSelect: redraft }] : []),
    ...(draft && !plan.dagId ? [{
      id: 'approve', label: approve.busy ? PLAN_TEXT.approving : PLAN_TEXT.approve, tooltip: PLAN_TEXT.approveHint, primary: true,
      disabled: busy || editing !== null || !preview || !plan.projectId, busy: approve.busy, onSelect: onApprove,
    }] : []),
  ]

  const body = () => {
    if (!plan.workspaceId && !plan.dagId) return <p className="plan-node__notice">{PLAN_TEXT.noWorkspace}</p>
    if (plan.error) return <p className="plan-node__notice plan-node__notice--error" role="alert">{plan.error}</p>
    if (!draft && !view) return <p className="plan-node__notice" role="status">{plan.planId ? PLAN_TEXT.drafting : PLAN_TEXT.noDraft}</p>
    if (editing !== null) return <textarea className="plan-node__json" aria-label="Plan tasks as JSON" value={editing} onChange={(e) => setEditing(e.target.value)} />
    return <PlanGraph tasks={tasks} waves={waves} status={status} onRemove={view ? undefined : (k) => setTasks(removeTask(tasks, k))} />
  }

  return (
    <>
      <NodeLayoutResizer minWidth={420} minHeight={240} color={swatch} />
      <div className={`term-node plan-node${selected ? ' term-node--selected' : ''}`} style={{ '--node-swatch': swatch } as CSSProperties}>
        {host.inTab ? <TabNodeActions id={id} visible={host.visible} items={[]} actions={tabActions} /> : (
        <div className="node-header">
          <span className="node-title plan-node__title" title={plan.intent}>
            <span className="codicon codicon-type-hierarchy" aria-hidden="true" />
            <NodeNameLabel name={d.name} label={title} />
            <span className="plan-node__desc">{view ? view.dag.status : draft ? 'draft, not running' : ''}</span>
          </span>
          <span className="plan-node__spacer" />
          <NodeResizeToggle />
          <ToolbarContainer className="nodrag plan-node__actions">
            {draft && !view && editing === null && <VscodeButton secondary onClick={() => setEditing(JSON.stringify(draft.tasks, null, 2))}>{PLAN_TEXT.edit}</VscodeButton>}
            {editing !== null && <VscodeButton secondary disabled={apply.busy} aria-busy={apply.busy ? 'true' : 'false'} onClick={onApply}>{apply.busy ? PLAN_TEXT.applying : PLAN_TEXT.apply}</VscodeButton>}
            {!plan.dagId && (draft || plan.error) && <VscodeButton secondary onClick={redraft}>{PLAN_TEXT.redraft}</VscodeButton>}
            {draft && !plan.dagId && (
              <VscodeButton title={PLAN_TEXT.approveHint} disabled={busy || editing !== null || !preview || !plan.projectId} aria-busy={approve.busy ? 'true' : 'false'} onClick={onApprove}>{approve.busy ? PLAN_TEXT.approving : PLAN_TEXT.approve}</VscodeButton>
            )}
            <ToolbarButton label="Close" title="Close" onClick={() => void rf.deleteElements({ nodes: [{ id }] })}><span className="codicon codicon-close" aria-hidden="true" /></ToolbarButton>
          </ToolbarContainer>
        </div>
        )}
        <div className="plan-node__summary nodrag">
          <span className="plan-node__intent">{plan.intent}</span>
          {tasks.length > 0 && <span>{tasks.length} task{tasks.length === 1 ? '' : 's'} · {waves.length} wave{waves.length === 1 ? '' : 's'} · {gates} gate{gates === 1 ? '' : 's'}</span>}
          {(view?.estimate ?? preview?.estimate) && <span>{estimateText(view?.estimate ?? preview?.estimate)}</span>}
          {pendingGates > 0 && <span className="plan-node__wait">{pendingGates} decision{pendingGates === 1 ? '' : 's'} waiting in the Central chat</span>}
        </div>
        {(msg || previewError || viewError) && <div className="plan-node__msg nodrag" role="status">{msg || previewError || viewError}</div>}
        {(apply.result || approve.result) && (
          <div className="plan-node__msg nodrag"><ActionResult action={apply} /><ActionResult action={approve} /></div>
        )}
        <div className="node-body plan-node__body nodrag nowheel nokey">{body()}</div>
        <Handle id="link-out" type="source" position={Position.Right} className="bridge-handle" />
        <Handle id="link-in" type="target" position={Position.Left} className="bridge-handle" />
      </div>
    </>
  )
}

export default memo(PlanNode)
