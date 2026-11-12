// openEventStream (ws.ts + ws.streams.ts): an EventSource-compatible stream on the shared socket.
import { afterEach, expect, test, vi } from 'vitest'

class FakeWS { // test-only
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
  open() { this.readyState = FakeWS.OPEN; this.onopen!() }
  frame(m: unknown) { this.onmessage!({ data: JSON.stringify(m) }) }
  msgs() { return this.sent.map((s) => JSON.parse(s)).filter((m) => String(m.t).startsWith('sse.')) }
}
;(globalThis as any).WebSocket = FakeWS
;(globalThis as any).location = { protocol: 'http:', host: 'localhost', href: 'http://localhost/' }

async function fresh() {
  vi.resetModules()
  FakeWS.instances = []
  return import('./ws')
}
const sock = () => FakeWS.instances[FakeWS.instances.length - 1]!

afterEach(async () => { (await import('./ws')).__resetWsForTests() })

test('subscribes once the socket opens, then delivers open, unnamed and named events', async () => {
  const { openEventStream, STREAM_OPEN } = await fresh()
  const s = openEventStream('/api/logs/stream?afterSeq=3')
  expect(sock().msgs()).toEqual([]) // socket still connecting: nothing sent yet
  sock().open()
  expect(sock().msgs()).toEqual([{ t: 'sse.sub', id: s.id, url: '/api/logs/stream?afterSeq=3' }])

  const seen: string[] = []
  s.onopen = () => seen.push('open')
  s.onmessage = (e) => seen.push(`message:${e.data}:${e.lastEventId}`)
  s.addEventListener('log', (e) => seen.push(`log:${(e as MessageEvent).data}:${(e as MessageEvent).lastEventId}`))
  sock().frame({ t: 'sse.open', id: s.id })
  expect(s.readyState).toBe(STREAM_OPEN)
  sock().frame({ t: 'sse.ev', id: s.id, event: 'message', data: 'plain', lastId: '' })
  sock().frame({ t: 'sse.ev', id: s.id, event: 'log', data: '{"seq":4}', lastId: '4' })
  sock().frame({ t: 'sse.ev', id: 'someone-else', event: 'log', data: 'x', lastId: '' })
  expect(seen).toEqual(['open', 'message:plain:', 'log:{"seq":4}:4'])
})

test('close() sends unsub and stops delivery', async () => {
  const { openEventStream, STREAM_CLOSED } = await fresh()
  const s = openEventStream('/api/events/stream')
  sock().open()
  const got = vi.fn()
  s.addEventListener('sense', got)
  s.close()
  expect(s.readyState).toBe(STREAM_CLOSED)
  expect(sock().msgs()).toEqual([{ t: 'sse.sub', id: s.id, url: '/api/events/stream' }, { t: 'sse.unsub', id: s.id }])
  sock().frame({ t: 'sse.ev', id: s.id, event: 'sense', data: '{}', lastId: '' })
  expect(got).not.toHaveBeenCalled()
})

test('a socket drop fires onerror (CONNECTING, like a dropped EventSource); a refusal leaves it CLOSED', async () => {
  const { openEventStream, STREAM_CLOSED, STREAM_CONNECTING } = await fresh()
  const dropped = openEventStream('/api/logs/stream')
  const refused = openEventStream('/api/events/stream')
  sock().open()
  const errors: string[] = []
  refused.onerror = () => errors.push(`refused:${refused.readyState}`)
  dropped.onerror = () => errors.push(`dropped:${dropped.readyState}`)
  sock().frame({ t: 'sse.end', id: refused.id, status: 403 })
  expect(errors).toEqual([`refused:${STREAM_CLOSED}`])
  sock().onclose!()
  expect(errors).toEqual([`refused:${STREAM_CLOSED}`, `dropped:${STREAM_CONNECTING}`])
  // The consumer closes and reopens on its own schedule: no unsub for a subscription the drop already ended.
  dropped.close()
  expect(sock().msgs().filter((m) => m.t === 'sse.unsub')).toEqual([])
})

test('a named `error` frame is a MessageEvent with data, distinct from a transport error', async () => {
  const { openEventStream } = await fresh()
  const s = openEventStream('/api/central/conversations/c1/stream')
  sock().open()
  const onerror = vi.fn()
  s.onerror = onerror
  sock().frame({ t: 'sse.ev', id: s.id, event: 'error', data: '{"code":"x"}', lastId: '9' })
  expect((onerror.mock.calls[0]![0] as MessageEvent).data).toBe('{"code":"x"}')
})
