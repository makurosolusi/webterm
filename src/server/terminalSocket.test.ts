// Locks for the terminal WebSocket guards (pty-207-4): output backpressure with resync on drain,
// and the ping/pong heartbeat. Fake socket + fake timers; no network.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import { WS_DROP_BYTES, WS_HEARTBEAT_MS, WS_LOW_BYTES, WS_RESYNC_SWEEP_MS, serveTerminalSocket } from './terminalSocket'

type Handler = (...args: unknown[]) => void

class FakeSocket {
  readonly OPEN = 1
  readyState = 1
  bufferedAmount = 0
  readonly sent: ServerMsg[] = []
  pings = 0
  terminated = 0
  private handlers = new Map<string, Handler>()
  send(data: string): void { this.sent.push(JSON.parse(data) as ServerMsg) }
  ping(): void { this.pings++ }
  terminate(): void { this.terminated++ }
  on(event: string, cb: Handler): this { this.handlers.set(event, cb); return this }
  fire(event: string, ...args: unknown[]): void { this.handlers.get(event)?.(...args) }
}

function serve() {
  const ws = new FakeSocket()
  let send: ((m: ServerMsg) => void) | undefined
  const resynced: string[] = []
  const sessions = {
    handle: vi.fn((_msg: unknown, s: (m: ServerMsg) => void) => { send = s }),
    detach: vi.fn(),
    resync: vi.fn((id: string, s: (m: ServerMsg) => void) => { resynced.push(id); s({ t: 'reset', id, epoch: 'e' }) }),
  }
  const hub = { watch: vi.fn(), unwatch: vi.fn(), dropClient: vi.fn() }
  serveTerminalSocket(ws as never, { sessions: sessions as never, fsWatchHub: hub as never, watchOn: () => false, clients: () => 1 })
  ws.fire('message', JSON.stringify({ t: 'open', id: 'n1', cols: 80, rows: 24 }))
  return { ws, sessions, hub, resynced, send: (m: ServerMsg) => send!(m) }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('backpressure', () => {
  test('over the cap a terminal gets no more output, but status/exit still go out', () => {
    const { ws, send } = serve()
    ws.bufferedAmount = WS_DROP_BYTES + 1
    send({ t: 'output', id: 'n1', data: 'dropped', seq: 1 })
    ws.bufferedAmount = WS_DROP_BYTES - 1 // still lagging until resynced: no gap may be painted over
    send({ t: 'output', id: 'n1', data: 'also dropped', seq: 2 })
    send({ t: 'status', id: 'n1' })
    expect(ws.sent.map((m) => m.t)).toEqual(['status'])
  })

  test('once drained, a lagging terminal is resynced exactly once and output flows again', () => {
    const { ws, send, resynced } = serve()
    ws.bufferedAmount = WS_DROP_BYTES + 1
    send({ t: 'output', id: 'n1', data: 'x', seq: 1 })
    vi.advanceTimersByTime(WS_RESYNC_SWEEP_MS)
    expect(resynced).toEqual([])
    ws.bufferedAmount = WS_LOW_BYTES
    vi.advanceTimersByTime(WS_RESYNC_SWEEP_MS)
    vi.advanceTimersByTime(WS_RESYNC_SWEEP_MS * 4)
    expect(resynced).toEqual(['n1'])
    send({ t: 'output', id: 'n1', data: 'y', seq: 2 })
    expect(ws.sent.map((m) => m.t)).toEqual(['reset', 'output'])
  })

  test('a terminal that exits while lagging is not resynced', () => {
    const { ws, send, resynced } = serve()
    ws.bufferedAmount = WS_DROP_BYTES + 1
    send({ t: 'output', id: 'n1', data: 'x', seq: 1 })
    send({ t: 'exit', id: 'n1', code: 0 })
    ws.bufferedAmount = 0
    vi.advanceTimersByTime(WS_RESYNC_SWEEP_MS)
    expect(resynced).toEqual([])
  })
})

describe('heartbeat', () => {
  test('a socket that answers pings stays; one that misses a pong is terminated', () => {
    const { ws } = serve()
    vi.advanceTimersByTime(WS_HEARTBEAT_MS)
    expect(ws.pings).toBe(1)
    ws.fire('pong')
    vi.advanceTimersByTime(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(0)
    expect(ws.pings).toBe(2)
    vi.advanceTimersByTime(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(1)
  })

  test('close stops the heartbeat and drops every subscription of the socket', () => {
    const { ws, sessions, hub } = serve()
    ws.fire('close', 1006, Buffer.from(''))
    vi.advanceTimersByTime(WS_HEARTBEAT_MS * 3)
    expect(ws.pings).toBe(0)
    expect(sessions.detach).toHaveBeenCalledTimes(1)
    expect(hub.dropClient).toHaveBeenCalledTimes(1)
  })
})
