/** @vitest-environment jsdom */
// `useGitBranches`: one request for all folders, refetch on window focus, nothing on failure.
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGitBranches } from './useGitBranches'
import { GIT_INFO_PATH } from '../shared/gitInfo'

const ok = (results: unknown[]) => new Response(JSON.stringify({ results }))

afterEach(() => vi.unstubAllGlobals())

describe('useGitBranches', () => {
  it('posts every distinct folder in ONE request and maps branch by cwd', async () => {
    const fetchMock = vi.fn(async () => ok([
      { path: '/a', state: 'repo', repo: { branch: 'main' } },
      { path: '/b', state: 'repo', repo: { branch: null } }, // detached HEAD: no branch
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useGitBranches(['/b', undefined, '/a', '/a']))
    await waitFor(() => expect(result.current).toEqual({ '/a': 'main' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(GIT_INFO_PATH)
    expect(JSON.parse(init.body as string)).toEqual({ paths: ['/a', '/b'] })

    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('a failed lookup shows no branch and warns with context', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderHook(() => useGitBranches(['/a']))
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(String(warn.mock.calls[0]?.[0])).toContain('git branch lookup failed')
    expect(result.current).toEqual({})
    warn.mockRestore()
  })

  it('no folders: no request', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderHook(() => useGitBranches([undefined, '']))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
