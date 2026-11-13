/**
 * @vitest-environment jsdom
 */
// Settings shell: search over the static index (./settings.search) without mounting pages, the single
// empty state, "Go to" reveal, keyboard (Enter, ArrowDown, ⌘F and /), Escape ownership (search box,
// open combobox list) and the narrow layout at 360 / 720 / 900 / 1280 px.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { NARROW_QUERY, SETTINGS_GROUPS, SettingsPanel } from './SettingsPanel'

vi.mock('./useCapabilities', () => ({
  useCapabilities: () => ({ data: null, loading: false, error: null, busyId: null, refresh: async () => undefined, toggle: async () => true, setSub: async () => true }),
  capabilityErrorMessage: () => '',
}))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
vi.setConfig({ testTimeout: 60_000 }) // a full Dialog render under parallel suites

function renderPanel() {
  const onClose = vi.fn()
  render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={onClose} />)
  return { onClose }
}

const nav = () => screen.getByRole('navigation', { name: 'Section settings' })
const search = () => screen.getByRole('searchbox', { name: 'Search settings' }) as HTMLInputElement

describe('SettingsPanel search', () => {
  const rows = () => [...document.querySelectorAll('.st-result-go')].map((el) => el.textContent)

  it('lists "Page › Label" rows with the match marked; the count heads the results, outside the input', () => {
    renderPanel()
    fireEvent.change(search(), { target: { value: 'font' } })
    const count = document.querySelector('.st-search-count') as HTMLElement
    expect(rows()).toContain('Appearance › Font size')
    expect(count.textContent).toBe(`${rows().length} results`)
    expect(count.closest('main')).toBeTruthy() // not squeezed into the search box
    const marks = [...screen.getByRole('button', { name: 'Appearance › Font size' }).querySelectorAll('mark.st-mark')].map((m) => m.textContent)
    expect(marks).toEqual(['Font'])
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(search().value).toBe('')
  })

  it('does not mount any page while searching: no fields, no network load', () => {
    const fetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    renderPanel()
    fetch.mockClear()
    fireEvent.change(search(), { target: { value: 'a' } })
    expect(document.querySelector('[data-slot="settings-field"]')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('finds every page, also list pages without fields, by the words people type', () => {
    renderPanel()
    const pageOf = (q: string) => {
      fireEvent.change(search(), { target: { value: q } })
      return [...document.querySelectorAll('.st-search-group h3')].map((h) => h.textContent)
    }
    expect(pageOf('secret')).toContain('Rules & secrets')
    // Moved to the Control side bar: still found, under their own heading.
    expect(pageOf('routine')).toContain('Control panel')
    expect(pageOf('budget')).toContain('Control panel')
    expect(pageOf('password')).toContain('Account')
    expect(pageOf('remember')).toContain('Control panel')
    expect(pageOf('diagnostics')).toContain('About this machine')
    expect(pageOf('scrollbacklines')).toEqual(['Terminal']) // key names match too
  })

  it('treats space-separated tokens as AND and shows one empty state when nothing matches', () => {
    renderPanel()
    fireEvent.change(search(), { target: { value: 'font bold' } })
    expect(rows()).toContain('Terminal › Bold text weight')
    expect(rows()).not.toContain('Appearance › Font size')

    fireEvent.change(search(), { target: { value: 'tidak-ada-setting-ini' } })
    expect(rows()).toEqual([])
    expect(screen.getByText(/No settings match/)).toBeTruthy()
    expect(document.querySelector('.st-search-count')).toBeNull()
  })

  it('Enter opens the first result; ArrowDown moves into the results and on between rows', () => {
    const onSectionChange = vi.fn()
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} onSectionChange={onSectionChange} initialSection="canvas" />)
    fireEvent.change(search(), { target: { value: 'font' } })
    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    const [first, second] = [...document.querySelectorAll<HTMLElement>('.st-result-go')]
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(second)

    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(search().value).toBe('')
    expect(onSectionChange).toHaveBeenCalledTimes(1)
    const [page] = onSectionChange.mock.calls[0]!
    expect(document.querySelector('[data-page]')?.getAttribute('data-page')).toBe(page)
  })

  it('⌘F, Ctrl+F and / (outside a text field) focus the search box', () => {
    renderPanel()
    const item = within(nav()).getByRole('button', { name: 'Terminal' })
    item.focus()
    fireEvent.keyDown(item, { key: 'f', metaKey: true })
    expect(document.activeElement).toBe(search())
    item.focus()
    fireEvent.keyDown(item, { key: 'f', ctrlKey: true })
    expect(document.activeElement).toBe(search())
    item.focus()
    fireEvent.keyDown(item, { key: '/' })
    expect(document.activeElement).toBe(search())
    const font = screen.getByRole('combobox', { name: 'Font' })
    font.focus()
    fireEvent.keyDown(font, { key: '/' })
    expect(document.activeElement).toBe(font) // typing a slash stays typing
  })

  it('a result opens its page and reveals the field', async () => {
    const onSectionChange = vi.fn()
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} onSectionChange={onSectionChange} initialSection="canvas" />)
    fireEvent.change(search(), { target: { value: 'font size' } })
    fireEvent.click(screen.getByRole('button', { name: 'Appearance › Font size' }))
    expect(search().value).toBe('')
    expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeTruthy()
    expect(onSectionChange).toHaveBeenLastCalledWith('appearance', 'fontSize')
    await waitFor(() => expect(document.querySelector('[data-field="fontSize"]')?.classList.contains('st-reveal')).toBe(true))
  })

  it('clears the query on Escape instead of closing the dialog, and clears on section click', () => {
    const { onClose } = renderPanel()
    fireEvent.change(search(), { target: { value: 'font' } })
    fireEvent.keyDown(search(), { key: 'Escape' })

    expect(search().value).toBe('')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeTruthy()

    fireEvent.change(search(), { target: { value: 'grid' } })
    fireEvent.click(within(nav()).getByRole('button', { name: 'Terminal' }))

    expect(search().value).toBe('')
    expect(screen.getByRole('heading', { level: 2, name: 'Terminal' })).toBeTruthy()
  })

  it('Escape with an open combobox list closes only the list; the next Escape closes Settings', () => {
    const { onClose } = renderPanel()
    const font = screen.getByRole('combobox', { name: 'Font' })
    fireEvent.keyDown(font, { key: 'ArrowDown' })
    expect(font.getAttribute('aria-expanded')).toBe('true')

    fireEvent.keyDown(font, { key: 'Escape' })
    expect(font.getAttribute('aria-expanded')).toBe('false')
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(font, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('SettingsPanel narrow layout', () => {
  const mockWidth = (narrow: boolean) => vi.stubGlobal('matchMedia', (media: string) => ({
    matches: narrow && media === NARROW_QUERY, media, addEventListener: () => undefined, removeEventListener: () => undefined,
  }))
  /** matchMedia for a real viewport width: evaluates `(max-width: Npx)` like a browser. */
  const atWidth = (px: number) => vi.stubGlobal('matchMedia', (media: string) => {
    const max = /\(max-width:\s*(\d+)px\)/.exec(media)
    return { matches: max ? px <= Number(max[1]) : false, media, addEventListener: () => undefined, removeEventListener: () => undefined }
  })

  it.each([[360, true], [719, true], [720, false], [900, false], [1280, false]])('at %ipx narrow is %s, and the page renders its rows', (px, narrow) => {
    atWidth(px)
    renderPanel()
    expect(!!screen.queryByRole('combobox', { name: 'Settings section' })).toBe(narrow)
    expect(!!screen.queryByRole('navigation', { name: 'Section settings' })).toBe(!narrow)
    // The search box is always there, and the content pane is never empty.
    expect(search()).toBeTruthy()
    expect(document.querySelectorAll('.st-content [data-slot="settings-field"]').length).toBeGreaterThan(3)
    expect(document.querySelector('.st-body')!.classList.contains('is-narrow')).toBe(narrow)
  })

  it('CSS has no viewport width breakpoint of its own (the old 720px rule never matched the 719px JS one)', () => {
    for (const file of ['settings.css', 'settings-controls.css', 'settings-field.css', 'settings-pickers.css', 'settings-search.css', 'settings-sections.css']) {
      const css = readFileSync(join(__dirname, file), 'utf8')
      expect(css, file).not.toMatch(/@media[^{]*(max|min)-width/)
    }
  })

  it('narrow: the search box sits above the section dropdown', () => {
    mockWidth(true)
    renderPanel()
    const picker = screen.getByRole('combobox', { name: 'Settings section' })
    expect(search().compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('below 720px the sidebar becomes a section dropdown that switches the page', () => {
    mockWidth(true)
    renderPanel()
    expect(screen.queryByRole('navigation', { name: 'Section settings' })).toBeNull()
    const picker = screen.getByRole('combobox', { name: 'Settings section' }) as HTMLSelectElement
    expect(picker.value).toBe('appearance')
    expect([...picker.querySelectorAll('optgroup')].map((g) => g.label)).toEqual([...SETTINGS_GROUPS])
    expect([...picker.options].map((o) => o.value)).not.toContain('developer') // developer mode off
    fireEvent.change(picker, { target: { value: 'canvas' } })
    expect(screen.getByRole('heading', { level: 2, name: 'Canvas' })).toBeTruthy()
  })

  it('at desktop width the sidebar stays', () => {
    mockWidth(false)
    renderPanel()
    expect(nav()).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Settings section' })).toBeNull()
  })
})
