import { describe, expect, it } from 'vitest'
import { buildUpstreamHeaders, filterResponseHeaders, presentedToken, tokensEqual } from './credentialProxy.headers'
import type { Upstream } from './credentialProxy.types'

const REAL = 'sk-ant-real-secret' // test-only
const up = (over: Partial<Upstream> = {}): Upstream => ({ baseUrl: 'https://api.example.com', kind: 'xApiKey', secret: REAL, headers: {}, ...over })
const incoming = (): Headers => new Headers({
  'x-api-key': 'placeholder', authorization: 'Bearer placeholder', host: '127.0.0.1:1', cookie: 'a=b', 'content-length': '5',
  connection: 'keep-alive', 'transfer-encoding': 'chunked', 'x-forwarded-for': '1.2.3.4', forwarded: 'for=1', 'proxy-authorization': 'x',
  'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'b', 'x-stainless-os': 'Mac', 'x-claude-code-session-id': 's', 'user-agent': 'ua',
})

describe('buildUpstreamHeaders', () => {
  it('keeps only allowlisted headers and injects x-api-key', () => {
    const h = buildUpstreamHeaders(incoming(), up())
    expect(h.get('x-api-key')).toBe(REAL)
    expect(h.get('authorization')).toBeNull()
    for (const n of ['host', 'cookie', 'content-length', 'connection', 'transfer-encoding', 'x-forwarded-for', 'forwarded', 'proxy-authorization']) expect(h.has(n)).toBe(false)
    for (const n of ['content-type', 'anthropic-version', 'anthropic-beta', 'x-stainless-os', 'x-claude-code-session-id', 'user-agent']) expect(h.has(n)).toBe(true)
  })

  it('injects Authorization Bearer and no x-api-key for bearer upstreams', () => {
    const h = buildUpstreamHeaders(incoming(), up({ kind: 'bearer' }))
    expect(h.get('authorization')).toBe(`Bearer ${REAL}`)
    expect(h.has('x-api-key')).toBe(false)
  })

  it('applies custom headers but never lets them override the credential or transport headers', () => {
    const h = buildUpstreamHeaders(incoming(), up({ headers: { 'X-Gateway': 'g', 'x-api-key': 'evil', Host: 'evil', 'Proxy-Foo': 'x' } }))
    expect(h.get('x-gateway')).toBe('g')
    expect(h.get('x-api-key')).toBe(REAL)
    expect(h.has('host')).toBe(false)
    expect(h.has('proxy-foo')).toBe(false)
  })
})

describe('token helpers', () => {
  it('reads x-api-key first, then Bearer', () => {
    expect(presentedToken(new Headers({ 'x-api-key': 'a', authorization: 'Bearer b' }))).toBe('a')
    expect(presentedToken(new Headers({ authorization: 'bearer b' }))).toBe('b')
    expect(presentedToken(new Headers())).toBeNull()
  })
  it('compares exactly', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true)
    expect(tokensEqual('abc', 'abd')).toBe(false)
    expect(tokensEqual('abc', 'abcd')).toBe(false)
    expect(tokensEqual(null, 'abc')).toBe(false)
  })
})

describe('filterResponseHeaders', () => {
  it('drops transfer, encoding and cookie headers', () => {
    const h = filterResponseHeaders(new Headers({ 'content-type': 'text/event-stream', 'content-length': '9', 'content-encoding': 'gzip', 'set-cookie': 'a=b', 'request-id': 'r', 'anthropic-ratelimit-requests-remaining': '3' }))
    expect([...h.keys()].sort()).toEqual(['anthropic-ratelimit-requests-remaining', 'content-type', 'request-id'])
  })
})
