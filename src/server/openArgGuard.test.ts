import { describe, expect, it } from 'vitest'
import { assertPathArg } from './openArgGuard'
import { openWithSystem } from './uiOpen'

describe('assertPathArg', () => {
  it.each(['/Users/me/project', 'relative/dir', '/tmp/x.html', 'C:\\Users\\me', 'C:/Users/me', '/tmp/a:b/c'])('lets path %s through', (p) => {
    expect(assertPathArg(p, 'test')).toBe(p)
  })
  it.each(['https://example.com', 'http://127.0.0.1:8700/x', 'file:///tmp/x.html', 'mailto:a@b.c', 'javascript:alert(1)', 'HTTPS://X.TEST'])('refuses URL %s', (u) => {
    expect(() => assertPathArg(u, 'test')).toThrow(/refusing to hand a URL/)
  })
})

describe('openWithSystem', () => {
  it('refuses a URL before anything is launched', () => {
    expect(() => openWithSystem('https://example.com')).toThrow(/refusing to hand a URL/)
  })
})
