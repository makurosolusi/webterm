/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { PRESENCE_PING_MS, usePresencePing } from './presencePing'
import { writeNotifyPrefs } from './osNotify.prefs'

let visibility: DocumentVisibilityState = 'visible'
let fetchMock: ReturnType<typeof vi.fn>

function setVisibility(v: DocumentVisibilityState): void {
  visibility = v
  document.dispatchEvent(new Event('visibilitychange'))
}
const bodies = (): Array<{ visible: boolean; muted: string[] }> =>
  fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)))

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('pings on mount, every 30 s while visible, on return to visible; stops on unmount', () => {
  writeNotifyPrefs({ muted: ['ws-1'] })
  const { unmount } = renderHook(() => usePresencePing(true))
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/channels/presence')
  expect(bodies()[0]).toEqual({ visible: true, muted: ['ws-1'] })

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
