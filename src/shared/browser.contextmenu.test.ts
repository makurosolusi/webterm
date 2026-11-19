import { describe, expect, it } from 'vitest'
import { CTX_HREF_MAX, CTX_TEXT_MAX, sanitizeContext, webUrl } from './browser.contextmenu'
import { parseClientMsg } from './browser.wire'

describe('webUrl', () => {
  it('accepts http and https only', () => {
    expect(webUrl('https://a.test/x?y=1')).toBe('https://a.test/x?y=1')
    expect(webUrl('http://a.test')).toBe('http://a.test/')
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'chrome://settings', 'about:blank', 'blob:https://a.test/1', 'ftp://a.test', '//a.test', 'a.test', '', 5, null]) expect(webUrl(bad)).toBeUndefined()
  })

  it('refuses an address over the cap', () => {
    expect(webUrl(`https://a.test/${'x'.repeat(CTX_HREF_MAX)}`)).toBeUndefined()
  })
})

describe('sanitizeContext', () => {
  it('keeps clean fields, collapses whitespace and caps the link text', () => {
    const r = sanitizeContext({ link: { href: 'https://a.test/', text: `  hello \n world ${'z'.repeat(500)}` }, selection: true, editable: false })
    expect(r?.link?.href).toBe('https://a.test/')
    expect(r?.link?.text.startsWith('hello world')).toBe(true)
    expect(r?.link?.text.length).toBeLessThanOrEqual(CTX_TEXT_MAX)
    expect(r).toMatchObject({ selection: true, editable: false })
  })

  it('drops hostile or non-boolean fields and rejects garbage and oversize input', () => {
    expect(sanitizeContext({ link: { href: 'javascript:1' }, image: 'data:image/png;base64,AA', selection: 'true', editable: 1 })).toEqual({ selection: false, editable: false })
    expect(sanitizeContext('{not json')).toBeNull()
    expect(sanitizeContext(['x'])).toBeNull()
    expect(sanitizeContext(null)).toBeNull()
    expect(sanitizeContext(JSON.stringify({ link: { href: 'https://a.test/', text: 'x'.repeat(20_000) } }))).toBeNull()
  })
})

describe('openLink message', () => {
  it('parses a web address and refuses everything else', () => {
    expect(parseClientMsg({ t: 'openLink', id: 'n1', url: 'https://a.test/' })).toEqual({ t: 'openLink', id: 'n1', url: 'https://a.test/' })
    expect(parseClientMsg({ t: 'openLink', id: 'n1', url: 'https://a.test/', tab: 't1' })).toMatchObject({ tab: 't1' })
    expect(parseClientMsg({ t: 'openLink', id: 'n1', url: 'javascript:alert(1)' })).toBeNull()
    expect(parseClientMsg({ t: 'openLink', id: 'n1', url: 'file:///etc/passwd' })).toBeNull()
    expect(parseClientMsg({ t: 'openLink', id: 'n1' })).toBeNull()
  })
})
