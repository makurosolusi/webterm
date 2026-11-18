/** @vitest-environment jsdom */
// Pure pieces of the split view: drop zones, quick device sizes, the separator (mouse, keyboard, ARIA) and the shortcut table.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../vscode/test-setup'
import { MIN_PANE_PX } from '../../shared/browser.layout'
import { paneLayout } from '../paneTree'
import { BrowserSeparator, ratioBounds } from './BrowserSeparator'
import { EDGE_SHARE, dropZoneAt, paneHitAt, zoneBox } from './browserSplit.drop'
import { QUICK_SIZES, THREE_SIZES, deviceButtonLabel, quickSizeOf, sizeIndicator } from './browserSplit.devices'
import { splitShortcut } from './useBrowserSplitShortcuts'

afterEach(cleanup)
const box = { left: 100, top: 50, width: 400, height: 200 }

describe('drop zones', () => {
  it('the outer quarter of a side is an edge zone, the middle is "center"', () => {
    expect(EDGE_SHARE).toBe(0.25)
    expect(dropZoneAt(box, 110, 150)).toBe('left')
    expect(dropZoneAt(box, 490, 150)).toBe('right')
    expect(dropZoneAt(box, 300, 55)).toBe('top')
    expect(dropZoneAt(box, 300, 245)).toBe('bottom')
    expect(dropZoneAt(box, 300, 150)).toBe('center')
  })
  it('in a corner the nearest edge wins; an unmeasured pane is center', () => {
    expect(dropZoneAt(box, 102, 60)).toBe('left') // 0.005 from the left, 0.05 from the top
    expect(dropZoneAt(box, 200, 52)).toBe('top')
    expect(dropZoneAt({ left: 0, top: 0, width: 0, height: 0 }, 5, 5)).toBe('center')
  })
  it('previews the half the new pane would take', () => {
    expect(zoneBox('right')).toEqual({ left: '50%', top: '0%', width: '50%', height: '100%' })
    expect(zoneBox('top')).toMatchObject({ height: '50%', top: '0%' })
    expect(zoneBox('center')).toMatchObject({ width: '100%', height: '100%' })
  })
  it('finds the pane under the pointer, null elsewhere', () => {
    const pane = document.createElement('div')
    pane.dataset.paneTab = 'tab-x'
    pane.getBoundingClientRect = () => ({ ...box, right: 500, bottom: 250, x: 100, y: 50, toJSON: () => ({}) })
    document.body.appendChild(pane)
    const at = vi.fn(() => pane as Element)
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: at }) // jsdom has no layout, so no hit testing
    expect(paneHitAt(495, 150)).toEqual({ paneTabId: 'tab-x', zone: 'right' })
    at.mockReturnValue(document.body)
    expect(paneHitAt(5, 5)).toBeNull()
    delete (document as { elementFromPoint?: unknown }).elementFromPoint
    pane.remove()
  })
})

describe('quick device sizes', () => {
  it('lists Mobile 390, Tablet 768, Laptop 1280, Desktop 1920 and the 3 sizes are mobile/tablet/desktop', () => {
    expect(QUICK_SIZES.map((q) => [q.label, q.width])).toEqual([['Mobile', 390], ['Tablet', 768], ['Laptop', 1280], ['Desktop', 1920]])
    expect(THREE_SIZES.map((q) => q.id)).toEqual(['mobile', 'tablet', 'desktop'])
  })
  it('recognises the choice a quick size made (and not a rotated one)', () => {
    expect(quickSizeOf({ id: 'ipad-mini' })?.id).toBe('tablet')
    expect(quickSizeOf({ id: 'ipad-mini', landscape: true })).toBeUndefined()
    expect(quickSizeOf({ id: 'custom', w: 390, h: 844, dpr: 2 })?.id).toBe('mobile')
    expect(quickSizeOf(null)).toBeUndefined()
  })
  it('the corner shows the emulated size, else the measured pane size, else nothing', () => {
    expect(sizeIndicator({ id: 'custom', w: 390, h: 844, dpr: 2 }, { w: 500, h: 300 })).toBe('390 × 844')
    expect(sizeIndicator(null, { w: 500.4, h: 300 })).toBe('500 × 300')
    expect(sizeIndicator(undefined, null)).toBe('')
    expect(deviceButtonLabel(null)).toMatch(/Responsive/)
    expect(deviceButtonLabel({ id: 'ipad-mini' })).toMatch(/iPad Mini/)
  })
})

describe('shortcut table', () => {
  const k = (code: string, extra: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra })
  it('Ctrl+\\ (Cmd on a Mac) splits right; Ctrl/Cmd+Alt+Arrow moves the focus', () => {
    expect(splitShortcut(k('Backslash', { ctrlKey: true }), false)).toEqual({ kind: 'splitRight' })
    expect(splitShortcut(k('Backslash', { metaKey: true }), true)).toEqual({ kind: 'splitRight' })
    expect(splitShortcut(k('ArrowLeft', { ctrlKey: true, altKey: true }), false)).toEqual({ kind: 'focus', dir: 'left' })
    expect(splitShortcut(k('ArrowDown', { metaKey: true, altKey: true }), true)).toEqual({ kind: 'focus', dir: 'down' })
  })
  it('leaves everything else to the page: no modifier, the wrong platform key, Shift, plain arrows', () => {
    expect(splitShortcut(k('Backslash'), false)).toBeNull()
    expect(splitShortcut(k('Backslash', { metaKey: true }), false)).toBeNull()
    expect(splitShortcut(k('Backslash', { ctrlKey: true }), true)).toBeNull()
    expect(splitShortcut(k('Backslash', { ctrlKey: true, shiftKey: true }), false)).toBeNull()
    expect(splitShortcut(k('ArrowLeft', { ctrlKey: true }), false)).toBeNull()
    expect(splitShortcut(k('ArrowLeft', { altKey: true }), false)).toBeNull()
  })
})

