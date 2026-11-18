/** @vitest-environment jsdom */
// Rail workspace tiles: roles/ARIA, order by `position`, roving tabindex and keys, the shared menu and
// rename, "All workspaces" when the group overflows, and reorder (keyboard + pointer) with rollback.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import WorkspaceBar from './WorkspaceBar'
import { WorkspaceRail, type WorkspaceRailProps } from './WorkspaceRail'
import { reloadHeaderModeFromStorage } from './headerMode.store'
import { REORDER_FAILED_TITLE } from './workspaceRail.reorder'
import { ACTION_NOTICE_KEY, closeNotice } from './workspaceSave.notice'
import { DRAG_THRESHOLD_PX } from './browserSplit/browserSplit.dnd'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

const mk = (id: string, name: string, position?: number, color?: string): Workspace =>
  ({ id, name, cwd: `/${id}`, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 0, color, colorShade: 'default', ...(position === undefined ? {} : { position }) }) as Workspace // test-only
const WS = [mk('w1', 'Alpha', 2, 'red'), mk('w2', 'Beta', 0, 'blue'), mk('w3', 'Gamma', 1, 'teal')] // position order: Beta, Gamma, Alpha

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ managed: false }))))
  localStorage.clear()
  reloadHeaderModeFromStorage()
})
afterEach(() => { cleanup(); closeNotice(ACTION_NOTICE_KEY); vi.unstubAllGlobals() })

type Over = Partial<WorkspaceRailProps> & { mode?: 'full' | 'compact' | 'hidden'; workspaces?: Workspace[] }
function mount(over: Over = {}) {
  const { mode = 'compact', workspaces = WS, ...rail } = over
  const props = {
    workspaces, activeId: 'w1', liveActiveNodes: [], statuses: {}, onSelect: vi.fn(), onRenameWorkspace: vi.fn(async () => undefined), ...rail,
  }
  const view = render(
    <>
      <WorkspaceBar {...props} headerMode={mode} onNewWorkspace={vi.fn()} onDeleteWorkspace={vi.fn()} onSetWorkspaceColor={vi.fn()} />
      {mode !== 'full' && <WorkspaceRail {...props} />}
    </>,
  )
  return { ...view, props }
}
const tiles = (): HTMLElement[] => screen.getAllByRole('tab')
const names = (): string[] => tiles().map((t) => t.querySelector('.ws-tile__name')?.textContent ?? '')

