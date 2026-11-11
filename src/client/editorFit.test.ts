import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIT_MAX_COLS, fitNodeWidth, fitRefusal, fitWidth, longestVisibleCols, type FitInput } from './editorFit'
import { setNodeResizeLocked } from './nodeResize/nodeResize.store'

// test-only: 8px chars, 50px gutter, 14px scrollbar, 2px chrome, wide viewport at zoom 1.
const BASE: FitInput = { cols: 80, charWidth: 8, chrome: 2, contentLeft: 50, reserved: 14, minWidth: 320, viewportWidth: 4000, zoom: 1 }
const SLACK = 16
const widthFor = (cols: number) => 2 + 50 + cols * 8 + 14 + SLACK

afterEach(() => setNodeResizeLocked(false))

describe('fitWidth', () => {
  it('fits the longest line exactly, chrome + gutter + columns + scrollbar', () => {
    expect(fitWidth(BASE)).toBe(widthFor(80))
  })
  it('never goes below the node minimum', () => {
    expect(fitWidth({ ...BASE, cols: 3 })).toBe(320)
  })
  it(`caps a minified line at ${FIT_MAX_COLS} columns`, () => {
    expect(fitWidth({ ...BASE, cols: 5000 })).toBe(widthFor(FIT_MAX_COLS))
  })
  it('caps at the visible canvas width, measured in flow units at the current zoom', () => {
    expect(fitWidth({ ...BASE, viewportWidth: 600 })).toBe(600)
    expect(fitWidth({ ...BASE, viewportWidth: 600, zoom: 0.5 })).toBe(widthFor(80)) // 1200 flow units visible
    expect(fitWidth({ ...BASE, viewportWidth: 600, zoom: 2 })).toBe(320) // 300 visible, the minimum still wins
  })
})

const model = (lines: string[]) => ({ getOptions: () => ({ tabSize: 4 }), getLineContent: (l: number) => lines[l - 1] })

describe('longestVisibleCols', () => {
  it('reads only the visible lines and expands tabs', () => {
    const ed = { getModel: () => model(['short', '\tab', 'x'.repeat(300)]), getVisibleRanges: () => [{ startLineNumber: 1, endLineNumber: 2 }] }
    expect(longestVisibleCols(ed as never)).toBe(6) // '\tab' = 4 + 2
  })
  it('is 0 without a model', () => {
    expect(longestVisibleCols({ getModel: () => null, getVisibleRanges: () => [] } as never)).toBe(0)
  })
})

describe('fitNodeWidth', () => {
  const editor = {
    getModel: () => model(['x'.repeat(100)]),
    getVisibleRanges: () => [{ startLineNumber: 1, endLineNumber: 1 }],
    getLayoutInfo: () => ({ width: 398, contentLeft: 50, minimap: { minimapWidth: 0 }, verticalScrollbarWidth: 14 }),
  }
  const store = (width = 400) => ({
    nodeLookup: new Map([['n1', { measured: { width, height: 300 } }]]),
    transform: [0, 0, 1], width: 4000, triggerNodeChanges: vi.fn(),
  })

  it('sends one settled width change and keeps the height', () => {
    const s = store()
    expect(fitNodeWidth(s as never, 'n1', editor as never, 8, 320)).toBe(true)
    expect(s.triggerNodeChanges).toHaveBeenCalledWith([{ id: 'n1', type: 'dimensions', resizing: false, setAttributes: 'width', dimensions: { width: widthFor(100), height: 300 } }])
  })
  it('does nothing when the width already fits', () => {
    const s = store(widthFor(100))
    expect(fitNodeWidth(s as never, 'n1', { ...editor, getLayoutInfo: () => ({ ...editor.getLayoutInfo(), width: widthFor(100) - 2 }) } as never, 8, 320)).toBe(false)
    expect(s.triggerNodeChanges).not.toHaveBeenCalled()
  })
})

describe('fitRefusal', () => {
  it('refuses with wrap on, and while the view is locked', () => {
    expect(fitRefusal(true)).toBe('Word wrap is on')
    expect(fitRefusal(false)).toBeNull()
    setNodeResizeLocked(true)
    expect(fitRefusal(false)).toBe('The view is locked')
  })
})
