// Murni: ketikan -> URL tujuan, dan batas zoom.
import { describe, expect, it } from 'vitest'
import { SEARCH_URL_PREFIX } from './browser.startpage.data'
import { resolveStartInput } from './browser.startpage.resolve'
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, stepZoom, zoomLabel } from './browser.zoom'

describe('resolveStartInput', () => {
  it.each([
    ['https://a.com/x?q=1', 'https://a.com/x?q=1'],
    ['  example.com  ', 'https://example.com/'],
    ['sub.example.co.id/path?x=1', 'https://sub.example.co.id/path?x=1'],
    ['localhost:3000/app', 'http://localhost:3000/app'],
    ['192.168.1.5:8080', 'http://192.168.1.5:8080/'],
  ])('navigates for address %s', (input, url) => expect(resolveStartInput(input)).toBe(url))

  it.each([
    ['cuaca jakarta', 'cuaca%20jakarta'],
    ['example.com/a b', 'example.com%2Fa%20b'],
    ['javascript:alert(1)', 'javascript%3Aalert(1)'],
    ['file:///etc/passwd', 'file%3A%2F%2F%2Fetc%2Fpasswd'],
    ['kucing', 'kucing'],
  ])('searches for %s', (input, q) => expect(resolveStartInput(input)).toBe(SEARCH_URL_PREFIX + q))

  it('returns null for blank input', () => {
    expect(resolveStartInput('')).toBeNull()
    expect(resolveStartInput('   ')).toBeNull()
  })
})

describe('zoom', () => {
  it('steps by 10% without float drift and clamps to the limits', () => {
    expect(stepZoom(ZOOM_DEFAULT, 1)).toBe(1.1)
    expect(stepZoom(1.1, 1)).toBe(1.2)
    expect(stepZoom(0.7, -1)).toBe(0.6)
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
    let z = ZOOM_DEFAULT
    for (let i = 0; i < 50; i++) z = stepZoom(z, 1)
    expect(z).toBe(ZOOM_MAX)
  })
  it('formats the percent label', () => {
    expect(zoomLabel(1)).toBe('100%')
    expect(zoomLabel(1.1)).toBe('110%')
    expect(zoomLabel(0.5)).toBe('50%')
  })
})
