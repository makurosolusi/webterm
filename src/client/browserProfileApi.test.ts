/** @vitest-environment jsdom */
// REST wrapper of /api/browser/profiles/* (path, method, body, error code) and the list hook that refetches on the frame.
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserApiError } from './browser.api'
import {
  clearProfileCookies, createBrowserProfile, deleteBrowserProfile, duplicateBrowserProfile, exportProfileCookies, importProfileCookies,
  listBrowserProfiles, listProfileCookies, previewProfileCookies, setNodeBrowserProfile, updateBrowserProfile, useBrowserProfiles,
} from './browserProfileApi'

const calls: Array<{ url: string; init: RequestInit }> = []
function stub(status: number, body?: unknown, text?: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(status === 204 ? null : (text ?? JSON.stringify(body ?? {})), { status })
  }))
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0 })

describe('browserProfileApi', () => {
  it('maps each call to its route, method and body', async () => {
    stub(200, { profiles: [] })
    await listBrowserProfiles()
    await listBrowserProfiles('w 1')
    await createBrowserProfile({ name: 'Admin' })
    await updateBrowserProfile('bp-1', { color: 'teal' })
    await duplicateBrowserProfile('bp-1', 'Copy')
    await listProfileCookies('bp-1')
    await previewProfileCookies('bp-1', { format: 'netscape', content: 'x' })
    await importProfileCookies('bp-1', { format: 'storageState', content: '{}' })
    await setNodeBrowserProfile('n1', 'bp-1')
    stub(204)
    await deleteBrowserProfile('bp-1')
    await clearProfileCookies('bp-1', 'a.com')
    await clearProfileCookies('bp-1')
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET /api/browser/profiles', 'GET /api/browser/profiles?workspaceId=w%201', 'POST /api/browser/profiles', 'PUT /api/browser/profiles/bp-1',
      'POST /api/browser/profiles/bp-1/duplicate', 'GET /api/browser/profiles/bp-1/cookies', 'POST /api/browser/profiles/bp-1/cookies/preview',
      'POST /api/browser/profiles/bp-1/cookies/import', 'POST /api/browser/n1/profile', 'DELETE /api/browser/profiles/bp-1',
      'DELETE /api/browser/profiles/bp-1/cookies?domain=a.com', 'DELETE /api/browser/profiles/bp-1/cookies',
    ])
    expect(calls[3].init.body).toBe(JSON.stringify({ color: 'teal' }))
    expect(calls[0].init.body).toBeUndefined()
  })

  it('throws BrowserApiError carrying the server code and never the body', async () => {
    stub(409, { error: 'profile_in_use', secret: 'do-not-echo' })
    const err = await deleteBrowserProfile('bp-1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserApiError)
    expect(err).toMatchObject({ status: 409, code: 'profile_in_use' })
    expect((err as Error).message).not.toContain('do-not-echo')
    stub(500, undefined, 'not json')
    await expect(listBrowserProfiles()).rejects.toMatchObject({ code: 'http_500' })
  })

  it('export returns the file text as is', async () => {
    stub(200, undefined, '{"cookies":[],"origins":[]}')
    expect(await exportProfileCookies('bp-1')).toBe('{"cookies":[],"origins":[]}')
    stub(404, { error: 'profile_not_found' })
    await expect(exportProfileCookies('bp-x')).rejects.toMatchObject({ code: 'profile_not_found' })
  })
})

describe('useBrowserProfiles', () => {
  it('loads once, then refetches when the frame subscription fires', async () => {
    let fire: () => void = () => undefined
    const subscribe = (cb: () => void) => { fire = cb; return () => undefined }
    stub(200, { profiles: [{ id: 'w1', name: 'Default (A)' }] })
    const { result } = renderHook(() => useBrowserProfiles({ workspaceId: 'w1', subscribe }))
    await waitFor(() => expect(result.current.profiles).toHaveLength(1))
    expect(calls[0].url).toBe('/api/browser/profiles?workspaceId=w1')
    stub(200, { profiles: [{ id: 'w1', name: 'Default (A)' }, { id: 'bp-1', name: 'Admin' }] })
    act(() => fire())
    await waitFor(() => expect(result.current.profiles).toHaveLength(2))
  })
  it('exposes a failed load as an error instead of throwing', async () => {
    stub(404, { error: 'disabled' })
    const { result } = renderHook(() => useBrowserProfiles())
    await waitFor(() => expect(result.current.error?.code).toBe('disabled'))
  })
})
