/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { FOCUS_PING_GAP_MS, PRESENCE_PING_MS, focusedNodeId, usePresencePing } from './presencePing'
import { writeNotifyPrefs } from './osNotify.prefs'
import { setConnection } from './ws.connection'

let visibility: DocumentVisibilityState = 'visible'
let fetchMock: ReturnType<typeof vi.fn>

function setVisibility(v: DocumentVisibilityState): void {
  visibility = v
  document.dispatchEvent(new Event('visibilitychange'))
}
const bodies = (): Array<{ visible: boolean; muted: string[]; nodeId: string | null }> =>
  fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)))

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  setConnection({ phase: 'connected', attempt: 0 })
})
afterEach(() => {
  cleanup() // a hook left mounted would keep pinging into the next test
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('pings on mount, every 30 s while visible, on return to visible; stops on unmount', () => {
  writeNotifyPrefs({ muted: ['ws-1'] })
  const { unmount } = renderHook(() => usePresencePing(true))
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/channels/presence')
  expect(bodies()[0]).toEqual({ visible: true, muted: ['ws-1'], nodeId: null })

  vi.advanceTimersByTime(PRESENCE_PING_MS)
  expect(fetchMock).toHaveBeenCalledTimes(2)

  setVisibility('hidden')
  vi.advanceTimersByTime(PRESENCE_PING_MS * 3)
  expect(fetchMock).toHaveBeenCalledTimes(2) // hidden tab sends nothing

  setVisibility('visible')
  expect(fetchMock).toHaveBeenCalledTimes(3)

  unmount()
  vi.advanceTimersByTime(PRESENCE_PING_MS * 3)
  setVisibility('visible')
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

test('carries the focused canvas node, and pings again when focus moves to another node', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  document.body.innerHTML = '<div class="react-flow__node" data-id="n-a"><textarea id="ta"></textarea></div>' +
    '<div class="react-flow__node selected" data-id="n-b"></div>'
  const { unmount } = renderHook(() => usePresencePing(true))
  expect(bodies()[0].nodeId).toBe('n-b') // nothing focused: the selected node
  vi.advanceTimersByTime(FOCUS_PING_GAP_MS)
  ;(document.getElementById('ta') as HTMLTextAreaElement).focus()
  expect(bodies().at(-1)?.nodeId).toBe('n-a') // keyboard focus wins
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  expect(focusedNodeId()).toBeNull() // an unfocused window watches nothing
  unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

test('disabled hook (login gate) sends nothing', () => {
  renderHook(() => usePresencePing(false))
  vi.advanceTimersByTime(PRESENCE_PING_MS * 2)
  expect(fetchMock).not.toHaveBeenCalled()
})

test('404 (Telegram off) is silent; other failures warn', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  fetchMock.mockImplementation(async () => new Response('{}', { status: 404 }))
  renderHook(() => usePresencePing(true))
  await vi.runOnlyPendingTimersAsync()
  expect(fetchMock).toHaveBeenCalled()
  expect(warn).not.toHaveBeenCalled()

  fetchMock.mockImplementation(async () => new Response('{}', { status: 500 }))
  await vi.advanceTimersByTimeAsync(PRESENCE_PING_MS)
  expect(warn).toHaveBeenCalledTimes(1)
  warn.mockRestore()
})

test('offline: skips ticks, warns once per outage, pings again the moment the socket is back', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { unmount } = renderHook(() => usePresencePing(true))
  await vi.advanceTimersByTimeAsync(0) // a good first ping: any earlier outage is over
  fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch') })
  await vi.advanceTimersByTimeAsync(PRESENCE_PING_MS * 2)
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(warn).toHaveBeenCalledTimes(1) // two failures, one warning

  setConnection({ phase: 'reconnecting', attempt: 1 })
  vi.advanceTimersByTime(PRESENCE_PING_MS * 3)
  expect(fetchMock).toHaveBeenCalledTimes(3) // no ticks while the server is unreachable

  fetchMock.mockImplementation(async () => new Response(null, { status: 204 }))
  setConnection({ phase: 'connected', attempt: 0 })
  expect(fetchMock).toHaveBeenCalledTimes(4) // immediate ping on reconnect
  await vi.advanceTimersByTimeAsync(0)
  fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch') })
  vi.advanceTimersByTime(PRESENCE_PING_MS)
  await vi.advanceTimersByTimeAsync(0)
  expect(warn).toHaveBeenCalledTimes(2) // a new outage after a success warns again
  unmount()
  warn.mockRestore()
})

test('the first connect attempt (`connecting`) does not pause pings; offline skips', async () => {
  setConnection({ phase: 'connecting', attempt: 0 })
  const { unmount } = renderHook(() => usePresencePing(true))
  await vi.advanceTimersByTimeAsync(PRESENCE_PING_MS)
  expect(fetchMock).toHaveBeenCalledTimes(2) // mount + one tick
  setConnection({ phase: 'offline', attempt: 0 })
  vi.advanceTimersByTime(PRESENCE_PING_MS * 3)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  unmount()
})
