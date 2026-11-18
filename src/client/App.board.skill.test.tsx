/** @vitest-environment jsdom */
// Board wiring of skill nodes (`useBoardActions`): "Add to canvas" places a node and cables it to the ONE selected
// Claude agent (below it), refuses the ninth skill on an agent, and a drawn connection through `onConnect` honours the
// typed ports. React state only; React Flow is not mounted (see skillNode.canvas.test.tsx for the real canvas).
import { act, cleanup, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import type { Connection, Edge, Node } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBoardActions } from './App.board'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { MAX_ATTACHED_SKILLS, SKILL_NODE_SIZE, SKILL_OUT, SKILLS_IN } from '../shared/skillPorts'
import { toFlowEdge } from './store'
import type { Workspace } from '../shared/workspace'

const notices = vi.hoisted(() => ({ showNotice: vi.fn() }))
vi.mock('./workspaceSave.notice', () => ({ showNotice: notices.showNotice, closeNotice: vi.fn() }))

afterEach(() => { cleanup(); notices.showNotice.mockClear() })

const WS: Workspace = { id: 'w', name: 'B', cwd: '/', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], bridges: [], updatedAt: 1 }
const agent = (id: string, selected = false, agentId = 'claude'): Node => ({ id, type: 'agent', position: { x: 0, y: 0 }, width: 400, height: 300, data: { agentId }, selected })
const skill = (id: string): Node => ({ id, type: 'skill', position: { x: 0, y: 0 }, width: 260, height: 44, data: { skill: `webterm-${id}` } })

type Actions = ReturnType<typeof useBoardActions>
let actions: Actions
let state: { nodes: Node[]; edges: Edge[] }
const scheduleSave = vi.fn()

function Host({ nodes: n0, edges: e0 = [] }: { nodes: Node[]; edges?: Edge[] }) {
  const [nodes, setNodes] = useState(n0)
  const [edges, setEdges] = useState(e0)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  nodesRef.current = nodes
  edgesRef.current = edges
  const rf = useRef(null)
  const activeWsRef = useRef<Workspace | null>(WS)
  state = { nodes, edges }
  actions = useBoardActions({
    rf, activeWsRef, nodesRef, edgesRef, settings: DEFAULT_SETTINGS, activeId: 'w', browserReady: false,
    setActiveWs: vi.fn(), setNodes, setEdges, flushSave: vi.fn(), scheduleSave, resetViewport: vi.fn(), resetLayout: vi.fn(), pushLayout: vi.fn(), recordClosed: vi.fn(),
  })
  return null
}
const skillEdges = () => state.edges.filter((e) => (e.data as { kind?: string }).kind === 'skill')
const connection = (source: string, target: string, sourceHandle: string, targetHandle: string): Connection => ({ source, target, sourceHandle, targetHandle })

describe('Add to canvas (addSkillNode)', () => {
  it('without a selected agent: a collapsed skill node, no cable', () => {
    render(<Host nodes={[agent('a1')]} />)
    let r: unknown
    act(() => { r = actions.nodeActions.addSkillNode?.({ name: 'webterm-release', version: '4' }) })
    expect(r).toEqual({ status: 'added' })
    const added = state.nodes.find((n) => n.type === 'skill')
    expect(added).toMatchObject({ data: { skill: 'webterm-release', seenVersion: '4', collapsed: true } })
    expect(state.edges).toEqual([])
    expect(scheduleSave).toHaveBeenCalled()
  })

  it('with exactly one Claude agent selected: placed below it and cabled skill -> agent on the typed ports', () => {
    render(<Host nodes={[agent('a1', true), agent('a2')]} />)
    let r: unknown
    act(() => { r = actions.nodeActions.addSkillNode?.({ name: 'webterm-release', version: '4' }) })
    expect(r).toEqual({ status: 'attached' })
    const added = state.nodes.find((n) => n.type === 'skill')!
    expect(added.position.y).toBeGreaterThan(300) // below a1's bottom edge
    expect(skillEdges()).toEqual([expect.objectContaining({ source: added.id, target: 'a1', sourceHandle: SKILL_OUT, targetHandle: SKILLS_IN, type: 'skill' })])
  })

  it('two agents selected, or a non-Claude one, cable nothing', () => {
    render(<Host nodes={[agent('a1', true), agent('a2', true)]} />)
    act(() => { actions.nodeActions.addSkillNode?.({ name: 'webterm-release', version: '4' }) })
    expect(state.edges).toEqual([])
    cleanup()
    render(<Host nodes={[agent('x', true, 'codex')]} />)
    act(() => { actions.nodeActions.addSkillNode?.({ name: 'webterm-release', version: '4' }) })
    expect(state.edges).toEqual([])
  })

  it('an agent already holding the maximum keeps its skills: the node is added, the cable is not (status limit)', () => {
    const full = Array.from({ length: MAX_ATTACHED_SKILLS }, (_, i) => toFlowEdge({ id: `b${i}`, source: `s${i}`, target: 'a1', kind: 'skill' }))
    render(<Host nodes={[agent('a1', true)]} edges={full} />)
    let r: unknown
    act(() => { r = actions.nodeActions.addSkillNode?.({ name: 'webterm-release', version: '4' }) })
    expect(r).toEqual({ status: 'limit' })
    expect(skillEdges()).toHaveLength(MAX_ATTACHED_SKILLS)
    expect(state.nodes.some((n) => n.type === 'skill')).toBe(true)
  })
})

