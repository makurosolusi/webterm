import { describe, expect, it, vi } from 'vitest'
import { OPEN_SIZE_FALLBACK_MS, canOpenSession, coalesceFrames, sizeChanged, watchVisible } from './terminalSizing'

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

describe('watchVisible', () => {
  // Fake IntersectionObserver: the test drives the entries by hand.
  function fakeIO() {
    const inst: { cb: IntersectionObserverCallback; observed: Element[]; disconnected: boolean }[] = []
    class IO {
      constructor(cb: IntersectionObserverCallback) { inst.push({ cb, observed: [], disconnected: false }) }
      observe(el: Element) { inst[inst.length - 1].observed.push(el) }
      disconnect() { inst[inst.length - 1].disconnected = true }
    }
    const fire = (isIntersecting: boolean) =>
      inst[0].cb([{ isIntersecting } as IntersectionObserverEntry], inst[0] as unknown as IntersectionObserver)
    return { IO: IO as unknown as typeof IntersectionObserver, inst, fire }
  }

  it('starts visible, tracks entries, and calls onShown only on the hidden -> visible edge', () => {
    const { IO, inst, fire } = fakeIO()
    const el = ({}) as Element
    const onShown = vi.fn()
    const w = watchVisible(el, onShown, IO)
    expect(inst[0].observed).toEqual([el])
    expect(w.visible).toBe(true)
    fire(true) // already visible: not an edge
    expect(onShown).not.toHaveBeenCalled()
    fire(false)
    expect(w.visible).toBe(false)
    expect(onShown).not.toHaveBeenCalled()
    fire(true)
    expect(w.visible).toBe(true)
    expect(onShown).toHaveBeenCalledTimes(1)
  })

  it('stop() disconnects the observer', () => {
    const { IO, inst } = fakeIO()
    watchVisible(({}) as Element, () => {}, IO).stop()
    expect(inst[0].disconnected).toBe(true)
  })

  it('without IntersectionObserver it stays visible and never throws', () => {
    const onShown = vi.fn()
    const w = watchVisible(({}) as Element, onShown, undefined)
    expect(w.visible).toBe(true)
    w.stop()
    expect(onShown).not.toHaveBeenCalled()
  })
})
