/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import { AppearanceSection } from './SettingsAppearanceSection'
import { HEADER_MODE_FIELD } from './SettingsHeaderMode'
import { HEADER_MODE_KEY, getHeaderMode, reloadHeaderModeFromStorage, setHeaderMode } from './headerMode.store'
import { SETTINGS_SEARCH_INDEX } from './settings.search'
import { toSettingsFieldId } from './settings.link'
import { DEFAULT_SETTINGS } from '../shared/settings'

beforeEach(() => {
  localStorage.clear()
  reloadHeaderModeFromStorage()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const mount = () => render(<AppearanceSection settings={DEFAULT_SETTINGS} onChange={vi.fn()} />)
const option = (name: string) => screen.getByRole('radio', { name })

describe('Settings > Appearance > Header', () => {
  it('is a two-option choice (no typing) showing the current mode, Tabs by default', () => {
    mount()
    const group = screen.getByRole('radiogroup', { name: HEADER_MODE_FIELD.label })
    expect([...group.querySelectorAll('[role="radio"]')].map((r) => r.textContent)).toEqual(['Tabs', 'Hidden'])
    expect(option('Tabs').getAttribute('aria-checked')).toBe('true')
    expect(option('Hidden').getAttribute('aria-checked')).toBe('false')
  })

  it('choosing a mode sets and persists it, and says where it was saved', () => {
    mount()
    fireEvent.click(option('Hidden'))
    expect(getHeaderMode()).toBe('hidden')
    expect(localStorage.getItem(HEADER_MODE_KEY)).toBe('hidden')
    expect(option('Hidden').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('status').textContent).toMatch(/Saved on this browser/)
  })

  it('shows a mode changed elsewhere (menu, palette, chord) and resets back to Tabs', () => {
    mount()
    act(() => setHeaderMode('hidden'))
    expect(option('Hidden').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /reset/i }))
    expect(getHeaderMode()).toBe('tabs')
  })

  it('is in the Settings search index, deep-linkable, with the label that is on screen', () => {
    const entry = SETTINGS_SEARCH_INDEX.find((e) => e.field === 'header-mode')
    expect(entry).toMatchObject({ page: 'appearance', label: HEADER_MODE_FIELD.label })
    expect(toSettingsFieldId('header-mode')).toBe('header-mode')
  })
})
