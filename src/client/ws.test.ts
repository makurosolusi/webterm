import { test, expect } from 'vitest'

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
;(globalThis as any).location = { protocol: 'http:', host: 'localhost' }

test('first connect sends open exactly once (no doubled scrollback replay)', async () => {
  const { subscribe, send } = await import('./ws')
  const id = 'term-1'
  subscribe(id, () => {}, () => {}) // triggers connect(): socket is CONNECTING
  send({ t: 'open', id, cols: 80, rows: 24 }) // sent while not OPEN

  const sock = FakeWS.instances[FakeWS.instances.length - 1]
  sock.readyState = FakeWS.OPEN
  sock.onopen!() // replays sub.open, then drains queue

  const opens = sock.sent
    .map((s) => JSON.parse(s))
    .filter((m) => m.t === 'open' && m.id === id)
  expect(opens).toHaveLength(1)
})
