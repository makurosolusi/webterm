// openSseStream (chatStream.ts): refusals retry for a bounded time, then stop and report the status;
// a refusal that turns into an open (a node 404s until the board saves) keeps the stream.
import { afterEach, expect, test, vi } from 'vitest'
import { STREAM_REFUSED_GIVE_UP_MS, openSseStream } from './chatStream'
import { STREAM_CLOSED } from '../ws.streams'

class FakeSource { // test-only: the WsEventSource surface openSseStream reads
  static all: FakeSource[] = []
  onopen: ((e: Event) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  status: number | undefined
  readyState = 0
  closed = false
  constructor(public url: string) { FakeSource.all.push(this) }
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true }
  refuse(status: number) { this.status = status; this.readyState = STREAM_CLOSED; this.onerror?.(new Event('error')) }
}
const last = () => FakeSource.all[FakeSource.all.length - 1]!

function open(onRefused?: (s: number) => void) {
  const statuses: string[] = []
  const s = openSseStream({ path: '/api/agent-chat/n1/stream', eventTypes: ['agent-chat'], parse: () => null }, {
    createSource: (url) => new FakeSource(url) as never, onEvent: () => {}, onStatus: (st) => statuses.push(st), ...(onRefused ? { onRefused } : {}),
  })
  vi.advanceTimersByTime(0) // afterPageLoad
  return { s, statuses }
}

afterEach(() => { vi.useRealTimers(); FakeSource.all = [] })

test('a stream refused for the give-up window stops retrying and reports the status', () => {
  vi.useFakeTimers()
  const onRefused = vi.fn()
  open(onRefused)
  for (let i = 0; i < 100 && !onRefused.mock.calls.length; i++) { last().refuse(403); vi.advanceTimersByTime(STREAM_REFUSED_GIVE_UP_MS / 4) }
  expect(onRefused).toHaveBeenCalledWith(403)
  const n = FakeSource.all.length
  expect(last().closed).toBe(true)
  vi.advanceTimersByTime(STREAM_REFUSED_GIVE_UP_MS * 10)
  expect(FakeSource.all.length).toBe(n) // no retry after giving up
})

test('a 404 that turns into an open keeps the stream (board saved), and resets the window', () => {
  vi.useFakeTimers()
  const onRefused = vi.fn()
  const { statuses } = open(onRefused)
  last().refuse(404)
  vi.advanceTimersByTime(STREAM_REFUSED_GIVE_UP_MS - 1)
  last().onopen?.(new Event('open'))
  expect(statuses[statuses.length - 1]).toBe('open')
  vi.advanceTimersByTime(STREAM_REFUSED_GIVE_UP_MS)
  last().refuse(404) // first refusal of a new window: retried, not reported
  expect(onRefused).not.toHaveBeenCalled()
})

test('without onRefused a refused stream keeps retrying (other feeds unchanged)', () => {
  vi.useFakeTimers()
  open()
  for (let i = 0; i < 10; i++) { last().refuse(403); vi.advanceTimersByTime(STREAM_REFUSED_GIVE_UP_MS) }
  expect(FakeSource.all.length).toBeGreaterThan(5)
})
