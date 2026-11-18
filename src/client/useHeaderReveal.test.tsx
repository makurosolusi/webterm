/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REVEAL_DWELL_MS, REVEAL_EDGE_PX, REVEAL_HIDE_MS, useHeaderReveal } from './useHeaderReveal'

const move = (clientY: number, over: Element = document.body, buttons = 0): void => {
  act(() => { over.dispatchEvent(new MouseEvent('pointermove', { clientY, buttons, bubbles: true })) })
}
const tick = (ms: number): void => { act(() => { vi.advanceTimersByTime(ms) }) }

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('useHeaderReveal', () => {
  it('reveals only after the dwell at the top edge', () => {
    const { result } = renderHook(() => useHeaderReveal(true))
    move(REVEAL_EDGE_PX)
    tick(REVEAL_DWELL_MS - 1)
    expect(result.current).toBe(false)
    tick(1)
    expect(result.current).toBe(true)
  })

  it('does not reveal below the edge, when the pointer leaves the edge during the dwell, or with a button held', () => {
    const { result } = renderHook(() => useHeaderReveal(true))
    move(REVEAL_EDGE_PX + 1)
    tick(REVEAL_DWELL_MS * 2)
    expect(result.current).toBe(false)
    move(0)
    tick(REVEAL_DWELL_MS - 50)
    move(40) // left the edge: the dwell restarts from nothing
    tick(REVEAL_DWELL_MS * 2)
    expect(result.current).toBe(false)
    move(0, document.body, 1) // a drag to the very top (node, pane, selection)
    tick(REVEAL_DWELL_MS * 2)
    expect(result.current).toBe(false)
  })

  it('hides REVEAL_HIDE_MS after the pointer left the header, and not while it is inside', () => {
    document.body.innerHTML = '<div data-header-region><button id="in">x</button></div><main id="canvas"></main>'
    const inside = document.getElementById('in') as HTMLElement
    const canvas = document.getElementById('canvas') as HTMLElement
    const { result } = renderHook(() => useHeaderReveal(true))
    move(0)
    tick(REVEAL_DWELL_MS)
    expect(result.current).toBe(true)
    move(20, inside)
    tick(REVEAL_HIDE_MS * 3)
    expect(result.current).toBe(true) // pointer inside the header
    move(200, canvas)
    tick(REVEAL_HIDE_MS - 1)
    expect(result.current).toBe(true)
    tick(1)
    expect(result.current).toBe(false)
  })

  it('coming back to the header before the hide timer fires keeps it open', () => {
    document.body.innerHTML = '<div data-header-region><span id="in"></span></div><main id="canvas"></main>'
    const { result } = renderHook(() => useHeaderReveal(true))
    move(0)
    tick(REVEAL_DWELL_MS)
    move(200, document.getElementById('canvas') as HTMLElement)
    tick(REVEAL_HIDE_MS - 100)
    move(10, document.getElementById('in') as HTMLElement)
    tick(REVEAL_HIDE_MS * 2)
    expect(result.current).toBe(true)
  })

  it('stays open while a menu is open or focus is inside the header, and hides after', () => {
    document.body.innerHTML = '<div data-header-region><button id="m" aria-expanded="true">File</button></div><main id="canvas"></main>'
    const menu = document.getElementById('m') as HTMLElement
    const { result } = renderHook(() => useHeaderReveal(true))
    move(0)
    tick(REVEAL_DWELL_MS)
    move(300, document.getElementById('canvas') as HTMLElement)
    tick(REVEAL_HIDE_MS * 2)
    expect(result.current).toBe(true) // aria-expanded: a menu is open
    menu.setAttribute('aria-expanded', 'false')
    move(301, document.getElementById('canvas') as HTMLElement)
    tick(REVEAL_HIDE_MS)
    expect(result.current).toBe(false)
    // focus inside also holds it open
    move(0)
    tick(REVEAL_DWELL_MS)
    expect(result.current).toBe(true)
    menu.focus()
    move(300, document.getElementById('canvas') as HTMLElement)
    tick(REVEAL_HIDE_MS * 2)
    expect(result.current).toBe(true)
  })

  it('a menu opened from the header (role=menu, outside the region) counts as inside', () => {
    document.body.innerHTML = '<div role="menu"><button id="item">Open</button></div><main id="canvas"></main>'
    const { result } = renderHook(() => useHeaderReveal(true))
    move(0)
    tick(REVEAL_DWELL_MS)
    move(120, document.getElementById('item') as HTMLElement)
    tick(REVEAL_HIDE_MS * 3)
    expect(result.current).toBe(true)
  })

  it('never reveals while disabled, and closes when disabled', () => {
    const { result, rerender } = renderHook(({ on }) => useHeaderReveal(on), { initialProps: { on: false } })
    move(0)
    tick(REVEAL_DWELL_MS * 2)
    expect(result.current).toBe(false)
    rerender({ on: true })
    move(0)
    tick(REVEAL_DWELL_MS)
    expect(result.current).toBe(true)
    rerender({ on: false })
    expect(result.current).toBe(false)
  })

  it('uses no element: nothing is added to the document, so there is nothing to take a click', () => {
    const { result } = renderHook(() => useHeaderReveal(true))
    const before = document.body.innerHTML // after renderHook's own host container
    move(0)
    tick(REVEAL_DWELL_MS)
    expect(result.current).toBe(true)
    expect(document.body.innerHTML).toBe(before)
  })
})
