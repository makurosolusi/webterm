/** @vitest-environment jsdom */
// Perilaku VS Code di atas pohon sesi: Home/End, type-ahead, Delete, context menu, Collapse All,
// tab pengelompokan ber-ARIA, dan ikon codicon. Event dikirim natif ke elemen item, persis jalur
// yang dipakai browser (listener dipasang native di `vscode-tree`, bukan delegasi React).
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionsPanel, { type SessionsPanelProps } from './SessionsPanel'
import SideBar from './sideBar/SideBar'
import { __resetNodeStatusForTests } from './nodeStatus.store'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { Workspace, WsNode } from '../shared/workspace'

const node = (id: string, title: string, extra: Partial<WsNode> = {}): WsNode => ({
  id,
  kind: 'terminal',
  title,
  x: 0,
  y: 0,
  ...extra,
})

const ws = (id: string, name: string, nodes: WsNode[]): Workspace => ({
  id,
  name,
  viewport: DEFAULT_VIEWPORT,
  nodes,
  bridges: [],
  updatedAt: 0,
})

const ALPHA = ws('p1', 'Alpha', [node('t1', 'Build', { cwd: '/srv/build' }), node('t2', 'Test')])
const BETA = ws('p2', 'Beta', [node('t3', 'Deploy')])
/** The open board, listed first in the Project tab (marked Current) with no sessions. */
const CURRENT = ws('p0', 'Current', [])

const baseProps = (): SessionsPanelProps => ({
  active: true,
  workspaces: [CURRENT, ALPHA, BETA],
  activeId: 'p0',
  liveActiveNodes: null,
  statuses: { t1: 'working', t2: 'done', t3: 'done' },
  onFocusNode: () => {},
  onCloseSession: () => {},
  onSelectWorkspace: () => {},
})

type TreeItemEl = HTMLElement & { open?: boolean; active?: boolean }

const item = (label: string): TreeItemEl => {
  const el = document.querySelector<TreeItemEl>(`vscode-tree-item[aria-label="${label}"]`)
  if (!el) throw new Error(`tree item "${label}" tidak ada`)
  return el
}
const group = (key: string): TreeItemEl => {
  const el = document.querySelector<TreeItemEl>(`vscode-tree-item[data-group="${key}"]`)
  if (!el) throw new Error(`group "${key}" tidak ada`)
  return el
}
/** Jsdom tidak meneruskan prop `open` ke elemen; buka semua grup seperti keadaan awal di browser. */
const openAll = () => document.querySelectorAll<TreeItemEl>('vscode-tree-item[data-group]').forEach((g) => (g.open = true))

const press = (el: Element, key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(el, { key, ...init })

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); __resetNodeStatusForTests() })

describe('navigasi keyboard pohon sesi', () => {
  it('Home dan End memindah fokus ke baris pertama dan terakhir yang terlihat', () => {
    render(<SessionsPanel {...baseProps()} />)
    openAll()

    press(item('Test — Exited'), 'Home')
    expect(group('project:p0').active).toBe(true)

    press(group('project:p1'), 'End')
    expect(item('Deploy — Exited').active).toBe(true)
  })

  it('type-ahead melompat ke baris berawalan huruf yang diketik', () => {
    render(<SessionsPanel {...baseProps()} />)
    openAll()

    press(group('project:p1'), 'd')

    expect(item('Deploy — Exited').active).toBe(true)
  })

  it('type-ahead reaches workspace headers (their label sits in .ss-ws > .ss-ws__line)', () => {
    render(<SessionsPanel {...baseProps()} />)
    openAll()

    press(item('Build — Working'), 'b')

    expect(group('project:p2').active).toBe(true)
  })

  it('Delete mengakhiri sesi dan tidak bocor ke keyboard canvas', () => {
    const onCloseSession = vi.fn()
    const leaked = vi.fn()
    document.addEventListener('keydown', leaked)
    render(<SessionsPanel {...baseProps()} onCloseSession={onCloseSession} />)

    press(item('Build — Working'), 'Delete')
    document.removeEventListener('keydown', leaked)

    expect(onCloseSession).toHaveBeenCalledWith('t1')
    expect(leaked).not.toHaveBeenCalled()
  })

  it('Backspace tanpa Cmd tidak menutup sesi, tapi tetap tidak bocor ke canvas', () => {
    const onCloseSession = vi.fn()
    const leaked = vi.fn()
    document.addEventListener('keydown', leaked)
    render(<SessionsPanel {...baseProps()} onCloseSession={onCloseSession} />)

    press(item('Build — Working'), 'Backspace')
    document.removeEventListener('keydown', leaked)

    expect(onCloseSession).not.toHaveBeenCalled()
    expect(leaked).not.toHaveBeenCalled()
  })
})

