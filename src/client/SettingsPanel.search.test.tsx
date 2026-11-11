/**
 * @vitest-environment jsdom
 */
// Settings shell: search over the static index (./settings.search) without mounting pages, the single
// empty state, "Go to" reveal, Escape ownership (search box, open combobox list) and the narrow layout.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

describe('SettingsPanel search', () => {
  const search = () => screen.getByRole('searchbox', { name: 'Search settings' }) as HTMLInputElement
  const rows = () => [...document.querySelectorAll('.st-result-go')].map((el) => el.textContent)

  it('lists "Page › Label" rows from the index; the count is the number of rows; clear button empties it', () => {
    renderPanel()
    fireEvent.change(search(), { target: { value: 'font' } })
    const count = document.querySelector('.st-search-count') as HTMLElement
    expect(rows()).toContain('Appearance › Font size')
    expect(count.textContent).toBe(`${rows().length} settings found`)
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
    expect(pageOf('secret')).toContain('Rules & approvals')
    expect(pageOf('routine')).toContain('Automations')
    expect(pageOf('budget')).toContain('Spending')
    expect(pageOf('password')).toContain('Account')
    expect(pageOf('remember')).toContain('Memory')
    expect(pageOf('diagnostics')).toContain('Health')
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
