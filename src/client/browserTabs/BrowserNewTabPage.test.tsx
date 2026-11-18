/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { SettingsProvider } from '../useSettings'
import { BrowserNewTabPage, type BrowserNewTabPageProps } from './BrowserNewTabPage'
import { makeTab } from './browserTabsHarness'

// The page lives inside a node whose toolbar owns the one address field (`data-browser-omnibox`).
function setup(over: Partial<BrowserNewTabPageProps> = {}, engine?: string) {
  const onNavigate = vi.fn()
  const onReopen = vi.fn()
  const page = <BrowserNewTabPage closed={[makeTab('x', { title: 'Docs' }), makeTab('y', { title: '' })]} onNavigate={onNavigate} onReopen={onReopen} {...over} />
  const view = render(
    <SettingsProvider value={{ ...DEFAULT_SETTINGS, ...(engine ? { browserSearchEngine: engine } : {}) } as typeof DEFAULT_SETTINGS}>
      <div className="browser-node"><input data-browser-omnibox aria-label="Address" />{page}</div>
    </SettingsProvider>,
  )
  return { onNavigate, onReopen, omnibox: screen.getByLabelText('Address') as HTMLInputElement, view }
}

beforeEach(() => { localStorage.clear(); (document.activeElement as HTMLElement | null)?.blur() })

describe('BrowserNewTabPage', () => {
  it('has no address input of its own: the toolbar omnibox is the only text field', () => {
    setup()
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Go' })).toBeNull()
  })

  it('the search pill shows the engine hint and focuses the toolbar omnibox on click', () => {
    const { omnibox } = setup({}, 'duckduckgo')
    fireEvent.click(screen.getByRole('button', { name: 'Search DuckDuckGo or enter a web address' }))
    expect(document.activeElement).toBe(omnibox)
  })

  it('defaults the hint to Google', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Search Google or enter a web address' })).toBeTruthy()
  })

  it('focuses the omnibox on appearance only when told it is a human tab', () => {
    const agent = setup({ autoFocus: false })
    expect(document.activeElement).not.toBe(agent.omnibox)
    agent.view.unmount()
    const human = setup({ autoFocus: true })
    expect(document.activeElement).toBe(human.omnibox)
  })

  it('does not pull focus out of an element outside the node', () => {
    const other = document.createElement('textarea')
    document.body.appendChild(other)
    other.focus()
    const { omnibox } = setup({ autoFocus: true })
    expect(document.activeElement).toBe(other)
    expect(document.activeElement).not.toBe(omnibox)
    other.remove()
  })

  it('shows the shortcut grid and navigates on a tile click', () => {
    const { onNavigate } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Open GitHub' }))
    expect(onNavigate).toHaveBeenCalledWith('https://github.com/')
  })

  it('lists recently closed tabs with a Reopen label and reopens the clicked one', () => {
    const { onReopen } = setup()
    const row = screen.getByRole('button', { name: /Docs/ })
    expect(row.textContent).toContain('Reopen')
    fireEvent.click(row)
    expect(onReopen).toHaveBeenCalledWith('x')
    expect(screen.getByRole('button', { name: /y\.example\.com/ })).toBeTruthy() // title falls back to the host
  })

  it('caps the list at 5 rows', () => {
    setup({ closed: Array.from({ length: 8 }, (_, i) => makeTab(`c${i}`, { title: `Page ${i}` })) })
    expect(screen.getAllByRole('button', { name: /Reopen$/ })).toHaveLength(5)
  })

  it('renders no "Recently closed" section when nothing was closed', () => {
    setup({ closed: [] })
    expect(screen.queryByText(/recently closed/i)).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('list', { name: 'Shortcuts' })).toBeTruthy() // the page still has its content
  })

  it('disables reopen with the limit reason visible', () => {
    const { onReopen } = setup({ reopenBlockedReason: 'Tab limit (8) reached' })
    expect(screen.getByRole('status').textContent).toBe('Tab limit (8) reached')
    const row = screen.getByRole('button', { name: /Docs/ }) as HTMLButtonElement
    expect(row.disabled).toBe(true)
    fireEvent.click(row)
    expect(onReopen).not.toHaveBeenCalled()
  })

  it('exposes a hidden "New tab" heading and the container class for the narrow-node CSS', () => {
    setup()
    expect(screen.getByRole('heading', { name: 'New tab', level: 2 }).className).toContain('bt-sr')
    expect(screen.getByRole('region', { name: 'New tab' }).className).toContain('bt-newtab')
  })
})
