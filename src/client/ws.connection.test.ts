// Locks for the terminal socket's offline resilience: full-jitter backoff, wake triggers, the
// offline pause, the app-level heartbeat (half-open detection), the server `hello` (restart and
// new build), the auth probe that stops a refused credential from looping, and `whenConnected`.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

class FakeWS {
  static instances: FakeWS[] = []
  static OPEN = 1
  readyState = 0
  sent: string[] = []
  closed = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) { FakeWS.instances.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.closed++ }
  up() { this.readyState = FakeWS.OPEN; this.onopen!() }
  drop() { this.readyState = 3; this.onclose?.() }
  push(m: object) { this.onmessage!({ data: JSON.stringify(m) }) }
  msgs() { return this.sent.map((s) => JSON.parse(s) as { t: string; [k: string]: unknown }) }
}

const fetchMock = vi.fn()
let online = true

async function fresh() {
  vi.resetModules()
  FakeWS.instances.length = 0
  online = true
  // A fresh window per test: listeners of earlier module instances must not hear these events.
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  vi.stubGlobal('navigator', { get onLine() { return online } })
  vi.stubGlobal('location', { protocol: 'http:', host: 'example.test', hostname: 'example.test' })
  vi.stubGlobal('WebSocket', FakeWS)
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
  return { ...(await import('./ws')), ...(await import('./ws.connection')), ...(await import('./ws.liveness')) }
}
const last = () => FakeWS.instances[FakeWS.instances.length - 1]
const fire = (target: EventTarget, type: string, extra: object = {}) => target.dispatchEvent(Object.assign(new Event(type), extra))
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('reconnectDelay', () => {
  test('full jitter: random 0 floors at minMs, random 1 reaches the capped ceiling', async () => {
    const { reconnectDelay } = await fresh()
    expect(reconnectDelay(0, { random: () => 0 })).toBe(250)
    expect(reconnectDelay(0, { random: () => 1 })).toBe(1000)
    expect(reconnectDelay(3, { random: () => 1 })).toBe(8000)
    expect(reconnectDelay(20, { random: () => 1 })).toBe(10_000)
    expect(reconnectDelay(2, { random: () => 0.5, baseMs: 100, capMs: 300, minMs: 10 })).toBe(150)
  })

  test('attempts reset after a successful open', async () => {
    const { subscribe, getConnection } = await fresh()
    vi.spyOn(Math, 'random').mockReturnValue(1)
    subscribe('a', () => {}, () => {})
    last().up()
    for (let i = 0; i < 3; i++) { last().drop(); vi.advanceTimersByTime(getConnection().retryAt! - Date.now()) }
    expect(getConnection().attempt).toBe(3)
    last().up()
    expect(getConnection()).toMatchObject({ phase: 'connected', attempt: 0 })
    last().drop()
    expect(getConnection().retryAt! - Date.now()).toBe(1000)
  })
})

describe('wake triggers', () => {
  const triggers: [string, (w: EventTarget, d: EventTarget) => void][] = [
    ['online', (w) => fire(w, 'online')],
    ['visibilitychange to visible', (_w, d) => fire(d, 'visibilitychange')],
    ['pageshow from bfcache', (w) => fire(w, 'pageshow', { persisted: true })],
    ['focus', (w) => fire(w, 'focus')],
  ]
  for (const [name, trigger] of triggers) {
    test(`${name}: reconnects at once while down, pings while the socket looks open`, async () => {
      const { subscribe } = await fresh()
      subscribe('a', () => {}, () => {})
      last().up()
      trigger(window, document)
      expect(last().msgs().filter((m) => m.t === 'ping')).toHaveLength(1)
      vi.advanceTimersByTime(2000)
      last().push({ t: 'pong', id: last().msgs().find((m) => m.t === 'ping')!.id })
      last().drop()
      const before = FakeWS.instances.length
      trigger(window, document)
      expect(FakeWS.instances.length).toBe(before + 1) // no backoff wait
    })
  }

  test('bursts of wake events are throttled; pageshow without bfcache is ignored', async () => {
    const { subscribe } = await fresh()
    subscribe('a', () => {}, () => {})
    last().up()
    last().drop()
    const before = FakeWS.instances.length
    fire(window, 'pageshow', { persisted: false })
    expect(FakeWS.instances.length).toBe(before)
    fire(window, 'focus')
    last().drop()
    fire(document, 'visibilitychange')
    expect(FakeWS.instances.length).toBe(before + 1)
  })
})

test('offline pauses retries; online resumes them at once', async () => {
  const { subscribe, getConnection } = await fresh()
  subscribe('a', () => {}, () => {})
  last().up()
  last().drop()
  online = false
  fire(window, 'offline')
  expect(getConnection().phase).toBe('offline')
  const before = FakeWS.instances.length
  vi.advanceTimersByTime(60_000)
  expect(FakeWS.instances.length).toBe(before)
  online = true
  fire(window, 'online')
  expect(FakeWS.instances.length).toBe(before + 1)
  last().up()
  expect(getConnection().phase).toBe('connected')
})

