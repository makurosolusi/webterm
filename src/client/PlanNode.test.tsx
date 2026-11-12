/** @vitest-environment jsdom */
// Plan node DOM (F4-f): an intent drafts once, the draft shows waves/gates/estimate and nothing is
// created until Approve; after approval each dispatched worker appears as a node cabled to the plan.
// The `/api/dag` client is faked; no planner, no Claude.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, type Edge, type Node } from '@xyflow/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const api = vi.hoisted(() => ({ startPlan: vi.fn(), fetchPlan: vi.fn(), previewPlan: vi.fn(), approvePlan: vi.fn(), fetchDag: vi.fn() }))
vi.mock('./PlanNode.api', () => api)

import PlanNode, { PLAN_TEXT } from './PlanNode'
import { NodeHostContext } from './tabLayout.context'
import { setEditorActionsSlot, tabNodeMenuItems } from './tabLayout.nodeActions'

// test-only: jsdom has no ResizeObserver; React Flow renders unmeasured nodes, which is all this needs.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

// test-only draft
const brief = (objective: string, lease: string) => ({ objective, outputFormat: 'diff', tools: ['Read'], boundaries: 'b', verifyCmd: { file: 'npm', args: ['test'] }, nextAction: 'n', effort: 'simple', lease: [lease] })
const DRAFT = {
  title: 'Add login',
  tasks: [
    { key: 'api', kind: 'work', deps: [], brief: brief('Add the endpoint', 'src/api/**') },
    { key: 'ask', kind: 'gate', deps: ['api'], brief: { objective: 'Ship behind a flag?', nextAction: 'ui', options: ['yes', 'no'] } },
    { key: 'ui', kind: 'work', deps: ['ask'], brief: brief('Add the form', 'src/ui/**') },
  ],
}
const ESTIMATE = { medianMicros: 250_000, samples: 3, basis: 'kind', tasks: 2, totalMicros: 500_000 }
const SLOW = { timeout: 4000 }

let latest: { nodes: Node[]; edges: Edge[] } = { nodes: [], edges: [] }
const nodeTypes = { plan: PlanNode, diff: ({ data }: { data: { cwd?: string } }) => <div data-testid="worker">{data.cwd}</div> }

function Canvas({ init }: { init: Node[] }) {
  const [nodes, , onNodesChange] = useNodesState(init)
  const [edges, , onEdgesChange] = useEdgesState<Edge>([])
  latest = { nodes, edges }
  return <div style={{ width: 1200, height: 800 }}><ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} nodeTypes={nodeTypes} /></div>
}

const mount = (plan: Record<string, unknown>, inTab = false) =>
  render(
    <ReactFlowProvider>
      <div ref={setEditorActionsSlot} data-slot="tab-editor-actions" />
      <NodeHostContext.Provider value={{ inTab, visible: true, maximized: false }}>
        <Canvas init={[{ id: 'p1', type: 'plan', position: { x: 0, y: 0 }, width: 640, height: 460, data: { plan } }]} />
      </NodeHostContext.Provider>
    </ReactFlowProvider>,
  )
const planData = () => (latest.nodes.find((n) => n.id === 'p1')?.data as { plan: Record<string, unknown> }).plan

function draftReady() {
  api.startPlan.mockResolvedValue({ planId: 'job1' })
  api.fetchPlan.mockResolvedValue({ status: 'ready', draft: DRAFT, waves: [], estimate: ESTIMATE, projectId: 'w1', repo: '/repo' })
  api.previewPlan.mockImplementation(async (d: typeof DRAFT) => ({ draft: d, waves: d.tasks.map((t) => [t.key]), estimate: { ...ESTIMATE, tasks: d.tasks.filter((t) => t.kind === 'work').length } }))
}

