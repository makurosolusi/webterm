/** @vitest-environment jsdom */
// Activity feed reconnect: jittered backoff from the shared schedule, no retry while the shared
// socket is down, one reopen from the same `afterSeq` cursor on connected, and unmount cancels.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// test-only: the stream rides the shared socket in the app; here it is the stubbed global EventSource fake.
vi.mock('./ws', async (orig) => ({ ...(await orig<typeof import('./ws')>()), openEventStream: (url: string) => new (globalThis as unknown as { EventSource: new (u: string) => unknown }).EventSource(url) }))
import { STREAM_REOPEN_JITTER_MS, setConnection } from './ws.connection'

const status = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('./Timeline.status', () => status)

import { useTimelineFeed } from './Timeline.stream'

// test-only: a controllable EventSource
class FakeSource {
  static all: FakeSource[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {}
  closed = false
  constructor(public url: string) { FakeSource.all.push(this) }
  addEventListener(type: string, fn: (e: MessageEvent) => void) { (this.listeners[type] ??= []).push(fn) }
  send(seq: number) { for (const fn of this.listeners.sense ?? []) fn({ data: JSON.stringify({ seq, kind: 'pty.spawn', ts: seq }) } as MessageEvent) }
  close() { this.closed = true }
}

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })

beforeEach(() => {
  vi.useFakeTimers()
  FakeSource.all = []
  vi.stubGlobal('EventSource', FakeSource)
  setConnection({ phase: 'connected', attempt: 0 })
  status.getJson.mockResolvedValue({ events: [{ seq: 3, kind: 'pty.spawn', ts: 3 }], more: false })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('useTimelineFeed reconnect', () => {
  it('waits for the shared socket while offline, then reopens once from the last seq', async () => {
    const { result } = renderHook(() => useTimelineFeed(true))
    await flush()
    const first = FakeSource.all[0]!
    expect(first.url).toBe('/api/events/stream?afterSeq=3')
    act(() => { first.onopen?.(); first.send(4) })
    setConnection({ phase: 'offline' })
    act(() => first.onerror?.())
    expect(first.closed).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
    expect(FakeSource.all).toHaveLength(1)
    act(() => setConnection({ phase: 'connected' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_REOPEN_JITTER_MS) })
    expect(FakeSource.all).toHaveLength(2)
    expect(FakeSource.all[1]!.url).toBe('/api/events/stream?afterSeq=4')
    expect(status.getJson).toHaveBeenCalledTimes(1) // history is not refetched on reconnect
    act(() => FakeSource.all[1]!.send(4)) // replayed frame merges, no duplicate row
    expect(result.current.events.map((e) => e.seq)).toEqual([3, 4])
  })

  it('uses the jittered backoff', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    renderHook(() => useTimelineFeed(true))
    await flush()
    act(() => FakeSource.all[0]!.onerror?.())
    await act(async () => { await vi.advanceTimersByTimeAsync(499) })
    expect(FakeSource.all).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(FakeSource.all).toHaveLength(2)
  })

  it('unmount cancels a retry waiting for the socket', async () => {
    const { unmount } = renderHook(() => useTimelineFeed(true))
    await flush()
    setConnection({ phase: 'reconnecting' })
    act(() => FakeSource.all[0]!.onerror?.())
    unmount()
    setConnection({ phase: 'connected' })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(FakeSource.all).toHaveLength(1)
  })
})
