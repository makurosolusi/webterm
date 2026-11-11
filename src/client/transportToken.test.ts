/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTH_LOGIN_PATH, AUTH_ME_PATH, exchangeLandingToken, fetchMe, isAbortError, requestOpen, TOKEN_PARAM } from './transportToken'

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

/** /auth/me answers with `tokenSignIn`; /auth/login with `login()`. */
const stubAuth = (tokenSignIn: boolean, login: () => Response | Promise<Response>) => {
  const f = vi.fn(async (url: string, _init?: RequestInit) =>
    url === AUTH_ME_PATH ? new Response(JSON.stringify({ signedIn: false, setupRequired: tokenSignIn, user: null, tokenSignIn }), { status: 200 }) : login())
  vi.stubGlobal('fetch', f)
  return f
}
const posts = (f: ReturnType<typeof stubAuth>) => f.mock.calls.filter((c) => c[0] === AUTH_LOGIN_PATH)

describe('exchangeLandingToken: a `/?token=` link becomes the session cookie while no account exists', () => {
  it('strips the token from the address bar BEFORE posting it to /auth/login, keeping the rest', async () => {
    history.replaceState(null, '', `/?x=1&${TOKEN_PARAM}=secret#inbox`)
    let urlAtPost = ''
    const f = stubAuth(true, () => { urlAtPost = location.href; return new Response(null, { status: 204 }) })
    await exchangeLandingToken()
    expect(location.pathname + location.search + location.hash).toBe('/?x=1#inbox')
    expect(urlAtPost).not.toContain('secret')
    expect(posts(f)).toHaveLength(1)
    expect(posts(f)[0]![1]).toMatchObject({ method: 'POST', body: JSON.stringify({ token: 'secret' }) })
  })

  it('once an account exists (tokenSignIn false) the parameter is stripped and ignored: nothing is posted', async () => {
    history.replaceState(null, '', `/w/a?${TOKEN_PARAM}=secret`)
    const f = stubAuth(false, () => new Response(null, { status: 204 }))
    await exchangeLandingToken()
    expect(location.pathname + location.search).toBe('/w/a')
    expect(posts(f)).toEqual([])
    for (const call of f.mock.calls) expect(JSON.stringify(call)).not.toContain('secret')
  })

  it('does nothing without the parameter; a refused or unreachable exchange never rejects', async () => {
    const f = stubAuth(true, () => new Response(null, { status: 403 }))
    await exchangeLandingToken()
    expect(f).not.toHaveBeenCalled()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    history.replaceState(null, '', `/?${TOKEN_PARAM}=wrong`)
    await expect(exchangeLandingToken()).resolves.toBe(undefined)
    stubAuth(true, () => Promise.reject(new TypeError('network down')))
    history.replaceState(null, '', `/?${TOKEN_PARAM}=wrong`)
    await expect(exchangeLandingToken()).resolves.toBe(undefined)
    expect(location.search).toBe('')
    expect(warn).toHaveBeenCalledTimes(2)
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain('wrong') // never log the token
  })
})

describe('fetchMe', () => {
  it('reads every field and defaults a missing or malformed one to signed out', async () => {
    stubFetch(() => new Response(JSON.stringify({ signedIn: true, setupRequired: false, user: { id: 3, username: 'ada' }, tokenSignIn: false }), { status: 200 }))
    expect(await fetchMe()).toEqual({ signedIn: true, setupRequired: false, user: { id: 3, username: 'ada' }, tokenSignIn: false })
    stubFetch(() => new Response(JSON.stringify({ signedIn: 'yes', user: { id: '3' } }), { status: 200 }))
    expect(await fetchMe()).toEqual({ signedIn: false, setupRequired: false, user: null, tokenSignIn: false })
    stubFetch(() => new Response(null, { status: 500 }))
    await expect(fetchMe()).rejects.toThrow(`GET ${AUTH_ME_PATH} -> 500`)
  })
})

describe('requestOpen', () => {
  it('reports the status and the Retry-After seconds of a 429', async () => {
    stubFetch(() => new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }))
    expect(await requestOpen()).toEqual({ status: 429, retryAfterS: 7 })
    const f = stubFetch(() => new Response('{}', { status: 202 }))
    expect(await requestOpen('/w/a?settings=account')).toEqual({ status: 202, retryAfterS: 0 })
    expect(f.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: JSON.stringify({ next: '/w/a?settings=account' }) })
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