describe('context menu baris', () => {
  it('klik kanan sesi membuka menu VS Code dan End Session menutup sesinya', () => {
    const onCloseSession = vi.fn()
    render(<SessionsPanel {...baseProps()} onCloseSession={onCloseSession} />)

    fireEvent.contextMenu(item('Build — Working'))

    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Reveal on Canvas' })).toBeTruthy()
    // p1 is not the open board, so its node cannot be renamed from here.
    expect(screen.getByRole('menuitem', { name: 'Rename…' }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'End Session' }))

    expect(onCloseSession).toHaveBeenCalledWith('t1')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Copy Path menyalin cwd sesi', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<SessionsPanel {...baseProps()} />)

    fireEvent.contextMenu(item('Build — Working'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Path' }))

    expect(writeText).toHaveBeenCalledWith('/srv/build')
  })

  it('menu grup workspace menawarkan Switch to Workspace dan melipat lewat Collapse', () => {
    const onSelectWorkspace = vi.fn()
    render(<SessionsPanel {...baseProps()} onSelectWorkspace={onSelectWorkspace} />)
    group('project:p2').open = true

    fireEvent.contextMenu(group('project:p2'))
    expect(screen.getByRole('menuitem', { name: 'Collapse' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to Workspace' }))

    expect(onSelectWorkspace).toHaveBeenCalledWith('p2')
  })

  it('Shift+F10 membuka menu untuk baris terfokus', () => {
    render(<SessionsPanel {...baseProps()} />)

    press(item('Build — Working'), 'F10', { shiftKey: true })

    expect(screen.getByRole('menu')).toBeTruthy()
  })
})

describe('chrome sidebar', () => {
  it('Collapse All melipat semua grup dan dipersist di kunci yang sama', () => {
    render(<SessionsPanel {...baseProps()} />)

    fireEvent.click(screen.getByLabelText('Collapse all'))

    expect(JSON.parse(localStorage.getItem('webterm.sessionsCollapsed') ?? '{}')).toEqual({
      'project:p0': true,
      'project:p1': true,
      'project:p2': true,
    })
  })

  it('tab pengelompokan: tablist ber-ARIA, roving tabindex, panah memindah tab', () => {
    render(<SessionsPanel {...baseProps()} />)

    expect(screen.getByRole('tablist', { name: 'Group sessions by' })).toBeTruthy()
    const project = screen.getByRole('tab', { name: 'Project' })
    expect(project.getAttribute('aria-selected')).toBe('true')
    expect(project.tabIndex).toBe(0)
    expect(screen.getByRole('tab', { name: 'Status' }).tabIndex).toBe(-1)

    press(project, 'ArrowRight')

    expect(screen.getByRole('tab', { name: 'Status' }).getAttribute('aria-selected')).toBe('true')
  })

  it('ikon memakai codicon, tanpa svg lucide', () => {
    render(<SessionsPanel {...baseProps()} />)

    expect(document.querySelector('.codicon-terminal')).not.toBeNull()
    expect(document.querySelector('.codicon-trash')).not.toBeNull()
    expect(document.querySelector('.codicon-collapse-all')).not.toBeNull()
    expect(document.querySelector('.sessions-view svg')).toBeNull()
  })

  it('Collapse all sits in the side bar title row (VS Code view title), next to Hide Side Bar', () => {
    render(<SideBar open view="sessions" onClose={() => {}} layers={null} history={null} skills={null} sessions={<SessionsPanel {...baseProps()} />} />)
    const head = document.querySelector('.sessions-sidebar__head')
    expect(head?.querySelector('[aria-label="Collapse all"]')).not.toBeNull()
    expect(document.querySelector('.sessions-view__toolbar [aria-label="Collapse all"]')).toBeNull()
  })

  it('boot (no workspace hydrated yet) shows no "No sessions yet"; an empty board offers New Terminal / New Agent', () => {
    render(<SessionsPanel {...baseProps()} workspaces={[]} />)
    expect(screen.queryByText(/No sessions yet/)).toBeNull()

    cleanup()
    const onAddTerminal = vi.fn()
    const onAddAgent = vi.fn()
    render(<SessionsPanel {...baseProps()} workspaces={[CURRENT]} liveActiveNodes={[]} onAddTerminal={onAddTerminal} onAddAgent={onAddAgent} />)
    expect(screen.getByText(/No sessions yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New Terminal' }))
    fireEvent.click(screen.getByRole('button', { name: 'New Agent' }))
    expect(onAddTerminal).toHaveBeenCalledTimes(1)
    expect(onAddAgent).toHaveBeenCalledTimes(1)

    cleanup()
    render(<SessionsPanel {...baseProps()} />)
    fireEvent.change(screen.getByLabelText('Filter sessions'), { target: { value: 'zzz' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear Filter' }))
    expect((screen.getByLabelText('Filter sessions') as HTMLInputElement).value).toBe('')
  })
})
