import { describe, expect, it, vi } from 'vitest'
import { OPEN_SIZE_FALLBACK_MS, canOpenSession, coalesceFrames, sizeChanged } from './terminalSizing'

describe('sizeChanged', () => {
  it('always sends the first size', () => {
    expect(sizeChanged(null, { cols: 80, rows: 24 })).toBe(true)
  })
  it('skips an identical size and sends when either axis differs', () => {
    const last = { cols: 100, rows: 30 }
    expect(sizeChanged(last, { cols: 100, rows: 30 })).toBe(false)
    expect(sizeChanged(last, { cols: 101, rows: 30 })).toBe(true)
    expect(sizeChanged(last, { cols: 100, rows: 29 })).toBe(true)
  })
})

describe('canOpenSession', () => {
  it('waits while unsized, opens once sized or once the fallback elapsed', () => {
    expect(canOpenSession(false, false)).toBe(false)
    expect(canOpenSession(true, false)).toBe(true)
    expect(canOpenSession(false, true)).toBe(true)
    expect(OPEN_SIZE_FALLBACK_MS).toBeGreaterThan(0)
  })
})

describe('coalesceFrames', () => {
  function fakeRaf() {
    const cbs = new Map<number, () => void>()
    let n = 0
    return {
      raf: (cb: () => void) => { cbs.set(++n, cb); return n },
      caf: (id: number) => { cbs.delete(id) },
      flush: () => { const all = [...cbs.values()]; cbs.clear(); all.forEach((c) => c()) },
    }
  }

  it('runs once per frame however many times it is scheduled', () => {
    const f = fakeRaf()
    const fn = vi.fn()
    const c = coalesceFrames(fn, f.raf, f.caf)
    c.schedule(); c.schedule(); c.schedule()
    expect(fn).not.toHaveBeenCalled()
    f.flush()
    expect(fn).toHaveBeenCalledTimes(1)
    c.schedule()
    f.flush()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('cancel drops the pending frame', () => {
    const f = fakeRaf()
    const fn = vi.fn()
    const c = coalesceFrames(fn, f.raf, f.caf)
    c.schedule()
    c.cancel()
    f.flush()
    expect(fn).not.toHaveBeenCalled()
  })
})