describe('PlanNode', () => {
  it('drafts once from the intent and shows waves, gates and the estimate without creating a DAG', async () => {
    draftReady()
    mount({ intent: 'add a login form', workspaceId: 'w1' })
    expect(await screen.findByText(/Drafting a plan/)).toBeTruthy()
    await waitFor(() => expect(screen.getByLabelText('Task ui')).toBeTruthy(), SLOW)
    expect(api.startPlan).toHaveBeenCalledTimes(1)
    expect(api.startPlan).toHaveBeenCalledWith('add a login form', 'w1')
    expect(screen.getAllByText(/^Wave \d$/).map((e) => e.textContent)).toEqual(['Wave 1', 'Wave 2', 'Wave 3'])
    expect(screen.getByText('Your decision')).toBeTruthy()
    expect(screen.getByText('3 tasks · 3 waves · 1 gate')).toBeTruthy()
    expect(screen.getByText(/Estimate: ~\$0.50 \(2 agent runs/)).toBeTruthy()
    expect(planData()).toMatchObject({ draft: DRAFT, projectId: 'w1', repo: '/repo' })
    expect(planData().planId).toBeUndefined()
    expect(api.approvePlan).not.toHaveBeenCalled()
  })

  it('removing a task re-checks the edited draft; nothing is approved', async () => {
    draftReady()
    mount({ intent: 'x y', workspaceId: 'w1', draft: DRAFT, projectId: 'w1', repo: '/repo' })
    await screen.findByLabelText('Task ask')
    fireEvent.click(screen.getByLabelText('Task ask').querySelector('.plan-node__remove')!)
    await waitFor(() => expect(api.previewPlan).toHaveBeenLastCalledWith({ title: 'Add login', tasks: [DRAFT.tasks[0], { ...DRAFT.tasks[2], deps: [] }] }))
    expect(api.startPlan).not.toHaveBeenCalled()
    expect(api.approvePlan).not.toHaveBeenCalled()
  })

  it('Approve creates the DAG; dispatched workers appear wired to the plan along the DAG edges', async () => {
    draftReady()
    api.approvePlan.mockResolvedValue({ dag: { id: 'd1' } })
    api.fetchDag.mockResolvedValue({
      dag: { id: 'd1', title: 'Add login', status: 'active' },
      tasks: DRAFT.tasks.map((t, i) => ({ ...t, id: `t${i}`, status: i === 0 ? 'running' : 'pending', lastError: null })),
      gates: [], waves: [['api'], ['ask'], ['ui']], estimate: ESTIMATE,
      dispatches: [{ id: 'x1', taskId: 't0', nodeId: 'dag-x1', worktree: '/wt/x1', branch: 'dag/api', status: 'running' }],
    })
    mount({ intent: 'x y', workspaceId: 'w1', draft: DRAFT, projectId: 'w1', repo: '/repo' })
    const approve = await screen.findByRole('button', { name: 'Approve and run' })
    await waitFor(() => expect(approve.hasAttribute('disabled')).toBe(false))
    fireEvent.click(approve)
    expect(approve.getAttribute('aria-busy')).toBe('true')
    expect(approve.textContent).toBe('Starting…')
    await waitFor(() => expect(api.approvePlan).toHaveBeenCalledWith({ projectId: 'w1', repo: '/repo', title: 'Add login', tasks: DRAFT.tasks }))
    expect((await screen.findByTestId('worker', {}, SLOW)).textContent).toBe('/wt/x1')
    await waitFor(() => expect(latest.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['p1>dag-x1']))
    expect(planData()).toMatchObject({ dagId: 'd1', wired: ['x1'] })
    expect(screen.getByText('running')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve and run' })).toBeNull()
  })

  it('a planner failure is shown with Draft again', async () => {
    api.startPlan.mockResolvedValue({ planId: 'job1' })
    api.fetchPlan.mockResolvedValue({ status: 'failed', error: 'planner returned no structured output: no' })
    mount({ intent: 'x y', workspaceId: 'w1' })
    expect((await screen.findByRole('alert', {}, SLOW)).textContent).toContain('no structured output')
    fireEvent.click(screen.getByRole('button', { name: 'Draft again' }))
    await waitFor(() => expect(api.startPlan).toHaveBeenCalledTimes(2))
  })
})

describe('PlanNode in tab mode', () => {
  const strip = () => within(document.querySelector<HTMLElement>('[data-slot="tab-editor-actions"]')!)
  const labels = () => strip().getAllByRole('button').map((b) => b.textContent)

  it('renders no own header; Edit JSON, Draft again and Approve sit in the strip and the tab menu', async () => {
    draftReady()
    const { container } = mount({ intent: 'x y', workspaceId: 'w1', draft: DRAFT, projectId: 'w1', repo: '/repo' }, true)
    await screen.findByLabelText('Task ask')
    expect(container.querySelector('.plan-node .node-header')).toBeNull()
    expect(labels()).toEqual([PLAN_TEXT.edit, PLAN_TEXT.redraft, PLAN_TEXT.approve])
    expect(tabNodeMenuItems('p1').map((r) => (r.type === 'item' ? r.label : r.type))).toEqual([PLAN_TEXT.edit, PLAN_TEXT.redraft, PLAN_TEXT.approve])
    // Editing swaps Edit for Apply and keeps Approve disabled until the edits are applied.
    fireEvent.click(strip().getByRole('button', { name: PLAN_TEXT.edit }))
    expect(labels()).toEqual([PLAN_TEXT.apply, PLAN_TEXT.redraft, PLAN_TEXT.approve])
    expect((strip().getByRole('button', { name: PLAN_TEXT.approve }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps its own header on the canvas and publishes nothing', async () => {
    draftReady()
    const { container } = mount({ intent: 'x y', workspaceId: 'w1', draft: DRAFT, projectId: 'w1', repo: '/repo' })
    await screen.findByLabelText('Task ask')
    expect(container.querySelector('.plan-node .node-header .codicon-close')).not.toBeNull()
    expect(strip().queryAllByRole('button')).toHaveLength(0)
    expect(tabNodeMenuItems('p1')).toEqual([])
  })
})
