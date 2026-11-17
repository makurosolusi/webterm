/** @vitest-environment jsdom */
// The typed skill ports in the blue-dot handle menu and the pane menu's "Skill…": an agent's Skills input lists
// searchable library skills (a skill node + its cable in one step), a skill's output lists agents, loading / failed /
// off / empty each have a visible row, and the context-link dots never offer a skill. React Flow itself is not mounted here.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { Node } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useHandleMenu } from './handleMenu.hook'
import { buildHandleEntries, cableFor, spawnCenterVertical, type HandleSpawners } from './handleMenu.model'
import { useCanvasPaneMenu } from './canvasMenu.pane'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SKILL_NODE_SIZE, SKILL_OUT, SKILLS_IN } from '../shared/skillPorts'
import type { CanvasSkillsLoad } from './skillNode.api'

const lib = vi.hoisted(() => ({ load: { status: 'loading' } as unknown }))
vi.mock('./skillNode.api', () => ({ useCanvasSkills: () => ({ ...(lib.load as object), reload: () => undefined }) }))

afterEach(() => { cleanup(); frame.mockClear() })

const READY: CanvasSkillsLoad = { status: 'ready', skills: [
  { name: 'webterm-release', version: '2', description: 'Ship a release.', enabled: true },
  { name: 'webterm-triage', version: '5', description: 'Sort bugs.', enabled: true },
  { name: 'webterm-off', version: '1', description: 'Off.', enabled: false },
] }

const agentNode: Node = { id: 'a1', type: 'agent', position: { x: 100, y: 400 }, width: 400, height: 300, data: { agentId: 'claude' } }
const skillNode: Node = { id: 's1', type: 'skill', position: { x: 100, y: 400 }, width: 260, height: 44, data: { skill: 'webterm-release' } }
const mdown = (x: number, y: number) => ({ clientX: x, clientY: y }) as MouseEvent
const ev = (x: number, y: number) => ({ clientX: x, clientY: y, target: null }) as unknown as MouseEvent
const noTarget = { isValid: null } as never
const frame = vi.fn()

interface Api { start: (e: MouseEvent, p: never) => void; end: (e: MouseEvent, s: never) => void }
let api: Api
let spawn: HandleSpawners
let addNode: (n: Node) => void

function Host({ origin }: { origin: Node }) {
  const [nodes, setNodes] = useState<Node[]>([origin])
  addNode = (n) => setNodes((p) => [...p, n])
  const m = useHandleMenu({ frame, nodes, settings: DEFAULT_SETTINGS, spawn })
  api = { start: m.onConnectStart as never, end: m.onConnectEnd as never }
  return <>{m.menu}</>
}

function mount(origin: Node, load: CanvasSkillsLoad, over: Partial<HandleSpawners> = {}) {
  lib.load = load
  spawn = { addTerminal: vi.fn(), addFiles: vi.fn(), addAgent: vi.fn(), addBrowser: vi.fn(), addDiff: vi.fn(), addAgentChat: vi.fn(), addSkill: vi.fn(), link: vi.fn(), ...over }
  render(<Host origin={origin} />)
}
const click = (node: Node, handle: string, type: 'source' | 'target') => act(() => {
  api.start(mdown(300, 200), { nodeId: node.id, handleId: handle, handleType: type } as never)
  api.end(ev(301, 200), noTarget)
})

