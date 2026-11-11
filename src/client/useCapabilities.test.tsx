/** @vitest-environment jsdom */
// useCapabilities: cache modul, toggle tanpa optimistis (aria-busy), 403 -> pesan Indonesia.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilitiesResponse } from '../shared/featureCapabilities'
import { CAPABILITY_TEXT } from './capabilitiesLabels'
import { resetCapabilitiesCache, useCapabilities } from './useCapabilities'

const state = (status: 'on' | 'off'): CapabilitiesResponse =>
  ({ capabilities: [{ id: 'files', title: 'Kelola file', blurb: 'b', status }], advanced: {} } as unknown as CapabilitiesResponse)
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status })

beforeEach(resetCapabilitiesCache)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('useCapabilities', () => {
  it('loads once and shares the cache between hook instances', async () => {
    const f = vi.fn().mockImplementation(async () => json(200, state('off')))
    vi.stubGlobal('fetch', f)
    const a = renderHook(() => useCapabilities())
    await waitFor(() => expect(a.result.current.data).not.toBeNull())
    const b = renderHook(() => useCapabilities())
    expect(b.result.current.data?.capabilities[0].status).toBe('off')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('toggle is not optimistic: busyId while pending, state changes only after the server answers', async () => {
    let release: (r: Response) => void = () => undefined
    const f = vi.fn()
      .mockResolvedValueOnce(json(200, state('off')))
      .mockImplementationOnce(() => new Promise<Response>((r) => { release = r }))
    vi.stubGlobal('fetch', f)
    const { result } = renderHook(() => useCapabilities())
    await waitFor(() => expect(result.current.data).not.toBeNull())
    let done: Promise<boolean> = Promise.resolve(false)
    act(() => { done = result.current.toggle('files', true) })
    expect(result.current.busyId).toBe('files')
    expect(result.current.data?.capabilities[0].status).toBe('off')
    expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ enabled: true })
    await act(async () => { release(json(200, state('on'))); await done })
    expect(result.current.busyId).toBeNull()
    expect(result.current.data?.capabilities[0].status).toBe('on')
  })

  it('maps 403 to the session message and keeps the old state', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json(200, state('off')))
      .mockResolvedValueOnce(json(403, { error: 'forbidden' })))
    const { result } = renderHook(() => useCapabilities())
    await waitFor(() => expect(result.current.data).not.toBeNull())
    let ok = true
    await act(async () => { ok = await result.current.toggle('files', true) })
    expect(ok).toBe(false)
    expect(result.current.error).toBe(CAPABILITY_TEXT.forbidden)
    expect(result.current.data?.capabilities[0].status).toBe('off')
  })

  it('403 on a write maps to the session message', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json(200, state('off')))
      .mockResolvedValueOnce(json(403, { error: 'forbidden' })))
    const { result } = renderHook(() => useCapabilities())
    await waitFor(() => expect(result.current.data).not.toBeNull())
    await act(async () => { await result.current.toggle('files', true) })
    expect(result.current.error).toBe(CAPABILITY_TEXT.forbidden)
  })

  it('recheck meminta deteksi segar (?refresh=1); refresh biasa tidak', async () => {
    const f = vi.fn().mockImplementation(async () => json(200, state('off')))
    vi.stubGlobal('fetch', f)
    const { result } = renderHook(() => useCapabilities())
    await waitFor(() => expect(result.current.data).not.toBeNull())
    await act(async () => { await result.current.refresh() })
    await act(async () => { await result.current.recheck() })
    expect(f.mock.calls.map((c) => c[0])).toEqual(['/api/capabilities', '/api/capabilities', '/api/capabilities?refresh=1'])
  })

  it('refresh reloads from the server', async () => {
    const f = vi.fn().mockResolvedValueOnce(json(200, state('off'))).mockResolvedValueOnce(json(200, state('on')))
    vi.stubGlobal('fetch', f)
    const { result } = renderHook(() => useCapabilities())
    await waitFor(() => expect(result.current.data).not.toBeNull())
    await act(async () => { await result.current.refresh() })
    expect(result.current.data?.capabilities[0].status).toBe('on')
  })

  it('recheck returns the outcome so a button can report it: data on success, the user message on failure', async () => {
    const f = vi.fn().mockResolvedValueOnce(json(200, state('off'))).mockResolvedValueOnce(json(200, state('on'))).mockResolvedValueOnce(json(403, { error: 'forbidden' }))
    vi.stubGlobal('fetch', f)
    const { result } = renderHook(() => useCapabilities())
    await waitFor(() => expect(result.current.data).not.toBeNull())
    let ok: unknown
    await act(async () => { ok = await result.current.recheck() })
    expect(ok).toMatchObject({ ok: true, data: { capabilities: [{ status: 'on' }] } })
    let failed: unknown
    await act(async () => { failed = await result.current.recheck() })
    expect(failed).toEqual({ ok: false, error: CAPABILITY_TEXT.forbidden })
    expect(result.current.error).toBe(CAPABILITY_TEXT.forbidden)
  })
})
