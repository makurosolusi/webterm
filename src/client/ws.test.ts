import { test, expect, vi } from 'vitest'

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
}

;(globalThis as any).WebSocket = FakeWS

function setLocation(href: string, host: string) {
  ;(globalThis as any).location = { protocol: new URL(href).protocol, host, href }
}

/** Both modules read the token once at load, so every case needs a fresh module registry. */
function fresh() {
  vi.resetModules()
  return { ws: import('./ws'), api: import('./api') }
}

function lastSocket() {
  return FakeWS.instances[FakeWS.instances.length - 1]
}

test('first connect sends open exactly once (no doubled scrollback replay)', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, send } = await fresh().ws
  const id = 'term-1'
  subscribe(id, () => {}, () => {}) // triggers connect(): socket is CONNECTING
  send({ t: 'open', id, cols: 80, rows: 24 }) // sent while not OPEN

  const sock = lastSocket()
  sock.readyState = FakeWS.OPEN
  sock.onopen!() // replays sub.open, then drains queue

  const opens = sock.sent
    .map((s) => JSON.parse(s))
    .filter((m) => m.t === 'open' && m.id === id)
  expect(opens).toHaveLength(1)
})

test('loopback default: no token means the WS url is byte-for-byte what it always was', async () => {
  ;(globalThis as any).sessionStorage = undefined
  setLocation('http://localhost/', 'localhost')
  const { subscribe } = await fresh().ws
  subscribe('term-token-off', () => {}, () => {})
  expect(lastSocket().url).toBe('ws://localhost/ws')
})

test('token in the page URL is stashed in sessionStorage and sent on the WS url', async () => {
  const stored = new Map<string, string>()
  ;(globalThis as any).sessionStorage = {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
  }
  let replaced: string | null = null
  ;(globalThis as any).history = { replaceState: (_s: unknown, _t: string, u: string) => { replaced = u } }
  setLocation('http://10.0.0.5:8700/?token=s3cret%2Fx', '10.0.0.5:8700')

  const mods = fresh()
  const { tokenQuery } = await mods.api
  expect(tokenQuery()).toBe('token=s3cret%2Fx')
  expect(stored.get('webterm.token')).toBe('s3cret/x')
  expect(replaced).toBe('/') // token stripped from the address bar

  const { subscribe } = await mods.ws
  subscribe('term-token-on', () => {}, () => {})
  expect(lastSocket().url).toBe('ws://10.0.0.5:8700/ws?token=s3cret%2Fx')
})

test('token survives a reload via sessionStorage, with no token in the URL', async () => {
  ;(globalThis as any).sessionStorage = {
    getItem: (k: string) => (k === 'webterm.token' ? 'kept' : null),
    setItem: () => {},
  }
  setLocation('http://10.0.0.5:8700/', '10.0.0.5:8700')
  const { tokenQuery } = await fresh().api
  expect(tokenQuery()).toBe('token=kept')
})
