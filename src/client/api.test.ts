import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOKEN_HEADER, clearToken, storeToken, validateToken } from './api'

// Map-backed sessionStorage stub — node has none, and storeToken/clearToken read it at call time.
function fakeStore(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  } as Storage
}

afterEach(() => {
  vi.restoreAllMocks()
  // @ts-expect-error — test-only global teardown
  delete globalThis.sessionStorage
})

describe('validateToken', () => {
  it('sends the candidate token in the auth header and returns true on 2xx', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    const ok = await validateToken('abc')
    expect(ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/workspaces')
    expect((init as RequestInit).headers).toMatchObject({ [TOKEN_HEADER]: 'abc' })
  })

  it('returns false when the server refuses with 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 }) as Response))
    expect(await validateToken('nope')).toBe(false)
  })
})

describe('storeToken / clearToken', () => {
  beforeEach(() => {
    globalThis.sessionStorage = fakeStore()
  })

  it('writes the token under webterm.token and clears it again', () => {
    storeToken('tok-123')
    expect(sessionStorage.getItem('webterm.token')).toBe('tok-123')
    clearToken()
    expect(sessionStorage.getItem('webterm.token')).toBeNull()
  })
})