describe('addSkillNode with a target (drop on an agent, drop on the pane)', () => {
  const REF = { name: 'webterm-release', version: '4' }

  it('hostId: node below that agent (selected or not) and cabled to it', () => {
    render(<Host nodes={[agent('a1'), agent('a2', true)]} />)
    let r: unknown
    act(() => { r = actions.nodeActions.addSkillNode?.(REF, { hostId: 'a1' }) })
    expect(r).toEqual({ status: 'attached' })
    const added = state.nodes.find((n) => n.type === 'skill')!
    expect(skillEdges()).toEqual([expect.objectContaining({ source: added.id, target: 'a1' })])
  })

  it('at: a bare node at that point even when one agent is selected; no cable', () => {
    render(<Host nodes={[agent('a1', true)]} />)
    let r: unknown
    act(() => { r = actions.nodeActions.addSkillNode?.(REF, { at: { x: 900, y: 700 } }) })
    expect(r).toEqual({ status: 'added' })
    const added = state.nodes.find((n) => n.type === 'skill')!
    expect(added.position.x).toBeCloseTo(900 - SKILL_NODE_SIZE.width / 2, 0) // the round token is centred on the point
    expect(state.edges).toEqual([])
  })

  it('a skill already cabled to that agent makes no second node and no second cable', () => {
    const edge = toFlowEdge({ id: 'b', source: 's1', target: 'a1', kind: 'skill' })
    render(<Host nodes={[agent('a1', true), { ...skill('s1'), data: { skill: 'webterm-release' } }]} edges={[edge]} />)
    let r: unknown
    act(() => { r = actions.nodeActions.addSkillNode?.(REF, { hostId: 'a1' }) })
    expect(r).toEqual({ status: 'exists' })
    act(() => { r = actions.nodeActions.addSkillNode?.(REF) }) // the keyboard path: same answer
    expect(r).toEqual({ status: 'exists' })
    expect(state.nodes.filter((n) => n.type === 'skill')).toHaveLength(1)
    expect(skillEdges()).toHaveLength(1)
  })

  it('a hostId that is not a Claude agent cables nothing', () => {
    render(<Host nodes={[agent('x', false, 'codex')]} />)
    act(() => { actions.nodeActions.addSkillNode?.(REF, { hostId: 'x' }) })
    expect(state.edges).toEqual([])
    expect(state.nodes.some((n) => n.type === 'skill')).toBe(true)
  })
})

describe('onConnect reports a refused cable', () => {
  it('a ninth skill drawn onto an agent says the agent is full', () => {
    const full = Array.from({ length: MAX_ATTACHED_SKILLS }, (_, i) => toFlowEdge({ id: `b${i}`, source: `s${i}`, target: 'a1', kind: 'skill' }))
    render(<Host nodes={[{ ...agent('a1'), data: { agentId: 'claude', title: 'Ada' } }, skill('s9')]} edges={full} />)
    act(() => actions.onConnect(connection('s9', 'a1', SKILL_OUT, SKILLS_IN)))
    expect(notices.showNotice).toHaveBeenCalledWith(expect.any(String), { title: `Ada already has ${MAX_ATTACHED_SKILLS} skills. Detach one first.`, severity: 'warning' })
  })

  it('the same pair drawn twice says already attached; a good cable says nothing', () => {
    render(<Host nodes={[agent('a1'), skill('s1')]} />)
    act(() => actions.onConnect(connection('s1', 'a1', SKILL_OUT, SKILLS_IN)))
    expect(notices.showNotice).not.toHaveBeenCalled()
    act(() => actions.onConnect(connection('s1', 'a1', SKILL_OUT, SKILLS_IN)))
    expect(notices.showNotice).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ title: 'Already attached to claude.' }))
  })
})

describe('onConnect honours the typed ports', () => {
  it('attaches on skill-out -> skills-in, keeps the cap, and does not duplicate', () => {
    render(<Host nodes={[agent('a1'), skill('s1')]} />)
    act(() => actions.onConnect(connection('s1', 'a1', SKILL_OUT, SKILLS_IN)))
    expect(skillEdges()).toHaveLength(1)
    act(() => actions.onConnect(connection('s1', 'a1', SKILL_OUT, SKILLS_IN)))
    expect(skillEdges()).toHaveLength(1)
  })

  it('drops skill -> link-in, agent -> skills-in and skill -> a non-Claude agent; context links still connect', () => {
    render(<Host nodes={[agent('a1'), agent('a2'), agent('x', false, 'codex'), skill('s1')]} />)
    act(() => actions.onConnect(connection('s1', 'a1', SKILL_OUT, 'link-in')))
    act(() => actions.onConnect(connection('a2', 'a1', 'link-out', SKILLS_IN)))
    act(() => actions.onConnect(connection('s1', 'x', SKILL_OUT, SKILLS_IN)))
    expect(state.edges).toEqual([])
    act(() => actions.onConnect(connection('a1', 'a2', 'link-out', 'link-in')))
    expect(state.edges).toEqual([expect.objectContaining({ source: 'a1', target: 'a2', type: 'context' })])
  })

  it('refuses a ninth skill drawn onto an agent', () => {
    const full = Array.from({ length: MAX_ATTACHED_SKILLS }, (_, i) => toFlowEdge({ id: `b${i}`, source: `s${i}`, target: 'a1', kind: 'skill' }))
    render(<Host nodes={[agent('a1'), skill('s9')]} edges={full} />)
    act(() => actions.onConnect(connection('s9', 'a1', SKILL_OUT, SKILLS_IN)))
    expect(skillEdges()).toHaveLength(MAX_ATTACHED_SKILLS)
  })
})
