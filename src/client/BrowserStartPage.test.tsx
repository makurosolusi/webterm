/** @vitest-environment jsdom */
// Halaman awal: Enter -> URL/pencarian, pintasan, dan daftar terbaru.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import BrowserStartPage from './BrowserStartPage'
import { addRecent } from './browser.recent'
import { SHORTCUTS } from './browser.startpage.data'
import { SEARCH_ENGINES } from '../shared/browser.omnibox'
import { START_TEXT } from './browser.uxText'

beforeEach(() => { localStorage.clear() })
afterEach(cleanup)

const box = () => screen.getByLabelText(START_TEXT.searchLabel) as HTMLInputElement
const type = (v: string) => { fireEvent.change(box(), { target: { value: v } }); fireEvent.submit(box().closest('form')!) }

describe('BrowserStartPage', () => {
  it('navigates to a normalized url when the input looks like an address', () => {
    const onGo = vi.fn()
    render(<BrowserStartPage onGo={onGo} />)
    type('example.com/a')
    expect(onGo).toHaveBeenCalledExactlyOnceWith('https://example.com/a')
  })

  it('searches when the input is plain text, and ignores empty input', () => {
    const onGo = vi.fn()
    render(<BrowserStartPage onGo={onGo} />)
    type('   ')
    expect(onGo).not.toHaveBeenCalled()
    type('kucing lucu')
    expect(onGo).toHaveBeenCalledExactlyOnceWith(SEARCH_ENGINES.google.prefix + 'kucing%20lucu')
  })

  it('uses the chosen search engine and never navigates a forbidden scheme', () => {
    const onGo = vi.fn()
    render(<BrowserStartPage onGo={onGo} searchEngine="duckduckgo" />)
    expect(box().placeholder).toBe(START_TEXT.searchPlaceholder('DuckDuckGo'))
    type('javascript:alert(1)')
    expect(onGo).not.toHaveBeenCalled()
    type('kucing lucu')
    expect(onGo).toHaveBeenCalledExactlyOnceWith('https://duckduckgo.com/?q=kucing%20lucu')
  })

  it('renders all shortcuts as named buttons and navigates on click', () => {
    const onGo = vi.fn()
    render(<BrowserStartPage onGo={onGo} />)
    expect(SHORTCUTS).toHaveLength(8)
    for (const s of SHORTCUTS) expect(screen.getByRole('button', { name: START_TEXT.open(s.label) })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: START_TEXT.open('GitHub') }))
    expect(onGo).toHaveBeenCalledExactlyOnceWith('https://github.com/')
  })

  it('hides the recent section when empty and lists title + host when present', () => {
    const { unmount } = render(<BrowserStartPage onGo={vi.fn()} />)
    expect(screen.queryByRole('region', { name: START_TEXT.recent })).toBeNull()
    unmount()
    addRecent('https://docs.example.com/guide?x=1', 'Panduan')
    const onGo = vi.fn()
    render(<BrowserStartPage onGo={onGo} />)
    const item = screen.getByRole('button', { name: /Panduan/ })
    expect(item.textContent).toContain('docs.example.com')
    fireEvent.click(item)
    expect(onGo).toHaveBeenCalledExactlyOnceWith('https://docs.example.com/guide')
  })
})
