import { describe, expect, it } from 'vitest'
import { cleanShortcut } from './browser.shortcuts'

describe('cleanShortcut uses the omnibox address rules', () => {
  it.each([
    ['github.com', 'https://github.com/'],
    ['localhost:5173', 'http://localhost:5173/'],
    ['192.168.1.5:3000', 'http://192.168.1.5:3000/'],
    ['intranet:8080', 'http://intranet:8080/'],
    ['nas.local', 'http://nas.local/'],
    ['http://example.com/x', 'http://example.com/x'],
    ['kucing', 'https://kucing/'], // a URL field never searches: bare word = https host
  ])('%s -> %s', (raw, url) => expect(cleanShortcut('', raw)?.url).toBe(url))

  it('rejects other schemes and userinfo; empty name falls back to the host', () => {
    expect(cleanShortcut('x', 'javascript:alert(1)')).toBeNull()
    expect(cleanShortcut('x', 'https://u:p@a.com')).toBeNull()
    expect(cleanShortcut('  ', 'intranet:8080')).toEqual({ label: 'intranet', url: 'http://intranet:8080/' })
  })
})
