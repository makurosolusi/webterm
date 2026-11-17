/** @vitest-environment jsdom */
// Skills palette (side bar view): only active, switched-on canvas skills, search, the add paths of a row, the per-agent markers,
// and the loading / empty / error states. The library lookup is the real `useCanvasSkills` over a stubbed transport.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Edge, Node } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_ATTACHED_SKILLS } from '../shared/skillPorts'
import { toFlowEdge } from './store'
import { NodeActionsProvider, type NodeActions } from './nodeActions'
import SkillPalette from './SkillPalette'
import { SKILL_DRAG_MIME } from './skillPalette.drag'
import { SKILL_NOTICE_KEY } from './skillPalette.notice'

const h = vi.hoisted(() => ({ request: vi.fn(), showNotice: vi.fn(), openCentralTab: vi.fn() }))
vi.mock('./inboxTransport', async (orig) => ({ ...(await orig<object>()), request: h.request }))
vi.mock('./workspaceSave.notice', () => ({ showNotice: h.showNotice, closeNotice: vi.fn() }))
vi.mock('./secondarySideBar.store', async (orig) => ({ ...(await orig<object>()), openCentralTab: h.openCentralTab }))

const row = (name: string, over: Record<string, unknown> = {}, record: Record<string, unknown> = {}) => ({
  record: { name, version: '3', status: 'active', audience: 'canvas', enabled: true, ...record }, description: `About ${name}`, ...over,
})
const LIBRARY = [
  row('webterm-release', {}, { title: 'Release notes' }),
  row('webterm-deploy'),
  row('draft-skill', {}, { status: 'proposed' }),
  row('central-only', {}, { audience: 'central' }),
  row('switched-off', {}, { enabled: false }),
]
// test-only fixtures
const agent = (selected: boolean, title = 'Ada'): Node => ({ id: 'a1', type: 'agent', position: { x: 0, y: 0 }, data: { agentId: 'claude', title }, selected })
const skillNode = (id: string, skill: string): Node => ({ id, type: 'skill', position: { x: 0, y: 0 }, data: { skill } })
const cable = (id: string): Edge => toFlowEdge({ id: `b-${id}`, source: id, target: 'a1', kind: 'skill' })

let addSkillNode: ReturnType<typeof vi.fn>
function mount(nodes: Node[] = [], edges: Edge[] = []) {
  const value = { onSession: vi.fn(), onToggleHideLinks: vi.fn(), addSkillNode } as unknown as NodeActions
  return render(<NodeActionsProvider value={value}><SkillPalette nodes={nodes} edges={edges} /></NodeActionsProvider>)
}
const titles = () => screen.queryAllByRole('button', { name: /^Add / }).map((b) => b.querySelector('strong')?.textContent)
const notice = () => h.showNotice.mock.calls.at(-1)?.[1] as { title: string; severity: string }

beforeEach(() => {
  addSkillNode = vi.fn(() => ({ status: 'added' }))
  h.request.mockResolvedValue(LIBRARY)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('list', () => {
  it('shows only active, switched-on canvas skills: title, slug, version, description', async () => {
    mount()
    await screen.findByRole('list', { name: 'Canvas skills' })
    expect(titles()).toEqual(['webterm-deploy', 'Release notes'])
    const first = screen.getByRole('button', { name: 'Add Release notes to canvas' })
    expect(first.textContent).toContain('webterm-release')
    expect(first.textContent).toContain('v3')
    expect(first.textContent).toContain('About webterm-release')
  })

  it('search narrows by title, name and description; no match says so', async () => {
    mount()
    await screen.findByRole('list', { name: 'Canvas skills' })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), { target: { value: 'DEPLOY' } })
    expect(titles()).toEqual(['webterm-deploy'])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), { target: { value: 'nothing-like-this' } })
    expect(screen.getByText('No skill matches the search.')).toBeTruthy()
  })
})

describe('adding a row', () => {
  it('a press (Enter on the focused row) adds through the board function, no target, and reports the outcome', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Add webterm-deploy to canvas' }))
    expect(addSkillNode).toHaveBeenCalledWith({ name: 'webterm-deploy', version: '3' })
    expect(h.showNotice).toHaveBeenCalledWith(SKILL_NOTICE_KEY, { title: 'Added to the canvas.', severity: 'info' })
  })

  it('with one agent selected the notice names it; at the cap it warns, an existing pair says already attached', async () => {
    mount([agent(true)])
    const btn = await screen.findByRole('button', { name: 'Add webterm-deploy to canvas' })
    addSkillNode.mockReturnValueOnce({ status: 'attached' })
    fireEvent.click(btn)
    expect(notice().title).toBe('Added to the canvas and attached to Ada.')
    addSkillNode.mockReturnValueOnce({ status: 'limit' })
    fireEvent.click(btn)
    expect(notice()).toEqual({ title: `Ada already has ${MAX_ATTACHED_SKILLS} skills. Added to the canvas, not attached.`, severity: 'warning' })
    addSkillNode.mockReturnValueOnce({ status: 'exists' })
    fireEvent.click(btn)
    expect(notice().title).toBe('Already attached to Ada.')
  })

  it('no board provider: the notice says to open a workspace', async () => {
    addSkillNode = undefined as never
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Add webterm-deploy to canvas' }))
    expect(notice()).toEqual({ title: 'Open a workspace to add a skill node.', severity: 'warning' })
  })

  it('dragging a row carries the skill reference on the private MIME', async () => {
    mount()
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' }
    fireEvent.dragStart(await screen.findByRole('button', { name: 'Add webterm-deploy to canvas' }), { dataTransfer })
    expect(dataTransfer.setData).toHaveBeenCalledWith(SKILL_DRAG_MIME, JSON.stringify({ name: 'webterm-deploy', version: '3' }))
  })
})

describe('selected agent markers', () => {
  it('shows the count header and a check on attached skills only', async () => {
    mount([agent(true), skillNode('s1', 'webterm-deploy')], [cable('s1')])
    await screen.findByRole('list', { name: 'Canvas skills' })
    expect(screen.getByText(`Agent Ada: 1/${MAX_ATTACHED_SKILLS}`)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add webterm-deploy to canvas (attached)' }).textContent).toContain('Attached')
    expect(screen.getByRole('button', { name: 'Add Release notes to canvas' }).textContent).not.toContain('Attached')
  })

  it('no selected agent: no header, no check', async () => {
    mount([agent(false), skillNode('s1', 'webterm-deploy')], [cable('s1')])
    await screen.findByRole('list', { name: 'Canvas skills' })
    expect(screen.queryByText(/^Agent /)).toBeNull()
    expect(screen.queryByText('Attached')).toBeNull()
  })
})

describe('states', () => {
  it('loading shows a status while the lookup is pending', () => {
    h.request.mockReturnValue(new Promise(() => undefined))
    mount()
    expect(screen.getByRole('status').textContent).toBe('Loading skills…')
  })

  it('empty library: message and a button to the Skills tab', async () => {
    h.request.mockResolvedValue([row('draft-skill', {}, { status: 'proposed' })])
    mount()
    expect(await screen.findByText('No canvas skills yet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Skills tab' }))
    expect(h.openCentralTab).toHaveBeenCalledWith('skills')
  })

  it('error shows an alert and Retry loads again', async () => {
    h.request.mockRejectedValueOnce(new Error('down'))
    mount()
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load skills.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(titles()).toEqual(['webterm-deploy', 'Release notes']))
  })
})
