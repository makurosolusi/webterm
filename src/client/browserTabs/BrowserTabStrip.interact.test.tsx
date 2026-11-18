/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRAG_THRESHOLD_PX, POP_OUT_DISTANCE_PX, reorderTarget, slotAt } from './browserTabs.drag'
import { makeState, makeTab, renderStrip } from './browserTabsHarness'

const tabs = () => screen.getAllByRole('tab')
const tab = (id: string) => tabs().find((t) => t.getAttribute('data-tab-id') === id) as HTMLElement
const openMenu = (id: string) => fireEvent.contextMenu(tab(id), { clientX: 10, clientY: 20 })
const item = (name: string) => screen.getByRole('menuitem', { name })

afterEach(() => { vi.unstubAllGlobals() })

describe('context menu', () => {
  it('lists the specified actions in order', () => {
    renderStrip(makeState(['a', 'b']))
    openMenu('a')
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent?.replace(/(Ctrl\+W|\u2318W)$/, ''))).toEqual([
      'New tab to the right', 'Duplicate', 'Reload', 'Close', 'Close others', 'Close to the right', 'Pop out to its own node', 'Copy URL',
    ])
  })

  it.each([
    ['New tab to the right', { type: 'new', newTabId: 'new1', afterTabId: 'b' }],
    ['Duplicate', { type: 'duplicate', tabId: 'b', newTabId: 'new1' }],
    ['Reload', { type: 'reload', tabId: 'b' }],
    ['Close', { type: 'close', tabId: 'b' }],
    ['Close others', { type: 'closeOthers', tabId: 'b' }],
    ['Close to the right', { type: 'closeToRight', tabId: 'b' }],
    ['Pop out to its own node', { type: 'popOut', tabId: 'b' }],
  ])('%s calls back exactly once with the right action', (name, expected) => {
    const { onAction } = renderStrip(makeState(['a', 'b', 'c']))
    openMenu('b')
    fireEvent.click(item(name))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith(expected)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Copy URL writes the tab URL to the clipboard and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { onNotice } = renderStrip(makeState(['a', 'b']))
    openMenu('b')
    fireEvent.click(item('Copy URL'))
    expect(writeText).toHaveBeenCalledWith('https://b.example.com/page')
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith('URL copied'))
  })

  it('Copy URL reports a clipboard failure instead of swallowing it', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    const { onNotice } = renderStrip(makeState(['a']))
    openMenu('a')
    fireEvent.click(item('Copy URL'))
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith('Could not copy the URL: denied'))
  })

  it('disables what cannot run, with the reason', () => {
    const { onAction } = renderStrip(makeState(['a']))
    openMenu('a')
    expect(item('Close others').getAttribute('aria-disabled')).toBe('true')
    expect(item('Close to the right').getAttribute('aria-disabled')).toBe('true')
    expect(item('Pop out to its own node').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(item('Pop out to its own node'))
    expect(onAction).not.toHaveBeenCalled()
  })

  it('disables New tab to the right and Duplicate at the limit with the limit reason', () => {
    renderStrip(makeState(Array.from({ length: 8 }, (_, i) => `t${i}`)))
    openMenu('t3')
    expect(item('Duplicate').getAttribute('aria-disabled')).toBe('true')
    expect(item('Duplicate').getAttribute('title')).toBe('Tab limit (8) reached')
    expect(item('New tab to the right').getAttribute('aria-disabled')).toBe('true')
  })

  it('disables Reload and Copy URL on a blank tab', () => {
    renderStrip(makeState([], { tabs: [makeTab('a', { url: 'about:blank', title: '' }), makeTab('b')], activeTabId: 'a' }))
    openMenu('a')
    expect(item('Reload').getAttribute('aria-disabled')).toBe('true')
    expect(item('Copy URL').getAttribute('aria-disabled')).toBe('true')
  })
})

