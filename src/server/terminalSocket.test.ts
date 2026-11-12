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

function serve(identity?: { bootId: string; build: string }) {
  const ws = new FakeSocket()
  let send: ((m: ServerMsg) => void) | undefined
  const resynced: string[] = []
  const sessions = {
    handle: vi.fn((_msg: unknown, s: (m: ServerMsg) => void) => { send = s }),
    detach: vi.fn(),
    resync: vi.fn((id: string, s: (m: ServerMsg) => void) => { resynced.push(id); s({ t: 'reset', id, epoch: 'e' }) }),
  }
  const hub = { watch: vi.fn(), unwatch: vi.fn(), dropClient: vi.fn() }
  serveTerminalSocket(ws as never, { sessions: sessions as never, fsWatchHub: hub as never, watchOn: () => false, clients: () => 1, identity })
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

describe('app-level heartbeat and hello', () => {
  test('a ping is answered with a pong of the same id and never reaches the sessions', () => {
    const { ws, sessions } = serve()
    sessions.handle.mockClear()
    ws.fire('message', JSON.stringify({ t: 'ping', id: '7' }))
    expect(ws.sent).toEqual([{ t: 'pong', id: '7' }])
    expect(sessions.handle).not.toHaveBeenCalled()
  })

  test('any client frame counts as alive for the ws-level heartbeat', () => {
    const { ws } = serve()
    vi.advanceTimersByTime(WS_HEARTBEAT_MS)
    ws.fire('message', JSON.stringify({ t: 'ping', id: '1' })) // no ws pong, but the tab is talking
    vi.advanceTimersByTime(WS_HEARTBEAT_MS)
    expect(ws.terminated).toBe(0)
  })

  test('the first frame of a connection is hello with bootId and build', () => {
    const { ws } = serve({ bootId: 'boot-1', build: '0.8.0+abc' })
    expect(ws.sent[0]).toEqual({ t: 'hello', bootId: 'boot-1', build: '0.8.0+abc' })
  })
})

describe('sse streams', () => {
  test('sse.sub reaches the stream dispatcher, socket close fires its close, and never the PTY sessions', () => {
    const ws = new FakeSocket()
    const sessions = { handle: vi.fn(), detach: vi.fn(), resync: vi.fn() }
    const closed = vi.fn()
    const dispatch = vi.fn((req: { url: string; headers: Record<string, string> }, res: { on: (e: string, f: () => void) => void; setHeader: (k: string, v: string) => void; flushHeaders: () => void }) => {
      res.on('close', closed)
      res.setHeader('Content-Type', 'text/event-stream')
      res.flushHeaders()
    })
    const upgrade = { headers: { cookie: 'wt_ui=s', upgrade: 'websocket', 'sec-websocket-key': 'k' } } // test-only
    serveTerminalSocket(ws as never, { sessions: sessions as never, fsWatchHub: { watch: vi.fn(), unwatch: vi.fn(), dropClient: vi.fn() } as never, watchOn: () => false, clients: () => 1, streams: { upgrade, dispatch: dispatch as never } })
    ws.fire('message', JSON.stringify({ t: 'sse.sub', id: 's1', url: '/api/logs/stream' }))
    expect(dispatch).toHaveBeenCalledTimes(1)
    // Same identity as the upgrade, without the handshake headers.
    expect(dispatch.mock.calls[0]![0].headers).toEqual({ cookie: 'wt_ui=s', accept: 'text/event-stream' })
    expect(ws.sent).toEqual([{ t: 'sse.open', id: 's1' }])
    expect(sessions.handle).not.toHaveBeenCalled()
    ws.fire('close', 1000, Buffer.from(''))
    expect(closed).toHaveBeenCalledTimes(1)
  })

  test('without a stream dispatcher a subscription is refused', () => {
    const ws = new FakeSocket()
    serveTerminalSocket(ws as never, { sessions: { handle: vi.fn(), detach: vi.fn(), resync: vi.fn() } as never, fsWatchHub: { watch: vi.fn(), unwatch: vi.fn(), dropClient: vi.fn() } as never, watchOn: () => false, clients: () => 1 })
    ws.fire('message', JSON.stringify({ t: 'sse.sub', id: 's1', url: '/api/logs/stream' }))
    expect(ws.sent).toEqual([{ t: 'sse.end', id: 's1', status: 404 }])
  })
})
