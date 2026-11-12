/** @vitest-environment jsdom */
// A settings PUT the server never answers (e.g. queued behind the browser's per-host connection limit) must still
// end: after SAVE_TIMEOUT_MS the save state turns into an error with Retry, on the Central chip and in useSettings.
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '../shared/settings'
import { SettingsProvider, settingsSaves, useSettings } from './useSettings'
import { ApprovalModeChip } from './ApprovalModeControl'
import { SAVE_TIMEOUT_MS } from './settingsSave.timeout'

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
})

let putSignals: (AbortSignal | undefined)[]
beforeEach(() => {
  putSignals = []
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method !== 'PUT') return Promise.resolve(new Response('{}', { status: 200 }))
    putSignals.push(init.signal ?? undefined)
    // Never answers; only the request's own signal can end it, as in a browser.
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })
  }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

const TIMEOUT_TEXT = 'The server did not answer in 15 s'

describe('settings save timeout', () => {
  it('the Central chip: a PUT that never answers ends as an error with Retry', async () => {
    render(<SettingsProvider value={mergeSettings(DEFAULT_SETTINGS)}><ApprovalModeChip workspaceId="w1" /></SettingsProvider>)
    fireEvent.keyDown(screen.getByRole('button', { name: /^Permission mode/ }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Ask' }))
    expect(settingsSaves.get('projectApprovalLevels')).toEqual({ status: 'saving' })
    expect(putSignals[0]).toBeInstanceOf(AbortSignal)

    await act(async () => { await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS) })

    const s = settingsSaves.get('projectApprovalLevels')
    expect(s).toMatchObject({ status: 'error', message: TIMEOUT_TEXT })
    expect(screen.getByRole('alert').textContent).toContain(TIMEOUT_TEXT)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(putSignals).toHaveLength(2)
    expect(settingsSaves.get('projectApprovalLevels')).toEqual({ status: 'saving' })
  })

  it('useSettings: a coalesced PUT that never answers ends as an error with Retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined) // the coalescer reports the failure
    const view = renderHook(() => useSettings())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    act(() => view.result.current.update({ fontSize: 19 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(putSignals).toHaveLength(1)
    expect(settingsSaves.get('fontSize')).toEqual({ status: 'saving' })

    await act(async () => { await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS) })

    const s = settingsSaves.get('fontSize')
    expect(s).toMatchObject({ status: 'error', message: TIMEOUT_TEXT })
    if (s?.status !== 'error') throw new Error('expected an error state')
    act(() => s.retry())
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(putSignals).toHaveLength(2)
  })
})
