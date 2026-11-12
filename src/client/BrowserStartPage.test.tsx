/** @vitest-environment jsdom */
// Halaman awal: Enter -> URL/pencarian, pintasan, dan daftar terbaru.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import BrowserStartPage from './BrowserStartPage'
import { addRecent } from './browser.recent'
import { SHORTCUTS } from './browser.startpage.data'
import { SEARCH_ENGINES } from '../shared/browser.omnibox'
import { START_TEXT } from './browser.uxText'
import { SHORTCUTS_STORAGE_KEY } from './browser.shortcuts'

beforeEach(() => { localStorage.clear() })
afterEach(cleanup)

const tile = (name: string) => screen.getByRole('button', { name: START_TEXT.open(name) })
const saved = () => JSON.parse(localStorage.getItem(SHORTCUTS_STORAGE_KEY) ?? 'null') as { label: string; url: string }[] | null
const dialogSave = (name: string, url: string) => {
  const dlg = screen.getByRole('dialog')
  fireEvent.change(within(dlg).getByLabelText(START_TEXT.nameLabel), { target: { value: name } })
  fireEvent.change(within(dlg).getByLabelText(START_TEXT.urlLabel), { target: { value: url } })
  fireEvent.click(within(dlg).getByRole('button', { name: START_TEXT.save }))
}
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

  it('a tile shows the site favicon and falls back to the letter circle while loading and on error', () => {
    render(<BrowserStartPage onGo={vi.fn()} />)
    const icon = tile('GitHub').querySelector('[data-favicon]')!
    const img = icon.querySelector('img')!
    expect(img.getAttribute('src')).toBe('https://github.com/favicon.ico')
    expect(icon.getAttribute('data-favicon')).toBe('loading')
    expect(icon.textContent).toBe('G') // letter while loading
    fireEvent.load(img)
    expect(icon.getAttribute('data-favicon')).toBe('ok')
    expect(icon.textContent).toBe('')
    const yt = tile('YouTube').querySelector('[data-favicon]')!
    fireEvent.error(yt.querySelector('img')!)
    expect(yt.querySelector('img')).toBeNull()
    expect(yt.textContent).toBe('Y')
  })

  it('adds, edits and removes shortcuts, and the list persists across mounts', () => {
    const onGo = vi.fn()
    const { unmount } = render(<BrowserStartPage onGo={onGo} />)
    expect(saved()).toBeNull() // untouched = defaults, nothing stored
    fireEvent.click(screen.getByRole('button', { name: START_TEXT.add }))
    dialogSave('Docs', 'javascript:alert(1)')
    expect(screen.getByRole('alert').textContent).toBe(START_TEXT.badUrl) // rejected, dialog stays
    dialogSave('Docs', 'docs.example.com/start')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(saved()?.at(-1)).toMatchObject({ label: 'Docs', url: 'https://docs.example.com/start' })

    // Edit via the hover ⋮; remove via right-click.
    fireEvent.click(screen.getByRole('button', { name: START_TEXT.tileMenu('Docs') }))
    fireEvent.click(screen.getByRole('menuitem', { name: `${START_TEXT.edit}…` }))
    expect((within(screen.getByRole('dialog')).getByLabelText(START_TEXT.urlLabel) as HTMLInputElement).value).toBe('https://docs.example.com/start')
    dialogSave('Guide', 'https://guide.example.com/')
    fireEvent.contextMenu(tile('Wikipedia'))
    fireEvent.click(screen.getByRole('menuitem', { name: START_TEXT.remove }))
    unmount()

    render(<BrowserStartPage onGo={onGo} />)
    expect(screen.queryByRole('button', { name: START_TEXT.open('Wikipedia') })).toBeNull()
    expect(screen.queryByRole('button', { name: START_TEXT.open('Docs') })).toBeNull()
    fireEvent.click(tile('Guide'))
    expect(onGo).toHaveBeenCalledExactlyOnceWith('https://guide.example.com/')
    expect(saved()?.map((x) => x.label)).toEqual([...SHORTCUTS.map((x) => x.label).filter((l) => l !== 'Wikipedia'), 'Guide'])
  })

  it('recent rows carry the favicon, inside the same section as the heading', () => {
    addRecent('https://docs.example.com/guide', 'Panduan')
    render(<BrowserStartPage onGo={vi.fn()} />)
    const section = screen.getByRole('region', { name: START_TEXT.recent })
    expect(section.querySelector('h3')).not.toBeNull()
    const img = screen.getByRole('button', { name: /Panduan/ }).querySelector('img')!
    expect(img.getAttribute('src')).toBe('https://docs.example.com/favicon.ico')
  })

  it('without a toolbar (bare node) the box stays a working search field', () => {
    const onGo = vi.fn()
    render(<div className="browser-node"><BrowserStartPage onGo={onGo} /></div>)
    type('example.com')
    expect(onGo).toHaveBeenCalledExactlyOnceWith('https://example.com/')
  })

  it('hands typing off to the node omnibox (Chrome fakebox) when there is one', () => {
    const typed: string[] = []
    render(
      <div className="browser-node">
        <input data-browser-omnibox aria-label="omnibox" defaultValue="" onInput={(e) => typed.push(e.currentTarget.value)} />
        <BrowserStartPage onGo={vi.fn()} />
      </div>,
    )
    const omni = screen.getByLabelText('omnibox') as HTMLInputElement
    fireEvent.focus(box())
    expect(document.activeElement).toBe(omni)
    fireEvent.change(box(), { target: { value: 'cats' } })
    expect(omni.value).toBe('cats')
    expect(typed).toContain('cats')
    expect(box().value).toBe('') // the fakebox never holds the text
  })
})
