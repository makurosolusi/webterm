/** @vitest-environment jsdom */
// The toolbar's omnibox on a blank page (new tab): empty field with the engine hint, never "about:blank"; a Go arrow only
// while there is text; URL vs search decided by resolveOmniboxInput; a rejected address shows inline with role=alert.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { BrowserState } from '../shared/browser.contract'
import BrowserToolbar from './BrowserToolbar'
import { TOOLBAR_TEXT, URL_ERROR_TEXT } from './browser.uxText'

afterEach(() => { cleanup(); localStorage.clear() })
const st = (o: Partial<BrowserState> = {}): BrowserState =>
  ({ id: 'n1', url: 'about:blank', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live', ...o })

function setup(state: BrowserState, searchEngine?: 'duckduckgo') {
  const nav = vi.fn()
  render(<BrowserToolbar state={state} nav={nav} agentControl={false} agentEnabled onAgentControl={vi.fn()} searchEngine={searchEngine} />)
  return { nav, field: screen.getByLabelText(TOOLBAR_TEXT.urlLabel) as HTMLInputElement }
}
const goArrow = () => screen.queryByRole('button', { name: TOOLBAR_TEXT.go })

describe('BrowserToolbar omnibox on a blank page', () => {
  it.each(['about:blank', ''])('is empty for %j and shows the engine hint as placeholder', (url) => {
    const { field } = setup(st({ url }))
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('Search Google or enter a web address')
  })

  it('names the configured search engine in the hint', () => {
    expect(setup(st(), 'duckduckgo').field.placeholder).toBe('Search DuckDuckGo or enter a web address')
  })

  it('keeps the real URL and the short hint on a loaded page', () => {
    const { field } = setup(st({ url: 'https://a.com/' }))
    expect(field.value).toBe('https://a.com/')
    expect(field.placeholder).toBe(TOOLBAR_TEXT.urlPlaceholder)
  })

  it('shows the Go arrow only while there is text', () => {
    const { field } = setup(st())
    expect(goArrow()).toBeNull()
    fireEvent.change(field, { target: { value: '  ' } })
    expect(goArrow()).toBeNull()
    fireEvent.change(field, { target: { value: 'x' } })
    expect((goArrow() as HTMLButtonElement).type).toBe('submit')
  })

  it.each([
    ['example.com', 'https://example.com/'],
    ['foo bar', 'https://www.google.com/search?q=foo%20bar'],
  ])('Enter resolves %s through resolveOmniboxInput', (input, url) => {
    const { nav, field } = setup(st())
    fireEvent.change(field, { target: { value: input } })
    fireEvent.submit(field)
    expect(nav).toHaveBeenCalledWith('go', url)
  })

  it('refuses a forbidden scheme inline with role=alert and does not navigate', () => {
    const { nav, field } = setup(st())
    fireEvent.change(field, { target: { value: 'javascript:alert(1)' } })
    fireEvent.submit(field)
    expect(screen.getByRole('alert').textContent).toBe(URL_ERROR_TEXT.scheme)
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(nav).not.toHaveBeenCalled()
  })
})