test('a drop while the browser is offline does not schedule a retry', async () => {
  const { subscribe, getConnection } = await fresh()
  subscribe('a', () => {}, () => {})
  last().up()
  online = false
  last().drop()
  expect(getConnection()).toMatchObject({ phase: 'offline', retryAt: undefined })
})

describe('heartbeat', () => {
  test('no pong within the timeout closes the socket and reconnects', async () => {
    const { subscribe, getConnection, HEARTBEAT_MS, PONG_TIMEOUT_MS } = await fresh()
    subscribe('a', () => {}, () => {})
    const sock = last()
    sock.up()
    vi.advanceTimersByTime(HEARTBEAT_MS)
    expect(sock.msgs().filter((m) => m.t === 'ping')).toHaveLength(1)
    vi.advanceTimersByTime(PONG_TIMEOUT_MS)
    expect(sock.closed).toBe(1)
    expect(getConnection().phase).toBe('reconnecting')
    vi.advanceTimersByTime(10_000)
    expect(last()).not.toBe(sock)
  })

  test('a pong keeps the socket alive across many intervals', async () => {
    const { subscribe, getConnection, HEARTBEAT_MS } = await fresh()
    subscribe('a', () => {}, () => {})
    const sock = last()
    sock.up()
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(HEARTBEAT_MS)
      const ping = sock.msgs().filter((m) => m.t === 'ping').at(-1)!
      sock.push({ t: 'pong', id: ping.id })
    }
    expect(sock.closed).toBe(0)
    expect(FakeWS.instances).toHaveLength(1)
    expect(getConnection().phase).toBe('connected')
  })
})

describe('hello', () => {
  test('a different bootId after a reconnect sets serverRestartedAt; the same one does not', async () => {
    const { subscribe, getConnection } = await fresh()
    subscribe('a', () => {}, () => {})
    last().up()
    last().push({ t: 'hello', bootId: 'b1', build: '1+x' })
    expect(getConnection()).toMatchObject({ bootId: 'b1', build: '1+x', serverRestartedAt: undefined, buildChanged: false })
    last().drop(); vi.advanceTimersByTime(10_000); last().up()
    last().push({ t: 'hello', bootId: 'b1', build: '1+x' })
    expect(getConnection().serverRestartedAt).toBeUndefined()
    last().drop(); vi.advanceTimersByTime(10_000); last().up()
    last().push({ t: 'hello', bootId: 'b2', build: '1+x' })
    expect(getConnection()).toMatchObject({ bootId: 'b2', serverRestartedAt: Date.now(), buildChanged: false })
  })

  test('a different build sets buildChanged', async () => {
    const { subscribe, getConnection } = await fresh()
    subscribe('a', () => {}, () => {})
    last().up()
    last().push({ t: 'hello', bootId: 'b1', build: '1+x' })
    last().drop(); vi.advanceTimersByTime(10_000); last().up()
    last().push({ t: 'hello', bootId: 'b2', build: '2+y' })
    expect(getConnection()).toMatchObject({ build: '2+y', buildChanged: true })
  })
})

describe('auth probe', () => {
  test('a refused connect with /api/health 403 stops in the auth phase until retryNow', async () => {
    const { subscribe, getConnection, retryNow } = await fresh()
    fetchMock.mockResolvedValue({ status: 403 })
    subscribe('a', () => {}, () => {})
    last().drop() // closed without ever opening (upgrade refused shows as 1006)
    await flush()
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.anything())
    expect(getConnection().phase).toBe('auth')
    const before = FakeWS.instances.length
    vi.advanceTimersByTime(120_000)
    fire(window, 'focus')
    subscribe('b', () => {}, () => {})
    expect(FakeWS.instances.length).toBe(before)
    retryNow()
    expect(FakeWS.instances.length).toBe(before + 1)
    last().up()
    expect(getConnection().phase).toBe('connected')
  })

  test('a network error keeps reconnecting', async () => {
    const { subscribe, getConnection } = await fresh()
    subscribe('a', () => {}, () => {})
    last().drop()
    await flush()
    expect(getConnection().phase).toBe('connecting')
    const before = FakeWS.instances.length
    vi.advanceTimersByTime(10_000)
    expect(FakeWS.instances.length).toBe(before + 1)
  })

  test('a socket that opened and then dropped is not probed', async () => {
    const { subscribe } = await fresh()
    subscribe('a', () => {}, () => {})
    last().up()
    last().drop()
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

test('whenConnected runs now when connected, else once on the next connect; cancel stops it', async () => {
  const { subscribe, whenConnected } = await fresh()
  const early = vi.fn()
  const cancelled = vi.fn()
  whenConnected(early)
  whenConnected(cancelled)()
  subscribe('a', () => {}, () => {})
  expect(early).not.toHaveBeenCalled()
  last().up()
  expect(early).toHaveBeenCalledTimes(1)
  expect(cancelled).not.toHaveBeenCalled()
  const now = vi.fn()
  whenConnected(now)
  expect(now).toHaveBeenCalledTimes(1)
  last().drop(); vi.advanceTimersByTime(10_000); last().up()
  expect(early).toHaveBeenCalledTimes(1)
  expect(now).toHaveBeenCalledTimes(1)
})