describe('mouse', () => {
  it('middle-click closes the tab', () => {
    const { onAction } = renderStrip(makeState(['a', 'b']))
    fireEvent(tab('b'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    expect(onAction).toHaveBeenCalledWith({ type: 'close', tabId: 'b' })
  })

  it('double-click on empty strip opens a tab; on a tab it does not', () => {
    const { onAction, container } = renderStrip(makeState(['a']))
    fireEvent.doubleClick(tab('a'))
    expect(onAction).not.toHaveBeenCalled()
    fireEvent.doubleClick(container.querySelector('[data-strip-empty]') as HTMLElement)
    expect(onAction).toHaveBeenCalledWith({ type: 'new', newTabId: 'new1', afterTabId: undefined })
  })

  it('double-click on empty strip at the limit says why instead of opening', () => {
    const { onAction, onNotice, container } = renderStrip(makeState(Array.from({ length: 8 }, (_, i) => `t${i}`)))
    fireEvent.doubleClick(container.querySelector('[data-strip-empty]') as HTMLElement)
    expect(onAction).not.toHaveBeenCalled()
    expect(onNotice).toHaveBeenCalledWith('Tab limit (8) reached')
  })
})

describe('drag to reorder', () => {
  const pointer = (type: string, x: number, y = 16, target: Window | Element = window) =>
    act(() => { fireEvent(target, new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })) })
  /** Three 100px tabs at x 0..300 and a strip 0..32 high. */
  function layout(container: HTMLElement) {
    tabs().forEach((t, i) => { t.getBoundingClientRect = () => ({ left: i * 100, right: i * 100 + 100, top: 0, bottom: 32, width: 100, height: 32, x: i * 100, y: 0, toJSON() {} }) })
    const strip = container.querySelector('.bt-strip') as HTMLElement
    strip.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 32, width: 300, height: 32, x: 0, y: 0, toJSON() {} })
  }

  it('geometry helpers', () => {
    const rects = [{ left: 0, right: 100 }, { left: 100, right: 200 }, { left: 200, right: 300 }]
    expect([10, 60, 160, 290].map((x) => slotAt(rects, x))).toEqual([0, 1, 2, 3])
    expect(reorderTarget(0, 3)).toBe(2)
    expect(reorderTarget(2, 0)).toBe(0)
    expect(reorderTarget(1, 2)).toBe(1)
  })

  it('dragging the first tab past the last reorders it to the end', () => {
    const { onAction, container } = renderStrip(makeState(['a', 'b', 'c']))
    layout(container)
    pointer('pointerdown', 50, 16, tab('a'))
    pointer('pointermove', 50 + DRAG_THRESHOLD_PX - 1)
    expect(tab('a').getAttribute('data-dragging')).toBeNull() // below the threshold it is still a click
    pointer('pointermove', 290)
    expect(tab('a').getAttribute('data-dragging')).toBe('true')
    expect(tab('c').getAttribute('data-drop')).toBe('after')
    pointer('pointerup', 290)
    expect(onAction).toHaveBeenCalledWith({ type: 'reorder', tabId: 'a', toIndex: 2 })
    expect(tab('c').getAttribute('data-drop')).toBeNull()
  })

  it('the click after a drag does not activate; a plain click still does', async () => {
    const { onAction, container } = renderStrip(makeState(['a', 'b', 'c']))
    layout(container)
    pointer('pointerdown', 50, 16, tab('a'))
    pointer('pointermove', 290)
    pointer('pointerup', 290)
    fireEvent.click(tab('a'))
    expect(onAction.mock.calls.filter(([a]) => a.type === 'activate')).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 5))
    fireEvent.click(tab('a'))
    expect(onAction).toHaveBeenLastCalledWith({ type: 'activate', tabId: 'a' })
  })

  it('releasing where the tab already is changes nothing; Escape cancels', () => {
    const { onAction, container } = renderStrip(makeState(['a', 'b', 'c']))
    layout(container)
    pointer('pointerdown', 150, 16, tab('b'))
    pointer('pointermove', 160)
    pointer('pointerup', 160)
    expect(onAction).not.toHaveBeenCalled()
    pointer('pointerdown', 50, 16, tab('a'))
    pointer('pointermove', 290)
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
    pointer('pointerup', 290)
    expect(onAction).not.toHaveBeenCalled()
  })

  it('releasing far below the strip pops the tab out', () => {
    const { onAction, container } = renderStrip(makeState(['a', 'b', 'c']))
    layout(container)
    pointer('pointerdown', 150, 16, tab('b'))
    pointer('pointermove', 150, 32 + POP_OUT_DISTANCE_PX + 10)
    expect(container.querySelector('.bt-strip')?.hasAttribute('data-popout-armed')).toBe(true)
    pointer('pointerup', 150, 32 + POP_OUT_DISTANCE_PX + 10)
    expect(onAction).toHaveBeenCalledWith({ type: 'popOut', tabId: 'b' })
  })

  it('pressing the close button never starts a drag', () => {
    const { onAction, container } = renderStrip(makeState(['a', 'b', 'c']))
    layout(container)
    pointer('pointerdown', 50, 16, screen.getByRole('button', { name: 'Close Title a' }))
    pointer('pointermove', 290)
    pointer('pointerup', 290)
    expect(onAction).not.toHaveBeenCalled()
  })
})

describe('styles', () => {
  const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'browserTabs.css'), 'utf8')
  it('sizes tabs from the --bui tokens (Chrome: 36px row, 112-220px tabs) and honours reduced motion', () => {
    const ui = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'browserUi.css'), 'utf8')
    expect(ui).toMatch(/--bui-tab-h:\s*36px/)
    expect(ui).toMatch(/--bui-tab-min-w:\s*112px/)
    expect(ui).toMatch(/--bui-tab-max-w:\s*220px/)
    expect(css).toMatch(/min-width:\s*var\(--bui-tab-min-w\)/)
    expect(css).toMatch(/max-width:\s*var\(--bui-tab-max-w\)/)
    expect(css).toMatch(/\.bt-strip \{[^}]*height: var\(--bui-tab-h\)/)
    expect(css).toMatch(/\.bt-tab \{[^}]*font: var\(--bui-font\)/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.bt-spinner[\s\S]*bt-pulse/)
    // 16px icon inside a 24px close target; tab icon and agent marker use the icon token.
    expect(css).toMatch(/\.bt-close \{[^}]*width: var\(--bui-close\); height: var\(--bui-close\)/)
    expect(css).toMatch(/\.bt-icon \{[^}]*width: var\(--bui-icon\)/)
    expect(css).toMatch(/\.bt-agent \{[^}]*width: var\(--bui-icon\)/)
    expect(ui).toMatch(/--bui-close:\s*24px/)
  })
  it('focus is a 2px token outline on tabs', () => {
    expect(css).toMatch(/\.bt-tab:focus-visible \{[^}]*outline: var\(--bui-focus\)/)
  })
  it('uses theme tokens only: no hex colours', () => {
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull()
  })
})
