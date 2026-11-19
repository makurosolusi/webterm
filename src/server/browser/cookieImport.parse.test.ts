import { describe, expect, it } from 'vitest'
import { COOKIE_BODY_MAX_BYTES } from '../../shared/browser.contract'
import { CookieImportError, domainKey, parseCookies } from './cookieImport.parse'

const CANARY = 'cv-canary-7f3a' // test-only: nilai cookie sintetis

function codeOf(fn: () => unknown): { code: string; message: string; line?: number } {
  try { fn() } catch (e) {
    expect(e).toBeInstanceOf(CookieImportError)
    const err = e as CookieImportError
    return { code: err.code, message: err.message, line: err.line }
  }
  throw new Error('expected throw')
}

describe('parseCookies storageState', () => {
  it('parses cookies from a storageState object', () => {
    const state = { cookies: [
      { name: 'sid', value: CANARY, domain: '.Example.com', path: '/a', expires: 1900000000, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 's2', value: 'x', domain: 'b.org', expires: -1 },
    ], origins: [] }
    const [a, b] = parseCookies('storageState', JSON.stringify(state))
    expect(a).toEqual({ name: 'sid', value: CANARY, domain: '.example.com', path: '/a', expires: 1900000000, httpOnly: true, secure: true, sameSite: 'Lax' })
    expect(b).toMatchObject({ domain: 'b.org', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: undefined })
  })

  it('reads Cookie-Editor fields: expirationDate and no_restriction', () => {
    const [c] = parseCookies('storageState', JSON.stringify([{ name: 'a', value: 'v', domain: 'x.com', expirationDate: 1900000000.5, sameSite: 'no_restriction' }])) // test-only
    expect(c).toMatchObject({ expires: 1900000000.5, sameSite: 'None' })
  })

  it('accepts a bare cookie array', () => {
    expect(parseCookies('storageState', JSON.stringify([{ name: 'a', value: '', domain: 'x.com' }]))).toHaveLength(1)
  })

  it('rejects broken JSON without leaking content', () => {
    const r = codeOf(() => parseCookies('storageState', `{"cookies": [{"value":"${CANARY}"`))
    expect(r.code).toBe('invalid_json')
    expect(r.message).not.toContain(CANARY)
  })

  it('rejects wrong shapes and invalid cookies without leaking content', () => {
    expect(codeOf(() => parseCookies('storageState', '{"cookies":"x"}')).code).toBe('invalid_shape')
    expect(codeOf(() => parseCookies('storageState', 'null')).code).toBe('invalid_shape')
    const bad = codeOf(() => parseCookies('storageState', JSON.stringify({ cookies: [{ name: 'a', value: CANARY }] })))
    expect(bad.code).toBe('invalid_cookie')
    expect(bad.message).not.toContain(CANARY)
    expect(codeOf(() => parseCookies('storageState', '{"cookies":[]}')).code).toBe('no_cookies')
  })

  it('enforces the body size limit', () => {
    const big = ' '.repeat(COOKIE_BODY_MAX_BYTES + 1)
    expect(codeOf(() => parseCookies('storageState', big)).code).toBe('too_large')
    expect(codeOf(() => parseCookies('netscape', big)).code).toBe('too_large')
  })
})

describe('parseCookies netscape', () => {
  const T = '\t'
  it('parses lines, HttpOnly prefix, comments and session expiry', () => {
    const txt = [
      '# Netscape HTTP Cookie File', '',
      ['.example.com', 'TRUE', '/', 'TRUE', '1900000000', 'sid', CANARY].join(T),
      ['#HttpOnly_host.org', 'FALSE', '/p', 'FALSE', '0', 'h', 'v2'].join(T),
      ['bare.net', 'TRUE', '/', 'FALSE', '5', 'n'].join(T), // value hilang
    ].join('\r\n')
    const [a, b, c] = parseCookies('netscape', txt)
    expect(a).toEqual({ name: 'sid', value: CANARY, domain: '.example.com', path: '/', secure: true, httpOnly: false, expires: 1900000000 })
    expect(b).toMatchObject({ domain: 'host.org', httpOnly: true, secure: false, expires: -1, path: '/p' })
    expect(c).toMatchObject({ domain: '.bare.net', name: 'n', value: '' }) // includeSubdomains TRUE -> titik di depan
  })

  it('reports the line number only on malformed lines', () => {
    const r = codeOf(() => parseCookies('netscape', `# c\nnot-a-cookie-${CANARY}\n`))
    expect(r).toMatchObject({ code: 'invalid_cookie', line: 2 })
    expect(r.message).not.toContain(CANARY)
    expect(codeOf(() => parseCookies('netscape', ['a.com', 'TRUE', '/', 'FALSE', 'xx', 'n', 'v'].join(T))).code).toBe('invalid_cookie')
    expect(codeOf(() => parseCookies('netscape', '# only comments\n')).code).toBe('no_cookies')
  })
})

describe('domainKey', () => {
  it('lowercases and strips the leading dot', () => {
    expect(domainKey('.Example.COM')).toBe('example.com')
    expect(domainKey('a.org')).toBe('a.org')
  })
})
