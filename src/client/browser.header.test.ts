import { describe, expect, it } from 'vitest'
import { browserHeaderLabels as h } from './browser.header'

const FALLBACK = 'Browser'
describe('browser node header labels', () => {
  it('shows the host once when the page title is only the URL', () => {
    const url = 'https://www.google.com/search?q=lark'
    expect(h({ pageTitle: url, url, fallback: FALLBACK })).toEqual({ title: 'www.google.com', description: '', hint: url })
  })
  it('shows an empty title as the host, and no page as the fallback', () => {
    expect(h({ pageTitle: '', url: 'https://a.test/x', fallback: FALLBACK }).title).toBe('a.test')
    expect(h({ fallback: FALLBACK })).toEqual({ title: FALLBACK, description: '', hint: undefined })
    expect(h({ pageTitle: 'x', url: 'about:blank', fallback: FALLBACK }).description).toBe('')
  })
  it('keeps a real page title and adds the host only when it adds information', () => {
    expect(h({ pageTitle: 'Lark - Google', url: 'https://www.google.com/', fallback: FALLBACK })).toMatchObject({ title: 'Lark - Google', description: 'www.google.com' })
    expect(h({ pageTitle: 'www.google.com home', url: 'https://www.google.com/', fallback: FALLBACK }).description).toBe('')
  })
  it('a user-chosen node title wins and keeps the host as description', () => {
    expect(h({ userTitle: 'Docs', pageTitle: 'https://x.test/', url: 'https://x.test/', fallback: FALLBACK })).toMatchObject({ title: 'Docs', description: 'x.test' })
  })
})
