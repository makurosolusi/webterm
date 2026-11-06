// Locks for the shared terminal socket across drops: replay from `since` (pty-207-9), no queued
// input while offline plus the connection state the banner reads (pty-207-5), and detach on
// unmount (pty-207-8).
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

class FakeWS {
  static instances: FakeWS[] = []
  static OPEN = 1
  static CONNECTING = 0
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) { FakeWS.instances.push(this) }
  send(d: string) { this.sent.push(d) }
  close() {}
  /** Server side: the socket came up. */
  up() { this.readyState = FakeWS.OPEN; this.onopen!() }
  /** Server side: the socket dropped. */
  drop() { this.readyState = 3; this.onclose!() }
  push(m: object) { this.onmessage!({ data: JSON.stringify(m) }) }
  msgs() { return this.sent.map((s) => JSON.parse(s) as { t: string; [k: string]: unknown }) }
}

;(globalThis as any).WebSocket = FakeWS
;(globalThis as any).location = { protocol: 'http:', host: 'localhost', href: 'http://localhost/' }

async function fresh() {
  vi.resetModules()
  FakeWS.instances.length = 0
  return { ...(await import('./ws')), ...(await import('./ws.connection')) }
}
const last = () => FakeWS.instances[FakeWS.instances.length - 1]

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

test('a reconnect asks only for what came after the last drawn chunk; the server reset clears the xterm', async () => {
  const { subscribe, send, RECONNECT_BASE_MS } = await fresh()
  const out: string[] = []
  const onReset = vi.fn()
  subscribe('t1', (d) => out.push(d), () => {}, onReset)
  const first = last()
  first.up()
  send({ t: 'open', id: 't1', cols: 80, rows: 24 })
  first.push({ t: 'reset', id: 't1', epoch: 'e1' })
  first.push({ t: 'output', id: 't1', data: 'a', seq: 1 })
  first.push({ t: 'output', id: 't1', data: 'b', seq: 2 })
  expect(onReset).toHaveBeenCalledTimes(1)

  first.drop()
  vi.advanceTimersByTime(RECONNECT_BASE_MS)
  const second = last()
  second.up()
  expect(second.msgs()[0]).toMatchObject({ t: 'open', id: 't1', since: { epoch: 'e1', seq: 2 } })
  expect(onReset).toHaveBeenCalledTimes(1) // the client no longer wipes on its own

  second.push({ t: 'output', id: 't1', data: 'c', seq: 3 })
  expect(out).toEqual(['a', 'b', 'c'])
  second.push({ t: 'reset', id: 't1', epoch: 'e2' }) // server restarted: a different log
  expect(onReset).toHaveBeenCalledTimes(2)
  second.push({ t: 'output', id: 't1', data: 'fresh', seq: 1 })
  expect(out.at(-1)).toBe('fresh')
})

test('a chunk at or below the last drawn seq is not written twice', async () => {
  const { subscribe } = await fresh()
  const out: string[] = []
  subscribe('t2', (d) => out.push(d), () => {})
  const sock = last()
  sock.up()
  sock.push({ t: 'reset', id: 't2', epoch: 'e' })
  for (const seq of [1, 2, 2, 1, 3]) sock.push({ t: 'output', id: 't2', data: `s${seq}`, seq })
  expect(out).toEqual(['s1', 's2', 's3'])
})

test('input typed while the socket is down is dropped, never sent after the reconnect', async () => {
  const { subscribe, send, RECONNECT_BASE_MS } = await fresh()
  subscribe('t3', () => {}, () => {})
  last().up()
  send({ t: 'open', id: 't3', cols: 80, rows: 24 })
  last().drop()
  send({ t: 'input', id: 't3', data: 'rm -rf build\r' })
  vi.advanceTimersByTime(RECONNECT_BASE_MS)
  last().up()
  expect(last().msgs().filter((m) => m.t === 'input')).toEqual([])
})

test('resizes while offline collapse to the latest one per terminal', async () => {
  const { subscribe, send } = await fresh()
  subscribe('t4', () => {}, () => {})
  send({ t: 'resize', id: 't4', cols: 90, rows: 20 })
  send({ t: 'resize', id: 't4', cols: 100, rows: 30 })
  send({ t: 'resize', id: 't4', cols: 110, rows: 40 })
  last().up()
  expect(last().msgs().filter((m) => m.t === 'resize')).toEqual([{ t: 'resize', id: 't4', cols: 110, rows: 40 }])
})

test('unmounting a live view sends detach; an exited one has nothing to detach', async () => {
  const { subscribe } = await fresh()
  const offA = subscribe('t5', () => {}, () => {})
  const offB = subscribe('t6', () => {}, () => {})
  const sock = last()
  sock.up()
  sock.push({ t: 'exit', id: 't6', code: 0, reason: 'self' })
  offA()
  offB()
  expect(sock.msgs()).toEqual([{ t: 'detach', id: 't5' }])
})

test('backoff doubles up to the cap; the banner state says reconnecting; Retry now skips the wait', async () => {
  const { subscribe, getConnection, reconnectNow, RECONNECT_BASE_MS, RECONNECT_MAX_MS } = await fresh()
  subscribe('t7', () => {}, () => {})
  expect(getConnection().phase).toBe('connecting')
  last().up()
  expect(getConnection()).toEqual({ phase: 'connected' })

  const delays: number[] = []
  for (let i = 0; i < 6; i++) {
    last().drop()
    const state = getConnection()
    expect(state.phase).toBe('reconnecting')
    delays.push(state.retryAt! - Date.now())
    vi.advanceTimersByTime(state.retryAt! - Date.now())
  }
  expect(delays).toEqual([1, 2, 4, 8, 10, 10].map((n) => Math.min(RECONNECT_MAX_MS, n * RECONNECT_BASE_MS)))

  const sockets = FakeWS.instances.length
  last().drop()
  reconnectNow()
  expect(FakeWS.instances.length).toBe(sockets + 1)
  vi.advanceTimersByTime(RECONNECT_MAX_MS)
  expect(FakeWS.instances.length).toBe(sockets + 1) // the cancelled timer does not open a second one
  last().up()
  expect(getConnection().phase).toBe('connected')
})
