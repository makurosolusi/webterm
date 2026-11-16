/** @vitest-environment jsdom */
// The tab icon: static /favicon.svg when nothing is unread, a badged data URL otherwise, always one link.
import { describe, it, expect, beforeEach } from 'vitest'
import { setBadgeCount, setChatBadgeCount, FAVICON_PATH } from './osNotify.badge'

const icons = () => document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')

describe('setBadgeCount', () => {
  beforeEach(() => {
    document.head.innerHTML = `<link rel="icon" href="${FAVICON_PATH}" type="image/svg+xml">` // as index.html ships it
  })

  it('count 0 keeps the static /favicon.svg', () => {
    setBadgeCount(0)
    expect(icons()).toHaveLength(1)
    expect(icons()[0].getAttribute('href')).toBe('/favicon.svg')
    expect(document.title).toBe('webterm')
  })

  it('count 3 swaps in a data URL carrying "3", then 0 restores the static icon', () => {
    setBadgeCount(3)
    expect(icons()).toHaveLength(1)
    const href = icons()[0].getAttribute('href') ?? ''
    expect(href.startsWith('data:image/svg+xml,')).toBe(true)
    expect(decodeURIComponent(href)).toContain('>3</text>')
    expect(document.title).toBe('(3) webterm')
    setBadgeCount(0)
    expect(icons()).toHaveLength(1)
    expect(icons()[0].getAttribute('href')).toBe('/favicon.svg')
  })

  it('a page without an icon link gets exactly one', () => {
    document.head.innerHTML = ''
    setBadgeCount(2)
    setBadgeCount(5)
    expect(icons()).toHaveLength(1)
  })

  it('sums session unread and chat unread into one number', () => {
    setBadgeCount(2)
    setChatBadgeCount(3)
    expect(document.title).toBe('(5) webterm')
    setBadgeCount(0)
    setChatBadgeCount(0)
    expect(document.title).toBe('webterm')
  })
})
