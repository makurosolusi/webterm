import { describe, expect, it } from 'vitest'
import { MAX_FAVICON_BYTES } from '../../shared/browser.favicon'
import { decodeDataUrl, faviconDataUri, isSafeSvg, sniffImage } from './browser.favicon.image'
import { faviconAllowed } from './browser.favicon.policy'
import { stubGuard } from './fakeCdp.testkit'

const bytes = (...n: number[]) => new Uint8Array(n)
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0)
const text = (s: string) => new TextEncoder().encode(s)
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="#0a0"/></svg>'

describe('sniffImage', () => {
  it('recognises every accepted type by its magic bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(sniffImage(text('GIF89a....'))).toBe('image/gif')
    expect(sniffImage(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(bytes(0, 0, 1, 0, 1, 0))).toBe('image/x-icon')
    expect(sniffImage(text(SVG))).toBe('image/svg+xml')
    expect(sniffImage(text(`﻿<?xml version="1.0"?>\n<!-- c -->\n${SVG}`))).toBe('image/svg+xml')
  })

  it('rejects HTML error pages, cursors, scripts and short junk (Content-Type is never consulted)', () => {
    expect(sniffImage(text('<!doctype html><html><body>404</body></html>'))).toBeNull()
    expect(sniffImage(bytes(0, 0, 2, 0, 1, 0))).toBeNull()
    expect(sniffImage(text('<script>alert(1)</script>'))).toBeNull()
    expect(sniffImage(bytes(1, 2))).toBeNull()
  })
})

describe('faviconDataUri', () => {
  it('wraps a good image as a base64 data URI of the sniffed type', () => {
    expect(faviconDataUri(PNG)).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
    expect(faviconDataUri(text(SVG))).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it('refuses empty, oversize and unknown payloads', () => {
    expect(faviconDataUri(new Uint8Array())).toBeNull()
    const big = new Uint8Array(MAX_FAVICON_BYTES + 1)
    big.set(PNG)
    expect(faviconDataUri(big)).toBeNull()
    expect(faviconDataUri(text('hello world'))).toBeNull()
  })

  it('accepts a payload exactly at the cap', () => {
    const edge = new Uint8Array(MAX_FAVICON_BYTES)
    edge.set(PNG)
    expect(faviconDataUri(edge)).not.toBeNull()
  })

  it.each([
    ['script element', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['foreignObject', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>'],
    ['event handler', '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><rect/></svg>'],
    ['external href', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/t.png"/></svg>'],
    ['external xlink:href', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://evil.test/a.svg#x"/></svg>'],
    ['javascript url', '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>'],
    ['css import', '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.test/x.css);</style></svg>'],
    ['css external url', '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.test/p.svg#a)"/></svg>'],
    ['entity', '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['animate', '<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="href" values="javascript:alert(1)"/></a></svg>'],
  ])('refuses an SVG with a %s', (_name, svg) => {
    expect(isSafeSvg(svg)).toBe(false)
    expect(faviconDataUri(text(svg))).toBeNull()
  })

  it('keeps an SVG that only uses in-document references and plain styles', () => {
    const ok = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><style>.a{fill:url(#g)}</style><use href="#g"/><rect class="a"/></svg>'
    expect(isSafeSvg(ok)).toBe(true)
    expect(faviconDataUri(text(ok))).not.toBeNull()
  })
})

describe('decodeDataUrl', () => {
  it('decodes percent-encoded and base64 inline icons, and refuses malformed ones', () => {
    expect(new TextDecoder().decode(decodeDataUrl('data:image/svg+xml,%3Csvg%2F%3E') as Uint8Array)).toBe('<svg/>')
    expect(new TextDecoder().decode(decodeDataUrl(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`) as Uint8Array)).toBe('<svg/>')
    expect(decodeDataUrl('data:image/svg+xml,%E0%A4%A')).toBeNull()
    expect(decodeDataUrl(`data:image/png;base64,${'A'.repeat(MAX_FAVICON_BYTES * 2)}`)).toBeNull()
    expect(decodeDataUrl('https://x.test/')).toBeNull()
  })
})

describe('faviconAllowed (SSRF)', () => {
  const guard = stubGuard(['internal.test'])
  it('always allows an icon from the page\'s own origin, even on localhost', () => {
    expect(faviconAllowed('http://localhost:3000/favicon.ico', 'http://localhost:3000/app', guard)).toBe(true)
    expect(faviconAllowed('https://app.test/i.png', 'https://app.test/', guard)).toBe(true)
  })

  it('allows a public cross-origin icon', () => {
    expect(faviconAllowed('https://cdn.test/i.png', 'https://app.test/', guard)).toBe(true)
  })

  it('refuses a public page pointing at loopback or private addresses', () => {
    for (const u of ['http://localhost:8700/api', 'http://127.0.0.1/x.png', 'http://10.0.0.5/x.png', 'http://[::1]/x.png', 'http://foo.localhost/x.png']) {
      expect(faviconAllowed(u, 'https://app.test/', guard), u).toBe(false)
    }
  })

  it('refuses what the navigation guard refuses, and non-http schemes', () => {
    expect(faviconAllowed('https://internal.test/i.png', 'https://app.test/', guard)).toBe(false)
    expect(faviconAllowed('file:///etc/passwd', 'https://app.test/', guard)).toBe(false)
    expect(faviconAllowed('https://cdn.test/i.png', 'about:blank', guard)).toBe(false)
  })

  it('lets a local dev page use another local origin', () => {
    expect(faviconAllowed('http://127.0.0.1:4000/i.png', 'http://localhost:3000/', guard)).toBe(true)
  })
})
