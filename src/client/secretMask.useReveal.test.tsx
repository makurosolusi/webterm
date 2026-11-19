/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MaskScan } from './secretMask.reveal'
import { useSecretReveal } from './secretMask.useReveal'

const mk = (n: number): MaskScan => ({ fileWide: false, truncated: false, ranges: Array.from({ length: n }, (_, i) => ({ from: i * 2, to: i * 2 + 1, kind: 'k' })) })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

function setup(scan: MaskScan, autoHideSec = 30) {
  return renderHook((p: { scan: MaskScan; sec: number }) =>
    useSecretReveal({ scan: p.scan, autoHideSec: p.sec, enabled: true }), { initialProps: { scan, sec: autoHideSec } })
}

describe('useSecretReveal', () => {
  it('starts hidden and reveals per value / all', () => {
    const { result } = setup(mk(3))
    expect(result.current.masked).toBe(3)
    act(() => result.current.revealIndex(1))
    expect(result.current.masked).toBe(2)
    act(() => result.current.revealAll())
    expect(result.current.masked).toBe(0)
    act(() => result.current.hideAll())
    expect(result.current.masked).toBe(3)
  })
  it('auto-hides after 30s and a new reveal restarts the timer', () => {
    const { result } = setup(mk(2))
    act(() => result.current.revealIndex(0))
    act(() => { vi.advanceTimersByTime(20_000) })
    act(() => result.current.revealIndex(1))
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(result.current.masked).toBe(0)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(result.current.masked).toBe(2)
  })
  it('autoHideSec=0 never hides', () => {
    const { result } = setup(mk(1), 0)
    act(() => result.current.revealAll())
    act(() => { vi.advanceTimersByTime(3_600_000) })
    expect(result.current.masked).toBe(0)
  })
  it('resets when scan changes', () => {
    const { result, rerender } = setup(mk(2))
    act(() => result.current.revealAll())
    rerender({ scan: mk(2), sec: 30 })
    expect(result.current.masked).toBe(2)
  })
  it('disabled never reveals', () => {
    const { result } = renderHook(() => useSecretReveal({ scan: mk(1), autoHideSec: 30, enabled: false }))
    act(() => result.current.revealAll())
    expect(result.current.masked).toBe(1)
  })
  it.each([
    ['blur', () => window.dispatchEvent(new Event('blur'))],
    ['Escape', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))],
    ['tab hidden', () => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
    }],
  ])('hides on %s', (_n, fire) => {
    const { result } = setup(mk(2))
    act(() => result.current.revealAll())
    act(() => { fire() })
    expect(result.current.masked).toBe(2)
  })
  it('other keys do not hide; listeners only exist while revealed and are removed', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const { result, unmount } = setup(mk(1))
    expect(add).not.toHaveBeenCalledWith('blur', expect.anything())
    act(() => result.current.revealAll())
    expect(add).toHaveBeenCalledWith('blur', expect.anything())
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })) })
    expect(result.current.masked).toBe(0)
    unmount()
    expect(remove).toHaveBeenCalledWith('blur', expect.anything())
    expect(remove).toHaveBeenCalledWith('keydown', expect.anything())
    expect(vi.getTimerCount()).toBe(0)
  })
})
