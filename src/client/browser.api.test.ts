// REST pembungkus /api/browser/*: path, metode, body, header token, galat tanpa echo body.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserApiError, allowBrowserHosts, clearCookies, commitCookies, getBrowserStatus, listCookieDomains, previewCookies, setAgentControl, takeoverLease } from './browser.api'

const calls: Array<{ url: string; init: RequestInit }> = []
function stub(status: number, body?: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status })
  }))
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0 })

describe('browser.api', () => {
  it('maps each call to its §4.5 route and body', async () => {
    stub(200, {})
    await getBrowserStatus()
    await previewCookies('w1', { format: 'netscape', content: 'x' })
    stub(204)
    await setAgentControl('n1', true)
    await clearCookies('w1', 'a.com')
    await clearCookies('w1')
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET /api/browser/status', 'POST /api/browser/w1/cookies/preview',
      'POST /api/browser/n1/agent-control', 'DELETE /api/browser/w1/cookies/a.com', 'DELETE /api/browser/w1/cookies',
    ])
    expect(calls.map((c) => c.init.body)).toEqual([
      undefined, JSON.stringify({ format: 'netscape', content: 'x' }),
      JSON.stringify({ enabled: true }), undefined, undefined,
    ])
  })

  it('encodes ids and sends the JSON bodies', async () => {
    stub(200, {})
    await takeoverLease('n 1')
    await listCookieDomains('w/1')
    await commitCookies('w1', { previewId: 'p', domains: ['a.com'] })
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'POST /api/browser/n%201/lease', 'GET /api/browser/w%2F1/cookies/domains', 'POST /api/browser/w1/cookies/commit',
    ])
    expect(calls[0]!.init.body).toBe(JSON.stringify({ holder: 'human' }))
    expect(calls[2]!.init.body).toBe(JSON.stringify({ previewId: 'p', domains: ['a.com'] }))
  })

  it('throws a contextual error with the server code and never echoes the body', async () => {
    stub(400, { error: { code: 'bad_request', detail: 'CANARY-COOKIE-VALUE' } })
    const err = await previewCookies('w1', { format: 'netscape', content: 'CANARY-COOKIE-VALUE' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserApiError)
    expect((err as BrowserApiError).code).toBe('bad_request')
    expect((err as BrowserApiError).status).toBe(400)
    expect((err as BrowserApiError).message).toContain('POST /api/browser/w1/cookies/preview')
    expect((err as BrowserApiError).message).not.toContain('CANARY')
  })

  it('falls back to http_<status> for a non-JSON error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 502 })))
    const err = await getBrowserStatus().catch((e: unknown) => e)
    expect((err as BrowserApiError).code).toBe('http_502')
  })

  it('allowBrowserHosts merges into the stored allowlist via the Settings PUT, without duplicates', async () => {
    stub(200, { entries: [{ key: 'WEBTERM_BROWSER_ALLOW_HOSTS', value: 'nas.lan:8080, localhost:3000' }] })
    await allowBrowserHosts(['localhost:3000', '127.0.0.1:3000'])
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(['GET /api/settings/env', 'PUT /api/settings/env'])
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      set: { WEBTERM_BROWSER_ALLOW_HOSTS: 'nas.lan:8080,localhost:3000,127.0.0.1:3000' }, unset: [],
    })
  })
})
