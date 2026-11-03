import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWaker, WAKE_DEBOUNCE_MS, WAKE_SWEEP_MS } from './wake'

afterEach(() => vi.useRealTimers())

function setup() {
  vi.useFakeTimers()
  const calls: string[] = []
  const waker = createWaker({ onWake: (reason) => { calls.push(reason) } })
  return { calls, waker }
}

describe('waker', () => {
  it('coalesces a burst into one callback after exactly 250 ms', () => {
    const { calls, waker } = setup()
    waker.start()
    waker.wake('a')
    vi.advanceTimersByTime(100)
    waker.wake('b')
    vi.advanceTimersByTime(WAKE_DEBOUNCE_MS - 101)
    expect(calls).toEqual([])
    expect(waker.pending).toBe(true)
    vi.advanceTimersByTime(1)
    expect(calls).toEqual(['a'])
    expect(waker.pending).toBe(false)
    waker.wake('c')
    vi.advanceTimersByTime(WAKE_DEBOUNCE_MS)
    expect(calls).toEqual(['a', 'c'])
    waker.stop()
  })

  it('sweeps every 60 s as a safety net even without wakes', () => {
    const { calls, waker } = setup()
    waker.start()
    vi.advanceTimersByTime(WAKE_SWEEP_MS - 1)
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
    vi.advanceTimersByTime(WAKE_SWEEP_MS)
    expect(calls).toEqual(['sweep', 'sweep'])
    waker.stop()
  })

  it('stop() clears the sweep and a pending debounce, and later wakes are ignored', () => {
    const { calls, waker } = setup()
    waker.start()
    waker.start()
    expect(vi.getTimerCount()).toBe(1)
    waker.wake('x')
    expect(vi.getTimerCount()).toBe(2)
    waker.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(waker.running).toBe(false)
    waker.wake('late')
    vi.advanceTimersByTime(WAKE_SWEEP_MS * 2)
    expect(calls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    waker.stop()
  })

  it('ignores wake() before start()', () => {
    const { calls, waker } = setup()
    waker.wake('early')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(WAKE_DEBOUNCE_MS)
    expect(calls).toEqual([])
  })

  it('survives a throwing or rejecting handler and keeps sweeping', async () => {
    vi.useFakeTimers()
    let n = 0
    const waker = createWaker({
      onWake: () => {
        n++
        if (n === 1) throw new Error('boom')
        return Promise.reject(new Error('later'))
      },
    })
    waker.start()
    vi.advanceTimersByTime(WAKE_SWEEP_MS * 2)
    await Promise.resolve()
    expect(n).toBe(2)
    expect(waker.running).toBe(true)
    waker.stop()
  })
})
