import { describe, expect, it } from 'vitest'
import { pickFavicon } from './browser.favicon'
import type { IconLink } from './browser.favicon'

const page = 'https://app.test/dash/index.html'
const link = (href: string, extra: Partial<IconLink> = {}): IconLink => ({ rel: 'icon', href, ...extra })

describe('pickFavicon', () => {
  it('prefers an SVG over any raster', () => {
    const links = [link('https://app.test/a.png', { sizes: '32x32' }), link('https://app.test/a.svg', { type: 'image/svg+xml' }), link('https://app.test/b.png', { sizes: '64x64' })]
    expect(pickFavicon(links, page)).toBe('https://app.test/a.svg')
  })

  it('takes the smallest raster that is still crisp at 2x (>= 32px)', () => {
    const links = [link('https://app.test/16.png', { sizes: '16x16' }), link('https://app.test/192.png', { sizes: '192x192' }), link('https://app.test/32.png', { sizes: '32x32' }), link('https://app.test/48.png', { sizes: '48x48' })]
    expect(pickFavicon(links, page)).toBe('https://app.test/32.png')
  })

  it('ranks an undeclared size above a too-small one, and the largest too-small one wins among those', () => {
    expect(pickFavicon([link('https://app.test/16.png', { sizes: '16x16' }), link('https://app.test/plain.png')], page)).toBe('https://app.test/plain.png')
    expect(pickFavicon([link('https://app.test/16.png', { sizes: '16x16' }), link('https://app.test/24.png', { sizes: '24x24' })], page)).toBe('https://app.test/24.png')
  })

  it('treats sizes="any" as a vector', () => {
    expect(pickFavicon([link('https://app.test/32.png', { sizes: '32x32' }), link('https://app.test/any.ico', { sizes: 'any' })], page)).toBe('https://app.test/any.ico')
  })

  it('uses apple-touch and mask icons only when the page declares no rel=icon', () => {
    const apple = { rel: 'apple-touch-icon', href: 'https://app.test/apple.png', sizes: '180x180' }
    expect(pickFavicon([apple, link('https://app.test/16.png', { sizes: '16x16' })], page)).toBe('https://app.test/16.png')
    expect(pickFavicon([apple], page)).toBe('https://app.test/apple.png')
    expect(pickFavicon([{ rel: 'mask-icon', href: 'https://app.test/m.svg' }], page)).toBe('https://app.test/m.svg')
  })

  it('understands "shortcut icon" and mixed-case rel', () => {
    expect(pickFavicon([{ rel: 'Shortcut ICON', href: 'https://app.test/s.ico' }], page)).toBe('https://app.test/s.ico')
  })

  it('ignores dark-only media variants', () => {
    const links = [link('https://app.test/dark.svg', { media: '(prefers-color-scheme: dark)' }), link('https://app.test/light.png', { sizes: '32x32' })]
    expect(pickFavicon(links, page)).toBe('https://app.test/light.png')
  })

  it('falls back to <origin>/favicon.ico without a usable declaration', () => {
    expect(pickFavicon([], page)).toBe('https://app.test/favicon.ico')
    expect(pickFavicon([link('javascript:alert(1)'), link('ftp://x.test/i.ico')], 'http://localhost:3000/x')).toBe('http://localhost:3000/favicon.ico')
  })

  it('keeps an inline data: icon (dev apps use emoji SVGs) but refuses non-image data', () => {
    const svg = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E'
    expect(pickFavicon([link(svg)], page)).toBe(svg)
    expect(pickFavicon([link('data:text/html,<b>x</b>')], page)).toBe('https://app.test/favicon.ico')
  })

  it('has no icon for pages without an origin', () => {
    expect(pickFavicon([link('https://app.test/a.png')], 'about:blank')).toBeNull()
    expect(pickFavicon([], '')).toBeNull()
    expect(pickFavicon([], 'chrome-error://chromewebdata/')).toBeNull()
  })

  it('keeps document order between equals and survives junk entries', () => {
    const links = [link('https://app.test/one.png', { sizes: '32x32' }), link('https://app.test/two.png', { sizes: '32x32' }), { rel: 5, href: 7 } as unknown as IconLink]
    expect(pickFavicon(links, page)).toBe('https://app.test/one.png')
  })
})
