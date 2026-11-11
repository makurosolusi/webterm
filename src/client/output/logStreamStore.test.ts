import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LOG_CLIENT_CAP, clearLogStream, getLogStreamState, setLogStreamLevel, subscribeLogStream,
} from './logStreamStore'
import { FakeEventSource, installFakeLogServer, makeEntry } from './outputTestKit'
import { STREAM_REOPEN_JITTER_MS, setConnection } from '../ws.connection'

const settle = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

let unsubscribe: (() => void) | null = null
beforeEach(() => { vi.useFakeTimers(); setConnection({ phase: 'connected', attempt: 0 }) })
afterEach(() => {
  unsubscribe?.()
  unsubscribe = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function open(): Promise<void> {
  unsubscribe = subscribeLogStream(() => undefined)
  await settle()
}

describe('logStreamStore', () => {
  it('backfills, then streams from the last seq and ignores replays', async () => {
    installFakeLogServer([
      makeEntry(1, { level: 'error', channel: 'pty' }), makeEntry(2, { level: 'warn', channel: 'auth' }),
    ])
    await open()
    const source = FakeEventSource.last()
    expect(source.url).toBe('/api/logs/stream?afterSeq=2')
    source.open()
    source.send(makeEntry(2))
    source.send(makeEntry(3, { channel: 'pty' }))
    source.sendRaw('not json')
    const state = getLogStreamState()
    expect(state.entries.map((entry) => entry.seq)).toEqual([1, 2, 3])
    expect(state.counts).toEqual({ error: 1, warn: 1 })
    expect(state.channels).toEqual([{ channel: 'auth', count: 1 }, { channel: 'pty', count: 2 }])
    expect(state.connection).toBe('open')
  })

  it('reconnects with backoff, re-running the backfill from the last seq', async () => {
    const server = installFakeLogServer([makeEntry(1)])
    await open()
    FakeEventSource.last().open()
    FakeEventSource.last().fail()
    expect(getLogStreamState().connection).toBe('closed')
    server.entries.push(makeEntry(2))
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(server.calls.at(-1)?.url).toBe('/api/logs?afterSeq=1&limit=2000')
    expect(FakeEventSource.last().url).toBe('/api/logs/stream?afterSeq=2')
    expect(getLogStreamState().entries.map((entry) => entry.seq)).toEqual([1, 2])
  })

  it('retries after a failed backfill', async () => {
    const server = installFakeLogServer([makeEntry(1)])
    server.failNext = true
    await open()
    expect(getLogStreamState().connection).toBe('closed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(getLogStreamState().entries).toHaveLength(1)
  })

  it('rebuilds the buffer when the server restarted (seq went backwards)', async () => {
    const server = installFakeLogServer([makeEntry(1), makeEntry(2), makeEntry(3)])
    await open()
    FakeEventSource.last().fail()
    server.entries = [makeEntry(1, { message: 'after restart' })]
    await vi.advanceTimersByTimeAsync(1000)
    expect(getLogStreamState().entries.map((entry) => entry.message)).toEqual(['after restart'])
  })

  it('clear calls DELETE /api/logs and empties the buffer', async () => {
    const server = installFakeLogServer([makeEntry(1, { level: 'error' })])
    await open()
    await clearLogStream()
    expect(server.calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/logs' })
    expect(getLogStreamState().entries).toEqual([])
    expect(getLogStreamState().counts.error).toBe(0)
  })

  it('setLevel calls PUT /api/logs/level and updates the level', async () => {
    const server = installFakeLogServer()
    await open()
    await setLogStreamLevel('debug')
    expect(server.calls.at(-1)).toMatchObject({ method: 'PUT', url: '/api/logs/level', body: { level: 'debug' } })
    expect(getLogStreamState().level).toBe('debug')
  })

  it('closes the connection and resets state when the last subscriber leaves', async () => {
    installFakeLogServer([makeEntry(1)])
    await open()
    const source = FakeEventSource.last()
    unsubscribe?.()
    unsubscribe = null
    expect(source.closed).toBe(true)
    expect(getLogStreamState().entries).toEqual([])
  })

  it('keeps only the newest LOG_CLIENT_CAP entries and adjusts the derived counts', async () => {
    const total = LOG_CLIENT_CAP + 3
    installFakeLogServer(Array.from({ length: total }, (_, i) =>
      makeEntry(i + 1, i < 3 ? { level: 'error', channel: 'old' } : {})))
    await open()
    const state = getLogStreamState()
    expect(state.entries).toHaveLength(LOG_CLIENT_CAP)
    expect(state.entries[0]!.seq).toBe(4)
    expect(state.counts.error).toBe(0)
    expect(state.channels).toEqual([{ channel: 'pty', count: LOG_CLIENT_CAP }])
  })

  it('shares one connection between subscribers', async () => {
    installFakeLogServer([makeEntry(1)])
    await open()
    const second = subscribeLogStream(() => undefined)
    await settle()
    expect(FakeEventSource.instances).toHaveLength(1)
    second()
  })

  it('schedules no retry while the shared socket is offline, then reopens from the same cursor', async () => {
    const server = installFakeLogServer([makeEntry(1), makeEntry(2)])
    await open()
    setConnection({ phase: 'offline' })
    FakeEventSource.last().fail()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(FakeEventSource.instances).toHaveLength(1)
    const backfills = server.calls.length
    setConnection({ phase: 'connected' })
    await vi.advanceTimersByTimeAsync(STREAM_REOPEN_JITTER_MS)
    expect(server.calls.length).toBe(backfills + 1)
    expect(server.calls.at(-1)?.url).toBe('/api/logs?afterSeq=2&limit=2000')
    expect(FakeEventSource.last().url).toBe('/api/logs/stream?afterSeq=2')
    expect(getLogStreamState().entries.map((entry) => entry.seq)).toEqual([1, 2])
  })

  it('uses the jittered backoff', async () => {
    installFakeLogServer([makeEntry(1)])
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    await open()
    FakeEventSource.last().fail()
    await vi.advanceTimersByTimeAsync(499)
    expect(FakeEventSource.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeEventSource.instances).toHaveLength(2)
    vi.mocked(Math.random).mockRestore()
  })

  it('the last unsubscribe cancels a retry still waiting for the socket', async () => {
    const server = installFakeLogServer([makeEntry(1)])
    await open()
    setConnection({ phase: 'reconnecting' })
    FakeEventSource.last().fail()
    unsubscribe?.()
    unsubscribe = null
    const calls = server.calls.length
    setConnection({ phase: 'connected' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.calls.length).toBe(calls)
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})
