/**
 * @vitest-environment jsdom
 */
// Provider Environment: fetch lazy, draft terpusat, simpan massal atomik, refresh, secret langsung.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { baseState, mkEntry, putBodies, stubEnvApi, type ApiStub } from './envTestFixtures'
import { EnvSettingsProvider, useEnvLoadOnMount, useEnvSettingsContext } from './useEnvSettings'

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const SENTINEL = 'TOK-SENTINEL-1234567890' // test-only
const gets = (s: ApiStub): number => s.calls.filter((c) => c.method === 'GET').length

function setup(query = '', load = true) {
  const stub = stubEnvApi(baseState())
  const wrapper = ({ children }: { children: ReactNode }) => <EnvSettingsProvider query={query}>{children}</EnvSettingsProvider>
  const hook = renderHook(() => {
    if (load) useEnvLoadOnMount() // eslint-disable-line react-hooks/rules-of-hooks -- konstan per tes
    return useEnvSettingsContext()
  }, { wrapper })
  return { stub, ...hook }
}

describe('EnvSettingsProvider', () => {
  it('does not fetch until a consumer asks or a query is typed', async () => {
    const idle = setup('', false)
    await Promise.resolve()
    expect(gets(idle.stub)).toBe(0)
    expect(idle.result.current.state).toBeNull()
    cleanup()
    const searching = setup('telegram', false)
    await waitFor(() => expect(searching.result.current.state).not.toBeNull())
    expect(gets(searching.stub)).toBe(1)
    expect(searching.result.current.query).toBe('telegram')
  })

  it('loads once and exposes loading while refreshing', async () => {
    const { result, stub } = setup()
    await waitFor(() => expect(result.current.state?.entries).toHaveLength(5))
    expect(gets(stub)).toBe(1)
    let p!: Promise<void>
    act(() => { p = result.current.refresh() })
    expect(result.current.loading).toBe(true)
    await act(async () => { await p })
    expect(result.current.loading).toBe(false)
  })

  it('tracks dirty keys, drops a draft equal to the server value, ignores unknown/locked keys', async () => {
    const { result } = setup()
    await waitFor(() => expect(result.current.state).not.toBeNull())
    act(() => { result.current.setDraft('K_ONE', 'on'); result.current.setDraft('K_TWO', 'x'); result.current.setDraft('NOPE', 'v') })
    expect(result.current.dirtyKeys).toEqual(['K_ONE', 'K_TWO'])
    expect(result.current.valueOf('K_ONE')).toBe('on')
    expect(result.current.valueOf('NOPE')).toBeUndefined()
    act(() => result.current.setDraft('K_ONE', 'off'))
    expect(result.current.dirtyKeys).toEqual(['K_TWO'])
    act(() => result.current.discard())
    expect(result.current.dirtyKeys).toEqual([])
  })

  it('save sends ONE PUT with every draft key and clears the drafts', async () => {
    const { result, stub } = setup()
    await waitFor(() => expect(result.current.state).not.toBeNull())
    stub.getState = { ...stub.getState, entries: stub.getState.entries.map((e) => (e.key === 'K_ONE' ? { ...e, value: 'on' } : e.key === 'K_TWO' ? { ...e, value: 'x' } : e)) }
    act(() => { result.current.setDraft('K_ONE', 'on'); result.current.setDraft('K_TWO', 'x') })
    await act(async () => { await result.current.save() })
    expect(putBodies(stub)).toEqual([{ set: { K_ONE: 'on', K_TWO: 'x' } }])
    expect(result.current.dirtyKeys).toEqual([])
    expect(result.current.state?.entries.find((e) => e.key === 'K_ONE')?.value).toBe('on')
  })

  it('save with no drafts sends nothing', async () => {
    const { result, stub } = setup()
    await waitFor(() => expect(result.current.state).not.toBeNull())
    await act(async () => { await result.current.save() })
    expect(putBodies(stub)).toEqual([])
  })

  it('failed save rejects, sets a brief error and keeps the drafts', async () => {
    const { result, stub } = setup()
    await waitFor(() => expect(result.current.state).not.toBeNull())
    stub.put = () => ({ status: 500, body: { error: 'store_failed' } })
    act(() => result.current.setDraft('K_ONE', 'on'))
    await act(async () => { await expect(result.current.save()).rejects.toThrow(/simpan perubahan gagal/) })
    expect(result.current.error).toBe('Server gagal menyimpan perubahan. Tidak ada yang berubah.')
    expect(result.current.dirtyKeys).toEqual(['K_ONE'])
  })

  it('refresh keeps drafts that still differ and drops those the server now equals', async () => {
    const { result, stub } = setup()
    await waitFor(() => expect(result.current.state).not.toBeNull())
    act(() => { result.current.setDraft('K_ONE', 'on'); result.current.setDraft('K_TWO', 'x') })
    stub.getState = { ...stub.getState, entries: stub.getState.entries.map((e) => (e.key === 'K_ONE' ? { ...e, value: 'on' } : e)) }
    await act(async () => { await result.current.refresh() })
    expect(result.current.dirtyKeys).toEqual(['K_TWO'])
  })

  it('reset sends unset for that key only and keeps other drafts', async () => {
    const { result, stub } = setup()
    await waitFor(() => expect(result.current.state).not.toBeNull())
    act(() => { result.current.setDraft('K_ONE', 'on'); result.current.setDraft('K_TWO', 'x') })
    await act(async () => { await result.current.reset('K_ONE') })
    expect(putBodies(stub)).toEqual([{ unset: ['K_ONE'] }])
    expect(result.current.dirtyKeys).toEqual(['K_TWO'])
  })

  it('reset failure does not reject but fills error', async () => {
    const { result, stub } = setup()
    await waitFor(() => expect(result.current.state).not.toBeNull())
    stub.put = () => ({ status: 403, body: { error: 'locked' } })
    await act(async () => { await result.current.reset('K_ONE') })
    expect(result.current.error).toBe('Pengaturan dikunci oleh WEBTERM_ENV_SETTINGS=off.')
  })

  it('secret value is sent directly and never enters draft or state', async () => {
    const { result, stub } = setup()
    await waitFor(() => expect(result.current.state).not.toBeNull())
    stub.getState = { ...stub.getState, entries: stub.getState.entries.map((e) => (e.key === 'K_SECRET' ? mkEntry({ key: 'K_SECRET', kind: 'secret', value: '', secretSet: true }) : e)) }
    act(() => result.current.setDraft('K_SECRET', SENTINEL))
    await waitFor(() => expect(putBodies(stub)).toEqual([{ set: { K_SECRET: SENTINEL } }]))
    await waitFor(() => expect(result.current.state?.entries.find((e) => e.key === 'K_SECRET')?.secretSet).toBe(true))
    expect(result.current.dirtyKeys).toEqual([])
    expect(JSON.stringify(result.current.state)).not.toContain(SENTINEL)
    expect(result.current.valueOf('K_SECRET')).toBe('on')
  })

  it('non-editable entries ignore drafts', async () => {
    const { result, stub } = setup()
    await waitFor(() => expect(result.current.state).not.toBeNull())
    stub.getState = { ...stub.getState, entries: stub.getState.entries.map((e) => (e.key === 'K_DANGER' ? { ...e, editable: false } : e)) }
    await act(async () => { await result.current.refresh() })
    act(() => result.current.setDraft('K_DANGER', 'on'))
    expect(result.current.dirtyKeys).toEqual([])
  })

  it('shows a brief load error and keeps the old state out of the way', async () => {
    const stub = stubEnvApi(baseState())
    stub.calls.length = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    const { result } = renderHook(() => { useEnvLoadOnMount(); return useEnvSettingsContext() }, {
      wrapper: ({ children }: { children: ReactNode }) => <EnvSettingsProvider query="">{children}</EnvSettingsProvider>,
    })
    await waitFor(() => expect(result.current.error).toBe('Permintaan gagal. Coba lagi.'))
    expect(result.current.state).toBeNull()
  })

  it('useEnvSettingsContext throws outside a provider', () => {
    expect(() => renderHook(() => useEnvSettingsContext())).toThrow(/EnvSettingsProvider/)
  })
})
