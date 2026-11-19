/** @vitest-environment jsdom */
// Workspace tab strip follows VS Code / browser tabs: `+` right after the last tab, per-workspace
// actions on the tab (right-click / Shift+F10 menu, double-click inline rename), no far-right kebab.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import WorkspaceBar, { type WorkspaceBarProps } from './WorkspaceBar'
import { readNotifyPrefs, setWorkspaceMuted } from './osNotify.prefs'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

const ws = (id: string, name: string): Workspace =>
  ({ id, name, cwd: `/${id}`, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 0 }) // test-only

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ managed: false }))))
  setWorkspaceMuted('w1', false)
  setWorkspaceMuted('w2', false)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function mount(over: Partial<WorkspaceBarProps> = {}) {
  const props = {
    onSelect: vi.fn(), onNewWorkspace: vi.fn(), onRenameWorkspace: vi.fn(), onDeleteWorkspace: vi.fn(),
    ...over,
  }
  render(
    <WorkspaceBar
      workspaces={[ws('w1', 'laya-api'), ws('w2', 'noc')]} activeId="w1" liveActiveNodes={[]} statuses={{}}
      onToggleLayout={vi.fn()} layoutMode="canvas"
      {...props}
    />,
  )
  return props
}

const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(name) })

describe('workspace tab strip layout', () => {
  it('renders "+" right after the last tab, inside the strip, before the layout toggle', () => {
    mount()
    const plus = screen.getByRole('button', { name: 'New workspace' })
    const strip = document.querySelector('.app-tabs > .vscode-editor-tabs')!
    expect(strip.contains(plus)).toBe(true)
    const lastTab = tab('noc')
    expect(lastTab.compareDocumentPosition(plus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Not part of the tablist itself (only tabs live there).
    expect(screen.getByRole('tablist').contains(plus)).toBe(false)
    const toggle = screen.getByRole('button', { name: 'Toggle tab layout' })
    expect(plus.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(strip.contains(toggle)).toBe(false)
  })

  it('has no kebab at the far right', () => {
    mount()
    expect(screen.queryByRole('button', { name: 'Workspace options' })).toBeNull()
    expect(document.querySelector('.app-tabs .codicon-ellipsis')).toBeNull()
  })
})

describe('tab context menu', () => {
  it('right-click on a non-active tab acts on that workspace, not the active one', async () => {
    mount()
    fireEvent.contextMenu(tab('noc'), { clientX: 40, clientY: 30 })
    fireEvent.click(await screen.findByText('Mute Notifications'))
    expect(readNotifyPrefs().muted).toContain('w2')
    expect(readNotifyPrefs().muted).not.toContain('w1')
  })

  it('Rename from the menu opens the inline editor on that tab', async () => {
    const p = mount()
    fireEvent.contextMenu(tab('noc'), { clientX: 40, clientY: 30 })
    fireEvent.click(await screen.findByText('Rename'))
    const input = screen.getByRole('textbox', { name: 'Workspace name' }) as HTMLInputElement
    expect(input.value).toBe('noc')
    fireEvent.change(input, { target: { value: 'noc-2' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(p.onRenameWorkspace).toHaveBeenCalledWith('w2', 'noc-2')
  })

  it('Shift+F10 and the ContextMenu key open it on the focused tab', async () => {
    mount()
    fireEvent.keyDown(tab('noc'), { key: 'F10', shiftKey: true })
    expect(await screen.findByText('Canvas Background…')).toBeTruthy()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('Canvas Background…')).toBeNull())
    fireEvent.keyDown(tab('laya-api'), { key: 'ContextMenu' })
    expect(await screen.findByText('Canvas Background…')).toBeTruthy()
  })

  it('Delete is separated from the other items, marked destructive, and still confirms', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const p = mount()
    fireEvent.contextMenu(tab('noc'), { clientX: 40, clientY: 30 })
    const del = (await screen.findByText('Delete')).closest('[role="menuitem"]')!
    expect(del.getAttribute('data-danger')).toBe('true')
    expect(del.previousElementSibling?.getAttribute('role')).toBe('separator')
    fireEvent.click(del)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('“noc”'))
    expect(p.onDeleteWorkspace).not.toHaveBeenCalled()
  })
})

describe('inline rename', () => {
  it('double-click renames; Enter saves', async () => {
    const p = mount()
    fireEvent.doubleClick(tab('noc'))
    const input = screen.getByRole('textbox', { name: 'Workspace name' })
    fireEvent.change(input, { target: { value: '  ops  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(p.onRenameWorkspace).toHaveBeenCalledWith('w2', 'ops')
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Workspace name' })).toBeNull())
  })

  it('Escape cancels without saving (and the following blur does not save)', () => {
    const p = mount()
    fireEvent.doubleClick(tab('laya-api'))
    const input = screen.getByRole('textbox', { name: 'Workspace name' })
    fireEvent.change(input, { target: { value: 'other' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
    expect(p.onRenameWorkspace).not.toHaveBeenCalled()
    expect(tab('laya-api')).toBeTruthy()
  })

  it('shows busy while saving and keeps the editor open with the cause on failure', async () => {
    let reject!: (e: Error) => void
    mount({ onRenameWorkspace: vi.fn(() => new Promise((_, r) => { reject = r })) })
    fireEvent.doubleClick(tab('noc'))
    const input = screen.getByRole('textbox', { name: 'Workspace name' })
    fireEvent.change(input, { target: { value: 'ops' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.getAttribute('aria-busy')).toBe('true')
    await act(async () => reject(new Error('server down')))
    expect(input.getAttribute('aria-busy')).toBe('false')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('server down')
  })

  it('File > Rename Workspace… edits the active tab inline', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename Workspace…' }))
    expect((screen.getByRole('textbox', { name: 'Workspace name' }) as HTMLInputElement).value).toBe('laya-api')
  })
})