describe('agent Skills input (diamond) -> skill list', () => {
  it('lists switched-on library skills with their description, searchable, titled "Add skill"', () => {
    mount(agentNode, READY)
    click(agentNode, SKILLS_IN, 'target')
    expect(screen.getByRole('dialog', { name: 'Add skill' })).toBeTruthy()
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['webterm-releaseShip a release.', 'webterm-triageSort bugs.'])
    fireEvent.change(screen.getByRole('combobox', { name: 'Search skills' }), { target: { value: 'triage' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzzz' } })
    expect(screen.getByText('No match')).toBeTruthy()
  })

  it('picking spawns the skill node BELOW the agent and cables skill-out -> skills-in once it appears', () => {
    mount(agentNode, READY)
    click(agentNode, SKILLS_IN, 'target')
    fireEvent.click(screen.getByRole('option', { name: /webterm-triage/ }))
    expect(spawn.addSkill).toHaveBeenCalledTimes(1)
    const [ref, at] = (spawn.addSkill as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(ref).toEqual({ name: 'webterm-triage', version: '5' })
    expect(at.y - SKILL_NODE_SIZE.height / 2).toBeGreaterThan(400 + 300) // below the agent's bottom edge
    expect(spawn.link).not.toHaveBeenCalled()
    act(() => addNode({ id: 'sk9', type: 'skill', position: { x: 100, y: 800 }, data: {} }))
    expect(spawn.link).toHaveBeenCalledWith({ source: 'sk9', target: 'a1', sourceHandle: SKILL_OUT, targetHandle: SKILLS_IN })
    expect(frame).toHaveBeenCalledWith(['a1', 'sk9'])
    expect(spawn.addAgent).not.toHaveBeenCalled()
  })

  it.each([
    ['loading', { status: 'loading' }, 'Loading skills…'],
    ['failed', { status: 'error' }, 'Could not load skills'],
    ['off', { status: 'off' }, 'Central skills are off'],
    ['empty', { status: 'ready', skills: [] }, 'No active canvas skills yet'],
  ] as Array<[string, CanvasSkillsLoad, string]>)('%s shows one disabled row that cannot be picked', (_name, load, text) => {
    mount(agentNode, load)
    click(agentNode, SKILLS_IN, 'target')
    const row = screen.getByRole('option', { name: text })
    expect(row.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(row)
    expect(spawn.addSkill).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('skill output (diamond) -> agents', () => {
  it('offers only nodes a skill may cable to (Claude agent, Agent Chat), spawns above the skill and cables skill -> new', () => {
    mount(skillNode, READY)
    click(skillNode, SKILL_OUT, 'source')
    const labels = screen.getAllByRole('option').map((o) => o.textContent ?? '')
    expect(labels.some((l) => /Claude/.test(l))).toBe(true)
    expect(labels.some((l) => /Agent Chat/.test(l))).toBe(true)
    for (const no of [/Terminal/, /Browser/, /File Manager/, /Diff/]) expect(labels.some((l) => no.test(l))).toBe(false)
    fireEvent.click(screen.getByRole('option', { name: /Agent Chat/ }))
    const at = (spawn.addAgentChat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(at.y + DEFAULT_SETTINGS.defaultNodeHeight / 2).toBeLessThan(400) // above the skill node
    act(() => addNode({ id: 'c9', type: 'agentChat', position: { x: 100, y: 0 }, data: { agentId: 'claude' } }))
    expect(spawn.link).toHaveBeenCalledWith({ source: 's1', target: 'c9', sourceHandle: SKILL_OUT, targetHandle: SKILLS_IN })
  })
})

describe('the context-link dots never offer a skill', () => {
  it('an agent link handle lists node kinds only (no skill rows, no skill list)', () => {
    mount(agentNode, READY)
    click(agentNode, 'link-out', 'source')
    expect(screen.getByRole('dialog', { name: 'Add connected node' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /webterm-/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /Skill/ })).toBeNull()
  })

  it('model: no node entries from a Skills input; cableFor keeps the context handles by default', () => {
    const s = { addTerminal: vi.fn(), addFiles: vi.fn(), addAgent: vi.fn(), addSkill: vi.fn(), link: vi.fn() } as HandleSpawners
    const ctx = { nodeCount: 1, disabledAgents: [], customAgents: [], agentLaunchCommands: {} }
    expect(buildHandleEntries(s, ctx, { id: 'a1', kind: 'agent', agentId: 'claude', side: 'target', port: 'skill' })).toEqual([])
    expect(buildHandleEntries(s, ctx, { id: 'a1', kind: 'agent', agentId: 'claude', side: 'target' }).length).toBeGreaterThan(0)
    expect(cableFor('a', 'b', 'source')).toEqual({ source: 'a', target: 'b', sourceHandle: 'link-out', targetHandle: 'link-in' })
  })

  it('spawnCenterVertical goes below / above, left-aligned, and slides right past a covering node', () => {
    const origin = { x: 0, y: 0, width: 400, height: 300 }
    const size = { width: 260, height: 44 }
    const below = spawnCenterVertical(origin, size, 'below', [])
    expect(below.y - 22).toBeGreaterThan(300)
    expect(below.x - 130).toBe(0)
    expect(spawnCenterVertical(origin, size, 'above', []).y + 22).toBeLessThan(0)
    const blocker = { x: 0, y: below.y - 22, width: 300, height: 100 }
    expect(spawnCenterVertical(origin, size, 'below', [blocker]).x - 130).toBeGreaterThanOrEqual(300)
  })
})

function PaneHost({ onAddSkill }: { onAddSkill: (s: { name: string; version: string }, at: { x: number; y: number }) => void }) {
  const rf = { current: { screenToFlowPosition: (p: { x: number; y: number }) => ({ x: p.x - 10, y: p.y - 20 }) } } as never
  const { onPaneContextMenu, menu } = useCanvasPaneMenu({
    rf, settings: DEFAULT_SETTINGS, nodeCount: 0, onAddTerminal: vi.fn(), onAddFiles: vi.fn(), onAddAgent: vi.fn(), onAddSkill, onFit: vi.fn(), onSelectAll: vi.fn(),
  })
  return <><button type="button" onClick={(e) => onPaneContextMenu(e as never)}>open</button>{menu}</>
}

describe('pane menu "Skill…"', () => {
  it('opens the skill list at the click point and places the chosen skill there', () => {
    lib.load = READY
    const onAddSkill = vi.fn()
    render(<PaneHost onAddSkill={onAddSkill} />)
    fireEvent.click(screen.getByText('open'), { clientX: 200, clientY: 100 })
    fireEvent.click(screen.getByRole('menuitem', { name: /Skill…/ }))
    expect(screen.getByRole('dialog', { name: 'Add skill' })).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: /webterm-release/ }))
    expect(onAddSkill).toHaveBeenCalledWith({ name: 'webterm-release', version: '2' }, { x: 190, y: 80 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('has no "Skill…" row when the board cannot place one', () => {
    lib.load = READY
    render(<PaneHostWithout />)
    fireEvent.click(screen.getByText('open'), { clientX: 200, clientY: 100 })
    expect(screen.queryByRole('menuitem', { name: /Skill…/ })).toBeNull()
  })
})

function PaneHostWithout() {
  const rf = { current: null } as never
  const { onPaneContextMenu, menu } = useCanvasPaneMenu({ rf, settings: DEFAULT_SETTINGS, nodeCount: 0, onAddTerminal: vi.fn(), onAddFiles: vi.fn(), onAddAgent: vi.fn(), onFit: vi.fn(), onSelectAll: vi.fn() })
  return <><button type="button" onClick={(e) => onPaneContextMenu(e as never)}>open</button>{menu}</>
}