describe('structure and ARIA', () => {
  it('is a vertical tablist named Workspaces with one tab per workspace, in `position` order', () => {
    mount()
    const list = screen.getByRole('tablist', { name: 'Workspaces' })
    expect(list.getAttribute('aria-orientation')).toBe('vertical')
    expect(names()).toEqual(['Beta', 'Gamma', 'Alpha'])
  })

  it('marks the active workspace (aria-selected, data-active) and names every tile with workspace, color and status', () => {
    mount({ activeId: 'w3' })
    expect(tiles().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect(tiles()[1].getAttribute('data-active')).toBe('true')
    expect(tiles()[0].getAttribute('aria-label')).toBe('Workspace Beta, color blue')
    expect(tiles()[0].getAttribute('aria-controls')).toBe('workspace-canvas')
  })

  it('draws the tile fill from the workspace color token and the monogram from the name', () => {
    mount()
    expect(tiles()[0].style.getPropertyValue('--ws-tile')).toBe('var(--ws-blue-default)')
    expect(tiles()[0].querySelector('.ws-tile__mono')?.textContent).toContain('B')
  })

  it('the active workspace cell is the sticky one; the others are not', () => {
    const { container } = mount({ activeId: 'w3' })
    expect([...container.ownerDocument.querySelectorAll('.ws-rail__cell')].map((c) => c.getAttribute('data-active'))).toEqual(['false', 'true', 'false'])
  })

  it('keeps the received order when no workspace has a position yet', () => {
    mount({ workspaces: [mk('w1', 'Alpha'), mk('w2', 'Beta')] })
    expect(names()).toEqual(['Alpha', 'Beta'])
  })
})

describe('keyboard', () => {
  it('has exactly one Tab stop (the active tile) and roves with Arrow/Home/End, wrapping', () => {
    mount({ activeId: 'w3' })
    expect(tiles().map((t) => t.tabIndex)).toEqual([-1, 0, -1])
    tiles()[1].focus()
    fireEvent.keyDown(tiles()[1], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(tiles()[2])
    expect(tiles().map((t) => t.tabIndex)).toEqual([-1, -1, 0])
    fireEvent.keyDown(tiles()[2], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(tiles()[0])
    fireEvent.keyDown(tiles()[0], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(tiles()[2])
    fireEvent.keyDown(tiles()[2], { key: 'Home' })
    expect(document.activeElement).toBe(tiles()[0])
    fireEvent.keyDown(tiles()[0], { key: 'End' })
    expect(document.activeElement).toBe(tiles()[2])
  })

  it('Enter and Space activate; click activates; moving focus alone does not', () => {
    const { props } = mount()
    tiles()[0].focus()
    fireEvent.keyDown(tiles()[0], { key: 'ArrowDown' })
    expect(props.onSelect).not.toHaveBeenCalled()
    fireEvent.keyDown(tiles()[1], { key: 'Enter' })
    expect(props.onSelect).toHaveBeenLastCalledWith('w3')
    fireEvent.keyDown(tiles()[2], { key: ' ' })
    expect(props.onSelect).toHaveBeenLastCalledWith('w1')
    fireEvent.click(tiles()[0])
    expect(props.onSelect).toHaveBeenLastCalledWith('w2')
  })
})

describe('menu, rename and new workspace share the header hosts', () => {
  /** Rows of the opened context menu (the header's own menubar items are not part of it). */
  const rowsOf = (): string[] => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '').filter((t) => !['File', 'View', 'Help', 'Menu'].includes(t))

  it('right-click, Shift+F10 and the Menu key open the very menu the Full tab strip opens', () => {
    const full = mount({ mode: 'full' })
    fireEvent.contextMenu(screen.getAllByRole('tab')[0])
    const fullRows = rowsOf()
    expect(fullRows).toEqual(expect.arrayContaining(['Rename', 'Canvas Background…', 'Color…', 'Mute Notifications', 'Delete']))
    full.unmount()
    for (const open of [
      (t: HTMLElement) => fireEvent.contextMenu(t),
      (t: HTMLElement) => fireEvent.keyDown(t, { key: 'F10', shiftKey: true }),
      (t: HTMLElement) => fireEvent.keyDown(t, { key: 'ContextMenu' }),
    ]) {
      const view = mount()
      open(tiles()[0])
      expect(rowsOf()).toEqual(fullRows)
      view.unmount()
    }
  })

  it('the menu acts on the tile it was opened from, not the active workspace', () => {
    const { props } = mount({ activeId: 'w1' })
    fireEvent.contextMenu(tiles()[0])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Canvas Background…' }))
    expect(props.onSelect).toHaveBeenCalledWith('w2')
  })

  it('F2 and double-click open the same rename field; Enter commits the trimmed name for that workspace', async () => {
    const { props } = mount()
    fireEvent.keyDown(tiles()[1], { key: 'F2' })
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: '  Gamma 2 ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(props.onRenameWorkspace).toHaveBeenCalledWith('w3', 'Gamma 2'))
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
    fireEvent.doubleClick(tiles()[0])
    expect(await screen.findByRole('textbox')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
  })

  it('the + button opens the same three-row menu as the strip', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'New workspace' }))
    expect(rowsOf()).toEqual(['Open Folder…', 'Clone Repository…', 'New Project…'])
  })
})

describe('overflow: by fit, not by count', () => {
  /** Simulates a rail too short for its tiles: the group scrolls. */
  function squeeze(fits: boolean): void {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(fits ? 100 : 300)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
  }
  afterEach(() => vi.restoreAllMocks())

  it('shows no All workspaces button while every tile fits, whatever the count', () => {
    squeeze(true)
    mount()
    expect(screen.queryByRole('button', { name: 'All workspaces' })).toBeNull()
  })

  it('shows All workspaces when tiles do not fit; it lists every workspace, filters and switches', async () => {
    squeeze(false)
    const { props } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'All workspaces' }))
    const dialog = await screen.findByRole('dialog', { name: 'All workspaces' })
    const options = within(dialog).getAllByRole('option').map((o) => o.textContent ?? '')
    expect(options.map((o) => ['Beta', 'Gamma', 'Alpha', 'New workspace…'].some((n) => o.includes(n)))).toEqual([true, true, true, true])
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'gam' } })
    const filtered = within(dialog).getAllByRole('option')
    expect(filtered).toHaveLength(1)
    fireEvent.click(filtered[0])
    expect(props.onSelect).toHaveBeenCalledWith('w3')
  })

  it('"New workspace…" in All workspaces opens the + menu', async () => {
    squeeze(false)
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'All workspaces' }))
    const dialog = await screen.findByRole('dialog', { name: 'All workspaces' })
    fireEvent.click(within(dialog).getByRole('option', { name: /New workspace/ }))
    expect(await screen.findByRole('menuitem', { name: 'Clone Repository…' })).toBeTruthy()
  })
})

