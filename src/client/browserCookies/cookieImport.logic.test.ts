import { describe, expect, it } from 'vitest'
import { BrowserApiError } from '../browser.api'
import { classifyCookieError, detectCookieFormat, hasCookieExtension, relativeExpiry } from './cookieImport.logic'

const TAB = '\t'
const NETSCAPE = `# Netscape HTTP Cookie File\n\n.example.com${TAB}TRUE${TAB}/${TAB}TRUE${TAB}1900000000${TAB}sid${TAB}v\n` // test-only

describe('detectCookieFormat', () => {
  it('reads JSON objects (Playwright storage state) and arrays (Cookie-Editor)', () => {
    expect(detectCookieFormat('{"cookies":[]}')).toBe('storageState')
    expect(detectCookieFormat('  \n[{"name":"a"}]')).toBe('storageState')
  })
  it('reads Netscape, including HttpOnly rows after the header comments', () => {
    expect(detectCookieFormat(NETSCAPE)).toBe('netscape')
    expect(detectCookieFormat(`# header\n#HttpOnly_.a.com${TAB}TRUE${TAB}/${TAB}TRUE${TAB}0${TAB}n${TAB}v`)).toBe('netscape')
  })
  it('returns null for empty, prose and comment-only input', () => {
    expect(detectCookieFormat('')).toBeNull()
    expect(detectCookieFormat('hello there')).toBeNull()
    expect(detectCookieFormat('# only a comment\n# another')).toBeNull()
  })
})

describe('classifyCookieError', () => {
  const api = (code: string, status = 400) => new BrowserApiError('x', status, code)
  it('maps workspace and profile codes to one kind each', () => {
    expect(classifyCookieError(api('bad_request'))).toBe('invalid')
    expect(classifyCookieError(api('cookie_import_invalid'))).toBe('invalid')
    expect(classifyCookieError(api('cookie_import_empty'))).toBe('empty')
    expect(classifyCookieError(api('cookie_import_disabled', 404))).toBe('disabled')
    expect(classifyCookieError(api('disabled', 404))).toBe('disabled')
    expect(classifyCookieError(api('not_found', 404))).toBe('expired')
    expect(classifyCookieError(api('payload_too_large', 413))).toBe('too_large')
    expect(classifyCookieError(api('http_413', 413))).toBe('too_large')
  })
  it('treats a failed fetch as network and anything else as unknown', () => {
    expect(classifyCookieError(new TypeError('Failed to fetch'))).toBe('network')
    expect(classifyCookieError(api('weird', 500))).toBe('unknown')
    expect(classifyCookieError('boom')).toBe('unknown')
  })
})

describe('helpers', () => {
  it('accepts only .json, .txt and .cookies names', () => {
    expect(['a.JSON', 'b.txt', 'c.cookies'].every(hasCookieExtension)).toBe(true)
    expect(['a.png', 'noext'].some(hasCookieExtension)).toBe(false)
  })
  it('words expiry relative to now', () => {
    const now = 1_000_000
    expect(relativeExpiry(now + 6 * 86_400_000, now)).toBe('in 6 days')
    expect(relativeExpiry(now + 3 * 3_600_000, now)).toBe('in 3 hours')
    expect(relativeExpiry(now + 10_000, now)).toBe('soon')
    expect(relativeExpiry(now - 1, now)).toBe('now')
    expect(relativeExpiry(undefined, now)).toBe('')
  })
})
