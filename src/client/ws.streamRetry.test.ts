// Locks for `scheduleStreamRetry`, the shared SSE retry schedule: full-jitter backoff while the
// socket is up, no timer at all while it is reconnecting/offline/refused, one spread reopen on the
// transition to connected, and a cancel that clears both the timer and the wait.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STREAM_REOPEN_JITTER_MS, scheduleStreamRetry, setConnection, streamPaused } from './ws.connection'

beforeEach(() => { vi.useFakeTimers(); setConnection({ phase: 'connected', attempt: 0 }) })
afterEach(() => { vi.useRealTimers() })

describe('scheduleStreamRetry', () => {
  it('waits the jittered backoff for the attempt while the socket is up', () => {
    const fn = vi.fn()
    scheduleStreamRetry(2, fn, { random: () => 0.5 }) // ceiling 1000 * 2^2 = 4000 -> 2000
    vi.advanceTimersByTime(1999)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('honours a feed cap', () => {
    const fn = vi.fn()
    scheduleStreamRetry(10, fn, { capMs: 30_000, random: () => 0.999 })
    vi.advanceTimersByTime(29_969)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it.each(['offline', 'reconnecting', 'auth'] as const)('schedules nothing while %s, then reopens once on connected', (phase) => {
    setConnection({ phase })
    expect(streamPaused()).toBe(true)
    const fn = vi.fn()
    scheduleStreamRetry(0, fn, { random: () => 0.5 })
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10 * 60_000)
    expect(fn).not.toHaveBeenCalled()
    setConnection({ phase: 'connected' })
    vi.advanceTimersByTime(STREAM_REOPEN_JITTER_MS / 2)
    expect(fn).toHaveBeenCalledTimes(1)
    setConnection({ phase: 'reconnecting' })
    setConnection({ phase: 'connected' })
    vi.advanceTimersByTime(STREAM_REOPEN_JITTER_MS)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not pause while the socket has never connected (it opens lazily)', () => {
    setConnection({ phase: 'connecting' })
    const fn = vi.fn()
    scheduleStreamRetry(0, fn, { random: () => 0.5 })
    vi.advanceTimersByTime(500)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a backoff that ends while the socket dropped waits for connected instead of reopening', () => {
    const fn = vi.fn()
    scheduleStreamRetry(0, fn, { random: () => 0.5 })
    setConnection({ phase: 'offline' })
    vi.advanceTimersByTime(60_000)
    expect(fn).not.toHaveBeenCalled()
    setConnection({ phase: 'connected' })
    vi.advanceTimersByTime(STREAM_REOPEN_JITTER_MS)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('cancel clears the pending timer and the wait for connected', () => {
    const fn = vi.fn()
    scheduleStreamRetry(0, fn)()
    setConnection({ phase: 'offline' })
    scheduleStreamRetry(0, fn)()
    setConnection({ phase: 'connected' })
    vi.advanceTimersByTime(60_000)
    expect(fn).not.toHaveBeenCalled()
  })
})
