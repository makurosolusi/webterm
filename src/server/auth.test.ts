import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOST,
  TOKEN_HEADER,
  authorize,
  isLoopbackHost,
  requiresToken,
  resolveToken,
  sameOrigin,
  tokensMatch,
} from './auth'

const SELF = 'webterm.test:8700'

describe('sameOrigin', () => {
  it('accepts an Origin whose host matches the request Host', () => {
    expect(sameOrigin({ host: SELF, origin: `http://${SELF}` })).toBe(true)
  })
  it('accepts https on the same host:port (proto is not part of the check)', () => {
    expect(sameOrigin({ host: SELF, origin: `https://${SELF}` })).toBe(true)
  })
  it('rejects a different port on the same host', () => {
    expect(sameOrigin({ host: SELF, origin: 'http://webterm.test:8701' })).toBe(false)
  })
  it('rejects a different host on the same port', () => {
    expect(sameOrigin({ host: SELF, origin: 'http://evil.example:8700' })).toBe(false)
  })
  it('rejects the hostile-page case: 127.0.0.1 server dialled from a web page', () => {
    expect(sameOrigin({ host: '127.0.0.1:8700', origin: 'https://evil.example' })).toBe(false)
  })
  it('rejects Origin: null (sandboxed frame / opaque redirect)', () => {
    expect(sameOrigin({ host: SELF, origin: 'null' })).toBe(false)
  })
  it('rejects a malformed Origin instead of throwing', () => {
    expect(sameOrigin({ host: SELF, origin: 'not a url' })).toBe(false)
  })
  it('allows an absent Origin — non-browser clients (curl, CLI, tests)', () => {
    expect(sameOrigin({ host: SELF })).toBe(true)
  })
  it('rejects an absent Origin when the browser itself reports cross-site', () => {
    expect(sameOrigin({ host: SELF, 'sec-fetch-site': 'cross-site' })).toBe(false)
    expect(sameOrigin({ host: SELF, 'sec-fetch-site': 'same-site' })).toBe(false)
    expect(sameOrigin({ host: SELF, 'sec-fetch-site': 'same-origin' })).toBe(true)
  })
  it('reads the first value when a header arrives repeated', () => {
    expect(sameOrigin({ host: [SELF], origin: [`http://${SELF}`] })).toBe(true)
  })
})

describe('isLoopbackHost / requiresToken', () => {
  it('treats the three loopback spellings as loopback', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1']) {
      expect(isLoopbackHost(h)).toBe(true)
      expect(requiresToken(h)).toBe(false)
    }
  })
  it('treats wildcards and LAN addresses as reachable from outside', () => {
    for (const h of ['0.0.0.0', '::', '192.168.1.20', 'webterm.local']) {
      expect(isLoopbackHost(h)).toBe(false)
      expect(requiresToken(h)).toBe(true)
    }
  })
  it('defaults to loopback', () => {
    expect(isLoopbackHost(DEFAULT_HOST)).toBe(true)
  })
})

describe('resolveToken', () => {
  it('allows loopback with no token (the default dev loop)', () => {
    expect(resolveToken('127.0.0.1', undefined)).toBeUndefined()
    expect(resolveToken('127.0.0.1', '   ')).toBeUndefined()
  })
  it('refuses to start on a non-loopback host with no token, naming the env var', () => {
    expect(() => resolveToken('0.0.0.0', undefined)).toThrow(/WEBTERM_TOKEN/)
    expect(() => resolveToken('0.0.0.0', '')).toThrow(/WEBTERM_TOKEN/)
  })
  it('trims and keeps a configured token', () => {
    expect(resolveToken('0.0.0.0', ' s3cret ')).toBe('s3cret')
  })
  it('never puts the token value in the refusal message', () => {
    // The throw path has no token, but assert the host-only shape so a future edit cannot
    // start interpolating secrets into a message that lands in logs.
    expect(() => resolveToken('10.0.0.5', '')).toThrow(/10\.0\.0\.5/)
  })
})

describe('tokensMatch', () => {
  it('accepts anything when no token is configured', () => {
    expect(tokensMatch(undefined, null)).toBe(true)
    expect(tokensMatch(undefined, 'whatever')).toBe(true)
  })
  it('accepts the right token', () => {
    expect(tokensMatch('s3cret', 's3cret')).toBe(true)
  })
  it('rejects a wrong token of the same length', () => {
    expect(tokensMatch('s3cret', 'S3CRET')).toBe(false)
  })
  it('rejects without throwing when the lengths differ', () => {
    // crypto.timingSafeEqual throws on unequal buffer lengths; the guard must come first.
    expect(() => tokensMatch('s3cret', 'x')).not.toThrow()
    expect(tokensMatch('s3cret', 'x')).toBe(false)
    expect(tokensMatch('s3cret', 's3cret-and-more')).toBe(false)
    expect(tokensMatch('s3cret', '')).toBe(false)
  })
  it('rejects a missing token when one is required', () => {
    expect(tokensMatch('s3cret', null)).toBe(false)
    expect(tokensMatch('s3cret', undefined)).toBe(false)
  })
})

describe('authorize', () => {
  const headers = { host: SELF, origin: `http://${SELF}` }

  it('passes on loopback with no token at all', () => {
    expect(authorize({ headers, expectedToken: undefined })).toBe(true)
  })
  it('fails on a bad origin even when the token is right', () => {
    expect(
      authorize({
        headers: { host: SELF, origin: 'https://evil.example', [TOKEN_HEADER]: 's3cret' },
        expectedToken: 's3cret',
      })
    ).toBe(false)
  })
  it('accepts the token from the header', () => {
    expect(authorize({ headers: { ...headers, [TOKEN_HEADER]: 's3cret' }, expectedToken: 's3cret' })).toBe(true)
  })
  it('accepts the token from the query (the WebSocket handshake has no headers to set)', () => {
    expect(authorize({ headers, expectedToken: 's3cret', queryToken: 's3cret' })).toBe(true)
  })
  it('rejects a wrong or missing token', () => {
    expect(authorize({ headers, expectedToken: 's3cret', queryToken: 'nope' })).toBe(false)
    expect(authorize({ headers, expectedToken: 's3cret' })).toBe(false)
  })
  it('prefers the header over the query so a stale URL cannot downgrade a good request', () => {
    expect(
      authorize({ headers: { ...headers, [TOKEN_HEADER]: 's3cret' }, expectedToken: 's3cret', queryToken: 'nope' })
    ).toBe(true)
  })
})