describe('reorder', () => {
  const flush = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

  it('without onReorder tiles are read-only: Alt+Shift+Arrow does nothing', () => {
    mount()
    fireEvent.keyDown(tiles()[0], { key: 'ArrowDown', altKey: true, shiftKey: true })
    expect(names()).toEqual(['Beta', 'Gamma', 'Alpha'])
  })

  it('Alt+Shift+Down moves the tile at once, saves the full order, keeps focus on it and announces it', async () => {
    const onReorder = vi.fn(async () => undefined)
    mount({ onReorder })
    tiles()[0].focus()
    fireEvent.keyDown(tiles()[0], { key: 'ArrowDown', altKey: true, shiftKey: true })
    await flush()
    expect(onReorder).toHaveBeenCalledWith(['w3', 'w2', 'w1'])
    expect(names()).toEqual(['Gamma', 'Beta', 'Alpha'])
    expect(document.activeElement).toBe(tiles()[1])
    expect(screen.getByRole('status').textContent).toBe('Moved Beta to position 2 of 3')
  })

  it('does not move past either end', () => {
    const onReorder = vi.fn(async () => undefined)
    mount({ onReorder })
    fireEvent.keyDown(tiles()[0], { key: 'ArrowUp', altKey: true, shiftKey: true })
    fireEvent.keyDown(tiles()[2], { key: 'ArrowDown', altKey: true, shiftKey: true })
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('a failed save puts the old order back and says why (operation + cause), with Retry', async () => {
    const onReorder = vi.fn<(ids: string[]) => Promise<void>>(async () => { throw new Error('bad_order: unknown id') })
    mount({ onReorder })
    fireEvent.keyDown(tiles()[0], { key: 'ArrowDown', altKey: true, shiftKey: true })
    await flush()
    await waitFor(() => expect(names()).toEqual(['Beta', 'Gamma', 'Alpha']))
    expect(await screen.findByText(REORDER_FAILED_TITLE)).toBeTruthy()
    expect(screen.getByText(/bad_order: unknown id/)).toBeTruthy()
    onReorder.mockResolvedValueOnce(undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await flush()
    expect(names()).toEqual(['Gamma', 'Beta', 'Alpha'])
  })

  it('the server order arriving (new positions) replaces the optimistic one', async () => {
    const onReorder = vi.fn(async () => undefined)
    const view = mount({ onReorder })
    fireEvent.keyDown(tiles()[0], { key: 'ArrowDown', altKey: true, shiftKey: true })
    await flush()
    const server = [mk('w1', 'Alpha', 2, 'red'), mk('w2', 'Beta', 1, 'blue'), mk('w3', 'Gamma', 0, 'teal')]
    view.rerender(<WorkspaceRail {...view.props} workspaces={server} onReorder={onReorder} />)
    expect(names()).toEqual(['Gamma', 'Beta', 'Alpha'])
  })

  describe('pointer drag', () => {
    const rect = (top: number): DOMRect => ({ left: 0, right: 48, top, bottom: top + 36, width: 48, height: 36, x: 0, y: top, toJSON() {} })
    const pointer = (type: string, y: number, target: Window | Element = window): void =>
      act(() => { fireEvent(target, new MouseEvent(type, { bubbles: true, clientX: 20, clientY: y, button: 0 })) })
    const layout = (): void => tiles().forEach((t, i) => { t.getBoundingClientRect = () => rect(i * 36) })

    it('dragging the first tile below the last saves the order with it last and swallows the trailing click', async () => {
      const onReorder = vi.fn(async () => undefined)
      const { props } = mount({ onReorder })
      layout()
      pointer('pointerdown', 18, tiles()[0])
      pointer('pointermove', 18 + DRAG_THRESHOLD_PX - 1)
      expect(tiles()[0].getAttribute('data-dragging')).toBeNull()
      pointer('pointermove', 100)
      expect(tiles()[0].getAttribute('data-dragging')).toBe('true')
      expect(tiles()[2].getAttribute('data-drop')).toBe('after')
      pointer('pointerup', 100)
      // the browser fires the click on the same element right after pointerup, before any timer
      fireEvent.click(tiles()[2])
      expect(props.onSelect).not.toHaveBeenCalled()
      await flush()
      expect(onReorder).toHaveBeenCalledWith(['w3', 'w1', 'w2'])
    })

    it('Escape cancels the drag; a plain press-release is a click, not a reorder', async () => {
      const onReorder = vi.fn(async () => undefined)
      const { props } = mount({ onReorder })
      layout()
      pointer('pointerdown', 18, tiles()[0])
      pointer('pointermove', 100)
      act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
      pointer('pointerup', 100)
      await flush()
      expect(onReorder).not.toHaveBeenCalled()
      pointer('pointerdown', 18, tiles()[0])
      pointer('pointerup', 18)
      fireEvent.click(tiles()[0])
      expect(props.onSelect).toHaveBeenCalledWith('w2')
      expect(onReorder).not.toHaveBeenCalled()
    })
  })
})
