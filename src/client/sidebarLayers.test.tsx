/** @vitest-environment jsdom */
// Left side bar column: Layers + Sessions sections (collapse persists), Project view without the
// open workspace, the minimize button, and the right-edge sash (min 220, max 40%, right = wider).
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionsPanel, { LAYERS_SECTION_KEY, SESSIONS_SECTION_KEY, type SessionsPanelProps } from './SessionsPanel'
import { heightAfterDrag } from './bottomPanelSash'
import { SIDE_BAR_LEFT_WIDTH_KEY, sessionsPanelWidth } from './sessionsPanel.width'
import { DEFAULT_VIEWPORT, type Workspace, type WsNode } from '../shared/workspace'

// test-only fixtures
const node = (id: string, title: string): WsNode => ({ id, kind: 'terminal', title, x: 0, y: 0 })
const ws = (id: string, name: string, nodes: WsNode[]): Workspace => ({ id, name, viewport: DEFAULT_VIEWPORT, nodes, bridges: [], updatedAt: 0 })
const OPEN = ws('p1', 'Open', [node('a1', 'Here')])
const OTHER = ws('p2', 'Other', [node('b1', 'There')])

const props = (over: Partial<SessionsPanelProps> = {}): SessionsPanelProps => ({
  open: true, onClose: vi.fn(), workspaces: [OPEN, OTHER], activeId: 'p1', liveActiveNodes: null,
  statuses: {}, onFocusNode: vi.fn(), onCloseSession: vi.fn(), onSelectWorkspace: vi.fn(),
  layers: <div data-testid="layers-body" />, layerCount: 1, ...over,
})
const toggle = (title: string) => screen.getByRole('button', { name: new RegExp(`^${title}`) })
const storedCollapse = (): Record<string, boolean> => JSON.parse(localStorage.getItem('webterm.sessionsCollapsed') ?? '{}')

beforeEach(() => { localStorage.clear(); sessionsPanelWidth.reload() })
afterEach(cleanup)

describe('sections', () => {
  it('Layers sits above Sessions, both expanded by default, Layers shows its count', () => {
    render(<SessionsPanel {...props({ layerCount: 4 })} />)
    const sections = [...document.querySelectorAll('.ss-section')].map((s) => s.getAttribute('aria-label'))
    expect(sections).toEqual(['Layers', 'Sessions'])
    expect(toggle('Layers').getAttribute('aria-expanded')).toBe('true')
    expect(toggle('Sessions').getAttribute('aria-expanded')).toBe('true')
    expect(toggle('Layers').textContent).toContain('4')
    expect(screen.getByTestId('layers-body')).toBeTruthy()
  })

  it('collapse state persists and survives a remount', () => {
    const { unmount } = render(<SessionsPanel {...props()} />)
    fireEvent.click(toggle('Layers'))
    expect(screen.queryByTestId('layers-body')).toBeNull()
    expect(storedCollapse()[LAYERS_SECTION_KEY]).toBe(true)
    fireEvent.click(toggle('Sessions'))
    expect(storedCollapse()[SESSIONS_SECTION_KEY]).toBe(true)
    expect(document.querySelector('.ss-tree')).toBeNull()
    unmount()
    render(<SessionsPanel {...props()} />)
    expect(toggle('Layers').getAttribute('aria-expanded')).toBe('false')
    expect(toggle('Sessions').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle('Layers'))
    expect(screen.getByTestId('layers-body')).toBeTruthy()
    expect(storedCollapse()[LAYERS_SECTION_KEY]).toBe(false)
  })

  it('no layers slot = no Layers section', () => {
    render(<SessionsPanel {...props({ layers: undefined })} />)
    expect(document.querySelector('.ss-section--layers')).toBeNull()
  })
})

describe('Sessions without the open workspace', () => {
  it('Project view lists other workspaces only', () => {
    render(<SessionsPanel {...props()} />)
    expect(document.querySelector('vscode-tree-item[data-group="project:p2"]')).not.toBeNull()
    expect(document.querySelector('vscode-tree-item[data-group="project:p1"]')).toBeNull()
  })

  it('Status view stays cross-board', () => {
    render(<SessionsPanel {...props()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Status' }))
    const labels = [...document.querySelectorAll('vscode-tree-item')].map((i) => i.getAttribute('aria-label') ?? '')
    expect(labels.some((l) => l.startsWith('Here'))).toBe(true)
    expect(labels.some((l) => l.startsWith('There'))).toBe(true)
  })

  it('only the open workspace exists: says where other sessions will appear', () => {
    render(<SessionsPanel {...props({ workspaces: [OPEN] })} />)
    expect(screen.getByText("Other workspaces' sessions appear here.")).toBeTruthy()
    expect(screen.queryByText('No sessions yet.')).toBeNull()
  })
})

describe('minimize and resize', () => {
  it('Hide Side Bar is always in the top row and closes the column', () => {
    const onClose = vi.fn()
    render(<SessionsPanel {...props({ onClose })} />)
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

  it('the right-edge sash grows when dragged or arrowed to the right', () => {
    expect(heightAfterDrag(300, 100, 150, true)).toBe(350)
    expect(heightAfterDrag(300, 100, 150)).toBe(250) // left-edge sashes keep their sign
    vi.stubGlobal('innerWidth', 1000)
    render(<SessionsPanel {...props()} />)
    const sash = screen.getByRole('separator', { name: 'Resize Side Bar' })
    fireEvent.keyDown(sash, { key: 'ArrowRight' })
    expect(sessionsPanelWidth.current()).toBe(310)
    fireEvent.pointerDown(sash, { button: 0, clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(sash, { clientX: 340, pointerId: 1 })
    fireEvent.pointerUp(sash, { clientX: 340, pointerId: 1 })
    expect(sessionsPanelWidth.current()).toBe(350)
    vi.unstubAllGlobals()
  })
})
