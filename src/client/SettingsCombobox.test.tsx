/** @vitest-environment jsdom */
// SettingsCombobox: presets and Recent in one listbox, custom values commit on Enter / blur, the store
// remembers (dedupe, most recent first, cap) and forgets; remember={false} stores nothing; invalid
// values show an error and are neither committed nor stored; nothing is written before settings load.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '../shared/settings'
import { INPUT_HISTORY_LIMITS } from '../shared/settings.inputHistory'
import { resetInputHistoryForTests } from './inputHistory.store'
import { SettingsCombobox, type SettingsComboboxProps } from './SettingsCombobox'
import { SettingsProvider } from './useSettings'

const FIELD = 'test.field' // test-only
let puts: unknown[] = []

beforeEach(() => {
  resetInputHistoryForTests()
  puts = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)))
    return new Response('{}', { status: 200 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function setup(props: Partial<SettingsComboboxProps> = {}, history: string[] = [], loaded = true) {
  const onCommit = vi.fn()
  const settings = loaded ? mergeSettings({ inputHistory: history.length ? { [FIELD]: history } : {} }) : DEFAULT_SETTINGS
  render(
    <SettingsProvider value={settings}>
      <SettingsCombobox fieldId={FIELD} ariaLabel="Thing" value="" onCommit={onCommit}
        presets={[{ value: 'a', label: 'Alpha' }, { value: 'b' }]} {...props} />
    </SettingsProvider>,
  )
  const input = screen.getByRole('combobox', { name: 'Thing' }) as HTMLInputElement
  const open = (): HTMLElement => { fireEvent.click(screen.getByRole('button', { name: 'Show suggestions' })); return screen.getByRole('listbox') }
  const type = (v: string, key = 'Enter'): void => { fireEvent.change(input, { target: { value: v } }); fireEvent.keyDown(input, { key }) }
  return { onCommit, input, open, type }
}

const flush = () => act(async () => { await Promise.resolve() })

describe('SettingsCombobox', () => {
  it('lists presets, then Recent; picking a preset commits it and does not store it', async () => {
    const { onCommit, open, input } = setup({}, ['typed-before'])
    const list = open()
    expect(input.getAttribute('aria-expanded')).toBe('true')
    const groups = within(list).getAllByRole('group')
    expect(groups.map((g) => g.getAttribute('aria-labelledby') && document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent)).toEqual(['Suggestions', 'Recent'])
    expect(within(groups[0]!).getAllByRole('option').map((o) => o.textContent)).toEqual(['Alphaa', 'b'])
    expect(within(groups[1]!).getByRole('option').textContent).toBe('typed-before')
    fireEvent.click(within(list).getByRole('option', { name: /Alpha/ }))
    expect(onCommit).toHaveBeenCalledWith('a')
    expect(input.value).toBe('Alpha') // at rest the box shows the preset's label, not the raw value
    fireEvent.focus(input)
    expect(input.value).toBe('a') // editing shows what is stored
    await flush()
    expect(puts).toEqual([])
  })

  it('keyboard: ArrowDown opens and moves, Enter picks, Escape closes without leaving', () => {
    const { onCommit, input } = setup()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-0$/)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith('b')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const outer = vi.fn()
    document.addEventListener('keydown', outer)
    fireEvent.keyDown(input, { key: 'Escape' })
    document.removeEventListener('keydown', outer)
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(outer).not.toHaveBeenCalled()
  })

  it('marks itself data-settings-escape only while the list is open (the Settings dialog then leaves Escape to it)', () => {
    const { input } = setup()
    const marked = (): boolean => input.closest('[data-settings-escape]') !== null
    expect(marked()).toBe(false)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(marked()).toBe(true)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(marked()).toBe(false)
  })

  it('a custom value commits trimmed on Enter and on blur, and is remembered most-recent-first without duplicates', async () => {
    const { onCommit, input, type } = setup({}, ['old'])
    type('  custom-1  ')
    expect(onCommit).toHaveBeenLastCalledWith('custom-1')
    await flush()
    expect(puts.at(-1)).toEqual({ inputHistory: { [FIELD]: ['custom-1', 'old'] } })
    fireEvent.change(input, { target: { value: 'old' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenLastCalledWith('old')
    await flush()
    expect(puts.at(-1)).toEqual({ inputHistory: { [FIELD]: ['old', 'custom-1'] } })
  })

  it('history is capped at the limit and each value is removable', async () => {
    const full = Array.from({ length: INPUT_HISTORY_LIMITS.values }, (_, i) => `v${i}`)
    const { type, open } = setup({}, full)
    type('newest')
    await flush()
    const saved = (puts.at(-1) as { inputHistory: Record<string, string[]> }).inputHistory[FIELD]!
    expect(saved).toHaveLength(INPUT_HISTORY_LIMITS.values)
    expect(saved[0]).toBe('newest')
    const list = open()
    fireEvent.click(within(list).getByRole('button', { name: 'Remove v0 from recent' }))
    await flush()
    expect((puts.at(-1) as { inputHistory: Record<string, string[]> }).inputHistory[FIELD]).not.toContain('v0')
    expect(within(screen.getByRole('listbox')).queryByRole('option', { name: /^v0/ })).toBeNull()
  })

  it('remember={false} (secrets) stores nothing and shows no Recent', async () => {
    const { onCommit, type, open } = setup({ remember: false }, ['visible-only-when-remembering'])
    type('sk-secret-value') // test-only
    expect(onCommit).toHaveBeenCalledWith('sk-secret-value')
    await flush()
    expect(puts).toEqual([])
    expect(within(open()).queryByText('visible-only-when-remembering')).toBeNull()
  })

  it('an invalid value shows an inline error and is neither committed nor stored', async () => {
    const { onCommit, input, type } = setup({ validate: (v) => (/^\d+$/.test(v) ? null : 'Enter a number.') })
    type('abc')
    expect(screen.getByRole('alert').textContent).toBe('Enter a number.')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(onCommit).not.toHaveBeenCalled()
    await flush()
    expect(puts).toEqual([])
    type('42')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onCommit).toHaveBeenCalledWith('42')
  })

  it('before settings are loaded nothing is written (it would replace the stored lists)', async () => {
    const { onCommit, type } = setup({}, [], false)
    type('early')
    expect(onCommit).toHaveBeenCalledWith('early')
    await flush()
    expect(puts).toEqual([])
  })

  it('at rest shows format(value) for a value with no preset; font options draw in their own face', () => {
    const { input, open } = setup({ value: '25000', format: (v: string) => `${Number(v).toLocaleString('en-US')} lines`, fontPreview: true })
    expect(input.value).toBe('25,000 lines')
    fireEvent.focus(input)
    expect(input.value).toBe('25000')
    fireEvent.blur(input)
    expect(input.value).toBe('25,000 lines')
    const option = within(open()).getByRole('option', { name: /Alpha/ })
    expect((option.querySelector('.st-combo-label') as HTMLElement).style.fontFamily).toBe('a')
    expect(option.querySelector('.st-combo-value')).toBeNull() // the raw stack is not repeated beside the face
  })

  it('a mono box (command, path, id) keeps showing the raw value at rest', () => {
    const { input } = setup({ value: 'a', mono: true })
    expect(input.value).toBe('a')
  })
})
