/** @vitest-environment jsdom */
// Workspace tabs in the header row: order by the server's `position`, roles/ARIA, and reorder (keyboard + pointer)
// through the same API as before (`onReorder` = `putWorkspaceOrder` via `useWorkspaceOrderSave`) with rollback.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import WorkspaceBar, { type WorkspaceBarProps } from './WorkspaceBar'
import { reloadHeaderModeFromStorage } from './headerMode.store'
import { REORDER_FAILED_TITLE } from './workspaceTabs.reorder'
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

function mount(over: Partial<WorkspaceBarProps> = {}) {
  const props: WorkspaceBarProps = {
    workspaces: WS, activeId: 'w1', liveActiveNodes: [], statuses: {}, railChrome: true,
    onSelect: vi.fn(), onNewWorkspace: vi.fn(), onRenameWorkspace: vi.fn(async () => undefined), onDeleteWorkspace: vi.fn(), ...over,
  }
  const view = render(<WorkspaceBar {...props} />)
  return { ...view, props }
}
const tabs = (): HTMLElement[] => screen.getAllByRole('tab')
const names = (): string[] => tabs().map((t) => t.textContent ?? '')
const flush = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const keyMove = (el: HTMLElement, key: 'ArrowLeft' | 'ArrowRight'): void => { fireEvent.keyDown(el, { key, altKey: true, shiftKey: true }) }

describe('structure and order', () => {
  it('is a horizontal tablist named Workspaces with one tab per workspace, in `position` order, the active one selected', () => {
    mount({ activeId: 'w3' })
    expect(screen.getByRole('tablist', { name: 'Workspaces' }).getAttribute('aria-orientation')).toBe('horizontal')
    expect(names()).toEqual(['Beta', 'Gamma', 'Alpha'])
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect(tabs()[0].getAttribute('aria-label')).toBe('Workspace Beta, color blue')
  })

  it('keeps the received order when no workspace has a position yet', () => {
    mount({ workspaces: [mk('w1', 'Alpha'), mk('w2', 'Beta')] })
    expect(names()).toEqual(['Alpha', 'Beta'])
  })

  it('draws NO workspace tile anywhere: no rail group, no tile, no monogram', () => {
    const { container } = mount()
    expect(container.querySelector('.ws-rail, .ws-tile, [data-slot="workspace-tile"], [data-slot="workspace-rail"]')).toBeNull()
  })
})

describe('reorder', () => {
  it('without onReorder tabs are fixed: Alt+Shift+Arrow does nothing', () => {
    mount()
    keyMove(tabs()[0], 'ArrowRight')
    expect(names()).toEqual(['Beta', 'Gamma', 'Alpha'])
  })

  it('Alt+Shift+Right moves the tab at once, saves the full order, keeps focus on it and announces it', async () => {
    const onReorder = vi.fn(async () => undefined)
    mount({ onReorder })
    tabs()[0].focus()
    keyMove(tabs()[0], 'ArrowRight')
    await flush()
    expect(onReorder).toHaveBeenCalledWith(['w3', 'w2', 'w1'])
    expect(names()).toEqual(['Gamma', 'Beta', 'Alpha'])
    expect(document.activeElement).toBe(tabs()[1])
    expect(screen.getByRole('status').textContent).toBe('Moved Beta to position 2 of 3')
  })

  it('does not move past either end', () => {
    const onReorder = vi.fn(async () => undefined)
    mount({ onReorder })
    keyMove(tabs()[0], 'ArrowLeft')
    keyMove(tabs()[2], 'ArrowRight')
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('a failed save puts the old order back and says why (operation + cause), with Retry', async () => {
    const onReorder = vi.fn<(ids: string[]) => Promise<void>>(async () => { throw new Error('bad_order: unknown id') })
    mount({ onReorder })
    keyMove(tabs()[0], 'ArrowRight')
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
    keyMove(tabs()[0], 'ArrowRight')
    await flush()
    const server = [mk('w1', 'Alpha', 2, 'red'), mk('w2', 'Beta', 1, 'blue'), mk('w3', 'Gamma', 0, 'teal')]
    view.rerender(<WorkspaceBar {...view.props} workspaces={server} onReorder={onReorder} />)
    expect(names()).toEqual(['Gamma', 'Beta', 'Alpha'])
  })

  describe('pointer drag', () => {
    const cells = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-slot="vscode-editor-tab"]')]
    const rect = (left: number): DOMRect => ({ left, right: left + 100, top: 0, bottom: 35, width: 100, height: 35, x: left, y: 0, toJSON() {} })
    const pointer = (type: string, x: number, target: Window | Element = window): void =>
      act(() => { fireEvent(target, new MouseEvent(type, { bubbles: true, clientX: x, clientY: 10, button: 0 })) })
    const layout = (): void => cells().forEach((c, i) => { c.getBoundingClientRect = () => rect(i * 100) })

    it('dragging the first tab past the last saves the order with it last and swallows the trailing click', async () => {
      const onReorder = vi.fn(async () => undefined)
      const { props } = mount({ onReorder })
      layout()
      pointer('pointerdown', 50, tabs()[0])
      pointer('pointermove', 50 + DRAG_THRESHOLD_PX - 1)
      expect(cells()[0].getAttribute('data-dragging')).toBeNull()
      pointer('pointermove', 340)
      expect(cells()[0].getAttribute('data-dragging')).toBe('true')
      expect(cells()[2].getAttribute('data-drop')).toBe('after')
      pointer('pointerup', 340)
      // the browser fires the click on the same element right after pointerup, before any timer
      fireEvent.click(tabs()[2])
      expect(props.onSelect).not.toHaveBeenCalled()
      await flush()
      expect(onReorder).toHaveBeenCalledWith(['w3', 'w1', 'w2'])
    })

    it('Escape cancels the drag; a plain press-release is a click, not a reorder', async () => {
      const onReorder = vi.fn(async () => undefined)
      const { props } = mount({ onReorder })
      layout()
      pointer('pointerdown', 50, tabs()[0])
      pointer('pointermove', 340)
      act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
      pointer('pointerup', 340)
      await flush()
      expect(onReorder).not.toHaveBeenCalled()
      pointer('pointerdown', 50, tabs()[0])
      pointer('pointerup', 50)
      fireEvent.click(tabs()[0])
      expect(props.onSelect).toHaveBeenCalledWith('w2')
      expect(onReorder).not.toHaveBeenCalled()
    })
  })
})
