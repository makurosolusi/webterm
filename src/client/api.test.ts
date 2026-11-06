import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteWorkspace, fetchWorkspaces } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('api: the session cookie is the only credential', () => {
  it('sends requests with no token header and no token query', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', f)
    await fetchWorkspaces()
    f.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await deleteWorkspace('w 1')
    for (const [url, init] of f.mock.calls) {
      expect(url).not.toContain('token=')
      expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/token/i)
    }
    expect(f.mock.calls.map((c) => c[0])).toEqual(['/api/workspaces', '/api/workspaces/w%201'])
  })
})
