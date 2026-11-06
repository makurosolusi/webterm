/**
 * @vitest-environment jsdom
 */
// Settings edits still inside the 300ms coalesce window are written when the page goes away.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSettings } from './useSettings'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }) })

async function mountSettings() {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    ({ ok: true, status: 200, json: async () => ({}) }) as Response)
  vi.stubGlobal('fetch', fetchMock)
  const view = renderHook(() => useSettings())
  await waitFor(() => expect(view.result.current.hydrated).toBe(true))
  const puts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')
  return { view, puts }
}

describe('useSettings page lifecycle', () => {
  it('pagehide writes the pending edit at once as a keepalive request', async () => {
    const { view, puts } = await mountSettings()
    act(() => view.result.current.update({ fontSize: 17 }))
    expect(puts()).toHaveLength(0) // inside the coalesce window
    window.dispatchEvent(new Event('pagehide'))
    expect(puts()).toHaveLength(1)
    expect(puts()[0][1]!.keepalive).toBe(true)
    expect(JSON.parse(String(puts()[0][1]!.body))).toEqual({ fontSize: 17 })
  })

  it('hiding the tab writes the pending edit', async () => {
    const { view, puts } = await mountSettings()
    act(() => view.result.current.update({ fontSize: 15 }))
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(puts()).toHaveLength(1)
  })
})