describe('ratioBounds', () => {
  it('keeps both sides at least MIN_PANE_PX, and never crosses on a tiny branch', () => {
    expect(ratioBounds(1000)).toEqual({ min: MIN_PANE_PX / 1000, max: 1 - MIN_PANE_PX / 1000 })
    expect(ratioBounds(300)).toEqual({ min: 0.5, max: 0.5 })
    expect(ratioBounds(0)).toEqual({ min: 0.1, max: 0.9 })
    expect(ratioBounds(10_000).min).toBe(0.1) // the global floor still applies on a huge node
  })
})

describe('separator', () => {
  const tree = paneLayout({ dir: 'h', ratio: 0.4, a: { id: 'a' }, b: { id: 'b' } })
  const vtree = paneLayout({ dir: 'v', ratio: 0.5, a: { id: 'a' }, b: { id: 'b' } })
  const host = () => ({ clientWidth: 1000, clientHeight: 500, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 }) }) as unknown as HTMLElement
  const setup = (d = tree.dividers[0], ratio = 0.4) => {
    const fns = { onRatio: vi.fn(), onCommit: vi.fn(), onReset: vi.fn() }
    render(<BrowserSeparator divider={d} ratio={ratio} host={host} {...fns} />)
    return { sep: screen.getByRole('separator'), ...fns }
  }

  it('is a labelled, focusable splitter with its value', () => {
    const { sep } = setup()
    expect(sep.getAttribute('aria-orientation')).toBe('vertical') // side-by-side panes: a vertical bar
    expect(sep.getAttribute('aria-valuenow')).toBe('40')
    expect(sep.getAttribute('aria-valuemin')).toBe('10')
    expect(sep.getAttribute('aria-valuemax')).toBe('90')
    expect(sep.getAttribute('aria-label')).toMatch(/Resize panes/)
    expect(sep.tabIndex).toBe(0)
  })
  it('stacked panes get a horizontal bar', () => {
    const { sep } = setup(vtree.dividers[0], 0.5)
    expect(sep.getAttribute('aria-orientation')).toBe('horizontal')
  })
  it('arrow keys move a little, Shift+arrow a lot, each saved', () => {
    const { sep, onRatio, onCommit } = setup()
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    expect(onRatio).toHaveBeenLastCalledWith('', expect.closeTo(0.42, 5))
    fireEvent.keyDown(sep, { key: 'ArrowLeft', shiftKey: true })
    expect(onRatio).toHaveBeenLastCalledWith('', expect.closeTo(0.3, 5))
    expect(onCommit).toHaveBeenCalledTimes(2)
  })
  it('stacked panes answer Up/Down, not Left/Right', () => {
    const { sep, onRatio } = setup(vtree.dividers[0], 0.5)
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    expect(onRatio).not.toHaveBeenCalled()
    fireEvent.keyDown(sep, { key: 'ArrowDown' })
    expect(onRatio).toHaveBeenLastCalledWith('', expect.closeTo(0.52, 5))
  })
  it('Home and End jump to the smallest and largest allowed ratio (min pane width)', () => {
    const { sep, onRatio } = setup()
    fireEvent.keyDown(sep, { key: 'Home' })
    expect(onRatio).toHaveBeenLastCalledWith('', MIN_PANE_PX / 1000)
    fireEvent.keyDown(sep, { key: 'End' })
    expect(onRatio).toHaveBeenLastCalledWith('', 1 - MIN_PANE_PX / 1000)
  })
  it('never goes below the minimum pane size, even with arrows', () => {
    const { sep, onRatio } = setup(tree.dividers[0], MIN_PANE_PX / 1000)
    fireEvent.keyDown(sep, { key: 'ArrowLeft', shiftKey: true })
    expect(onRatio).toHaveBeenLastCalledWith('', MIN_PANE_PX / 1000)
  })
  it('double-click and Enter reset to 50/50', () => {
    const { sep, onReset } = setup()
    fireEvent.doubleClick(sep)
    fireEvent.keyDown(sep, { key: 'Enter' })
    expect(onReset).toHaveBeenCalledTimes(2)
    expect(onReset).toHaveBeenCalledWith('')
  })
  it('dragging follows the pointer, clamps to the minimum size, and saves once on release', () => {
    const { sep, onRatio, onCommit } = setup()
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 400, clientY: 100 })
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 700, clientY: 100 })
    expect(onRatio).toHaveBeenLastCalledWith('', 0.7)
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 20, clientY: 100 })
    expect(onRatio).toHaveBeenLastCalledWith('', MIN_PANE_PX / 1000)
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.pointerUp(sep, { pointerId: 1 })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })
})
