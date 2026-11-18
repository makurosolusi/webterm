/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BrowserTabIcon } from './BrowserTabIcon'
import { fakeOverflow, makeState, makeTab, renderStrip } from './browserTabsHarness'

const PNG = 'data:image/png;base64,AA=='
const iconOf = (container: HTMLElement) => container.querySelector('[data-icon]')

describe('BrowserTabIcon states', () => {
  it('shows the page icon from the server data URI, decorative and without a referrer', () => {
    const { container } = render(<BrowserTabIcon tab={makeTab('a', { faviconData: PNG })} />)
    const img = container.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(PNG)
    expect(img.getAttribute('alt')).toBe('')
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(img.className).toContain('bt-favicon')
    expect(iconOf(container)?.getAttribute('data-icon')).toBe('favicon')
  })

  it('never loads a remote url: the url field alone gives the globe', () => {
    const { container } = render(<BrowserTabIcon tab={makeTab('a', { favicon: 'https://tracker.test/i.png' })} />)
    expect(container.querySelector('img')).toBeNull()
    expect(iconOf(container)?.getAttribute('data-icon')).toBe('globe')
  })

  it.each([
    ['a remote url in the data field', 'https://tracker.test/i.png'],
    ['an html data uri', 'data:text/html;base64,PGI+'],
    ['an empty string (cleared)', ''],
  ])('refuses %s', (_n, value) => {
    const { container } = render(<BrowserTabIcon tab={makeTab('a', { faviconData: value })} />)
    expect(container.querySelector('img')).toBeNull()
    expect(iconOf(container)?.getAttribute('data-icon')).toBe('globe')
  })

  it('falls back to the globe when the image fails to decode, and tries again for a new icon', () => {
    const { container, rerender } = render(<BrowserTabIcon tab={makeTab('a', { faviconData: PNG })} />)
    fireEvent.error(container.querySelector('img') as HTMLElement)
    expect(iconOf(container)?.getAttribute('data-icon')).toBe('globe')
    rerender(<BrowserTabIcon tab={makeTab('a', { faviconData: 'data:image/png;base64,AQ==' })} />)
    expect(iconOf(container)?.getAttribute('data-icon')).toBe('favicon')
  })

  it('keeps the priority crashed > loading > discarded > favicon > globe', () => {
    const t = (o: Parameters<typeof makeTab>[1]) => iconOf(render(<BrowserTabIcon tab={makeTab('a', { faviconData: PNG, ...o })} />).container)?.getAttribute('data-icon')
    expect(t({ crashed: true, loading: true, discarded: true })).toBe('crashed')
    expect(t({ loading: true, discarded: true })).toBe('loading')
    expect(t({ discarded: true })).toBe('discarded')
    expect(t({})).toBe('favicon')
    expect(iconOf(render(<BrowserTabIcon tab={makeTab('a', {})} />).container)?.getAttribute('data-icon')).toBe('globe')
  })

  it('a discarded tab keeps its last icon, dimmed; without one it shows the moon', () => {
    const kept = render(<BrowserTabIcon tab={makeTab('a', { discarded: true, faviconData: PNG })} />).container
    expect(kept.querySelector('img')?.className).toContain('bt-icon--dim')
    expect(iconOf(kept)?.getAttribute('data-icon')).toBe('discarded')
    const bare = render(<BrowserTabIcon tab={makeTab('b', { discarded: true })} />).container
    expect(bare.querySelector('img')).toBeNull()
    expect(iconOf(bare)?.getAttribute('data-icon')).toBe('discarded')
  })
})

describe('icon in the strip and the All tabs menu', () => {
  const state = () => makeState([], {
    tabs: [makeTab('a', { faviconData: PNG }), makeTab('b', { faviconData: 'data:image/png;base64,AQ==' }), makeTab('c')],
    activeTabId: 'a',
  })

  it('shows each tab its own icon in the strip', () => {
    renderStrip(state())
    const icon = (id: string) => screen.getAllByRole('tab').find((t) => t.getAttribute('data-tab-id') === id)?.querySelector('[data-icon]')?.getAttribute('data-icon')
    expect(['a', 'b', 'c'].map(icon)).toEqual(['favicon', 'favicon', 'globe'])
  })

  it('shows icons in the All tabs list (the active row carries the check mark instead)', () => {
    renderStrip(state())
    const list = screen.getByRole('tablist')
    act(() => { fakeOverflow(list, 900, 300, 0); fireEvent.scroll(list) }) // All tabs appears once the strip overflows
    fireEvent.click(screen.getByRole('button', { name: 'All tabs' }))
    const menu = screen.getByRole('menu', { name: 'All tabs' })
    const rows = within(menu).getAllByRole('menuitemcheckbox')
    const kinds = rows.map((r) => r.querySelector('[data-icon]')?.getAttribute('data-icon') ?? null)
    expect(kinds.slice(1)).toEqual(['favicon', 'globe'])
  })
})

describe('icon styling', () => {
  const css = readFileSync(join(__dirname, 'browserTabs.css'), 'utf8')
  const rule = /\.bt-favicon\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''

  it('sits on a neutral tint of the theme foreground so dark logos read on dark tabs, with no new hex colour', () => {
    expect(rule).toContain('object-fit: contain')
    expect(rule).toMatch(/background:\s*color-mix\(in srgb, var\(--vscode-foreground/)
    expect(rule).toMatch(/box-shadow:/)
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).toMatch(/\.bt-icon\s*\{[^}]*width:\s*var\(--bui-icon\)/)
  })
})
