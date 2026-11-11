// index.html head: tab icon, PWA/theme meta and link-preview tags, plus every local asset they
// point at must exist in the Vite public dir (a missing one falls through to the SPA index.html).
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { faviconSvg } from './osNotify.badge'
import { ORIGIN_PLACEHOLDER } from '../server/staticAssets.origin'

const CLIENT = __dirname
const PUBLIC = join(CLIENT, 'public')
const html = readFileSync(join(CLIENT, 'index.html'), 'utf8')

/** `content` of the meta whose `name` or `property` is `key`, or undefined. */
function meta(key: string): string | undefined {
  const tag = html.match(new RegExp(`<meta (?:name|property)="${key.replace(/[.:]/g, '\\$&')}" content="([^"]*)"`))
  return tag?.[1]
}

describe('index.html head', () => {
  it('links one svg icon and the apple-touch icon', () => {
    expect(html.match(/<link rel="icon"/g)).toHaveLength(1)
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />')
    expect(html).toContain('<link rel="apple-touch-icon" href="/m/apple-touch-icon.png" />')
  })

  it('carries description, color-scheme and light/dark theme-color', () => {
    expect(meta('description')).toBeTruthy()
    expect(meta('color-scheme')).toBe('dark light')
    expect(html).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: light\)"/)
    expect(html).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)"/)
  })

  it('carries Open Graph and Twitter card tags with absolute, placeholder-origin image URLs', () => {
    expect(meta('og:type')).toBe('website')
    expect(meta('og:site_name')).toBe('webterm')
    expect(meta('og:title')).toBe('webterm')
    expect(meta('og:description')).toBeTruthy()
    expect(meta('og:image')).toBe(`${ORIGIN_PLACEHOLDER}/og-image.png`)
    expect(meta('og:image:width')).toBe('1200')
    expect(meta('og:image:height')).toBe('630')
    expect(meta('og:image:type')).toBe('image/png')
    expect(meta('og:image:alt')).toBeTruthy()
    expect(meta('twitter:card')).toBe('summary_large_image')
    expect(meta('twitter:title')).toBe('webterm')
    expect(meta('twitter:description')).toBeTruthy()
    expect(meta('twitter:image')).toBe(`${ORIGIN_PLACEHOLDER}/og-image.png`)
  })

  it('every referenced local asset exists in the public dir', () => {
    const refs = [...html.matchAll(/(?:href|content)="(?:https:\/\/webterm\.invalid)?(\/[^"]+\.(?:svg|png|ico|json))"/g)].map((m) => m[1])
    expect(refs).toEqual(expect.arrayContaining(['/favicon.svg', '/m/apple-touch-icon.png', '/og-image.png']))
    for (const ref of refs) expect(existsSync(join(PUBLIC, ref)), ref).toBe(true)
  })

  it('public/favicon.svg is the badge-free tab icon, so the two cannot drift', () => {
    expect(readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8').trim()).toBe(faviconSvg(0))
  })

  it('og-image.png is a 1200x630 PNG under 300 KB', () => {
    const png = readFileSync(join(PUBLIC, 'og-image.png'))
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630])
    expect(png.length).toBeLessThan(300 * 1024)
  })
})
