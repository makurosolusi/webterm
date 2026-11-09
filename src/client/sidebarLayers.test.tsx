/** @vitest-environment jsdom */
// Left side bar shell: one view at a time under a VS Code view title (LAYERS carries the node
// count), the Sessions view without the open workspace, the hide button, and the right-edge sash
// (min 220, max 40%, right = wider).
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionsPanel, { type SessionsPanelProps } from './SessionsPanel'
import SideBar, { type SideBarProps } from './sideBar/SideBar'
import { heightAfterDrag } from './bottomPanelSash'
import { SIDE_BAR_LEFT_WIDTH_KEY, sessionsPanelWidth } from './sessionsPanel.width'
import { DEFAULT_VIEWPORT, type Workspace, type WsNode } from '../shared/workspace'

// test-only fixtures
const node = (id: string, title: string): WsNode => ({ id, kind: 'terminal', title, x: 0, y: 0 })
const ws = (id: string, name: string, nodes: WsNode[]): Workspace => ({ id, name, viewport: DEFAULT_VIEWPORT, nodes, bridges: [], updatedAt: 0 })
const OPEN = ws('p1', 'Open', [node('a1', 'Here')])
const OTHER = ws('p2', 'Other', [node('b1', 'There')])

const sessionsProps = (over: Partial<SessionsPanelProps> = {}): SessionsPanelProps => ({
  active: true, workspaces: [OPEN, OTHER], activeId: 'p1', liveActiveNodes: null,
  statuses: {}, onFocusNode: vi.fn(), onCloseSession: vi.fn(), onSelectWorkspace: vi.fn(), ...over,
})
const shell = (over: Partial<SideBarProps> = {}): SideBarProps => ({
  open: true, view: 'layers', onClose: vi.fn(), layerCount: 4,
  layers: <div data-testid="layers-body" />, sessions: <div data-testid="sessions-body" />, history: <div data-testid="history-body" />,
  ...over,
})
const title = () => document.querySelector('.sessions-sidebar__head .sessions-sidebar__title')?.textContent
const badge = () => document.querySelector('.sessions-sidebar__head .sessions-sidebar__count')?.textContent

beforeEach(() => { localStorage.clear(); sessionsPanelWidth.reload() })
afterEach(cleanup)

describe('one view at a time', () => {
  it.each([
    ['layers', 'Layers', 'layers-body'],
    ['sessions', 'Sessions', 'sessions-body'],
    ['history', 'Agent History', 'history-body'],
  ] as const)('%s: titled %s and the only body mounted', (view, name, body) => {
    render(<SideBar {...shell({ view })} />)
    expect(title()).toBe(name)
    expect(screen.getByRole('heading', { name })).toBeTruthy()
    const mounted = ['layers-body', 'sessions-body', 'history-body'].filter((id) => screen.queryByTestId(id))
    expect(mounted).toEqual([body])
    expect(screen.getByTestId(body).closest('.side-bar__view')).not.toBeNull()
  })

  it('the count badge shows on LAYERS only', () => {
    const { rerender } = render(<SideBar {...shell()} />)
    expect(badge()).toBe('4')
    rerender(<SideBar {...shell({ view: 'sessions' })} />)
    expect(badge()).toBeUndefined()
    rerender(<SideBar {...shell({ layerCount: undefined })} />)
    expect(badge()).toBeUndefined()
  })
})

describe('Sessions without the open workspace', () => {
  it('Project view lists other workspaces only', () => {
    render(<SessionsPanel {...sessionsProps()} />)
    expect(document.querySelector('vscode-tree-item[data-group="project:p2"]')).not.toBeNull()
    expect(document.querySelector('vscode-tree-item[data-group="project:p1"]')).toBeNull()
  })

  it('Status view stays cross-board', () => {
    render(<SessionsPanel {...sessionsProps()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Status' }))
    const labels = [...document.querySelectorAll('vscode-tree-item')].map((i) => i.getAttribute('aria-label') ?? '')
    expect(labels.some((l) => l.startsWith('Here'))).toBe(true)
    expect(labels.some((l) => l.startsWith('There'))).toBe(true)
  })

  it('only the open workspace exists: says where other sessions will appear', () => {
    render(<SessionsPanel {...sessionsProps({ workspaces: [OPEN] })} />)
    expect(screen.getByText("Other workspaces' sessions appear here.")).toBeTruthy()
    expect(screen.queryByText('No sessions yet.')).toBeNull()
  })
})

describe('minimize and resize', () => {
  it('Hide Side Bar is always in the title row and closes the column', () => {
    const onClose = vi.fn()
    render(<SideBar {...shell({ onClose, view: 'history' })} />)
    const hide = screen.getByRole('button', { name: 'Hide Side Bar' })
    expect(hide.closest('.sessions-sidebar__head')).not.toBeNull()
    expect(hide.querySelector('.codicon-layout-sidebar-left-off')).not.toBeNull()
    fireEvent.click(hide)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('width clamps to min 220 and max 40% of the window, default 300', () => {
    vi.stubGlobal('innerWidth', 1000)
    expect(sessionsPanelWidth.current()).toBe(300)
    expect(sessionsPanelWidth.clamp(100)).toBe(220)
    expect(sessionsPanelWidth.clamp(900)).toBe(400)
    sessionsPanelWidth.set(350)
    expect(localStorage.getItem(SIDE_BAR_LEFT_WIDTH_KEY)).toBe('350')
    vi.unstubAllGlobals()
  })

  it('the right-edge sash grows when dragged or arrowed to the right, one width for every view', () => {
    expect(heightAfterDrag(300, 100, 150, true)).toBe(350)
    expect(heightAfterDrag(300, 100, 150)).toBe(250) // left-edge sashes keep their sign
    vi.stubGlobal('innerWidth', 1000)
    const { rerender } = render(<SideBar {...shell()} />)
    const sash = screen.getByRole('separator', { name: 'Resize Side Bar' })
    fireEvent.keyDown(sash, { key: 'ArrowRight' })
    expect(sessionsPanelWidth.current()).toBe(310)
    fireEvent.pointerDown(sash, { button: 0, clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(sash, { clientX: 340, pointerId: 1 })
    fireEvent.pointerUp(sash, { clientX: 340, pointerId: 1 })
    expect(sessionsPanelWidth.current()).toBe(350)
    rerender(<SideBar {...shell({ view: 'sessions' })} />)
    expect(sessionsPanelWidth.current()).toBe(350)
    vi.unstubAllGlobals()
  })
})
