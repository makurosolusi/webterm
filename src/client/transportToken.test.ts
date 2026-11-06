/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTH_LOGIN_PATH, exchangeLandingToken, isAbortError, requestOpen, TOKEN_PARAM } from './transportToken'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  history.replaceState(null, '', '/')
})

const stubFetch = (res: () => Response | Promise<Response>) => {
  const f = vi.fn(async (_url: string, _init?: RequestInit) => res())
  vi.stubGlobal('fetch', f)
  return f
}

describe('exchangeLandingToken: a `/?token=` link becomes the session cookie', () => {
  it('strips the token from the address bar BEFORE posting it to /auth/login, keeping the rest', async () => {
    history.replaceState(null, '', `/?x=1&${TOKEN_PARAM}=secret#inbox`)
    let urlAtPost = ''
    const f = stubFetch(() => { urlAtPost = location.href; return new Response(null, { status: 204 }) })
    await exchangeLandingToken()
    expect(location.pathname + location.search + location.hash).toBe('/?x=1#inbox')
    expect(urlAtPost).not.toContain('secret')
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0]![0]).toBe(AUTH_LOGIN_PATH)
    expect(f.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: JSON.stringify({ token: 'secret' }) })
  })

  it('does nothing without the parameter; a refused or unreachable exchange never rejects', async () => {
    const f = stubFetch(() => new Response(null, { status: 403 }))
    await exchangeLandingToken()
    expect(f).not.toHaveBeenCalled()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    history.replaceState(null, '', `/?${TOKEN_PARAM}=wrong`)
    await expect(exchangeLandingToken()).resolves.toBe(undefined)
    stubFetch(() => Promise.reject(new TypeError('network down')))
    history.replaceState(null, '', `/?${TOKEN_PARAM}=wrong`)
    await expect(exchangeLandingToken()).resolves.toBe(undefined)
    expect(location.search).toBe('')
    expect(warn).toHaveBeenCalledTimes(2)
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain('wrong') // never log the token
  })
})

describe('requestOpen', () => {
  it('reports the status and the Retry-After seconds of a 429', async () => {
    stubFetch(() => new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }))
    expect(await requestOpen()).toEqual({ status: 429, retryAfterS: 7 })
    stubFetch(() => new Response('{}', { status: 202 }))
    expect(await requestOpen()).toEqual({ status: 202, retryAfterS: 0 })
  })
})

describe('isAbortError', () => {
  it('is true only for AbortError-named objects', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true)
    expect(isAbortError(new Error('x'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError('AbortError')).toBe(false)
  })
})
