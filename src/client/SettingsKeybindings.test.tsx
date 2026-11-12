/** @vitest-environment jsdom */
// Settings › Keyboard Shortcuts: record (Escape cancels, refusals inline), a conflict naming the other
// command with Replace, per-row Reset, Reset all behind a confirm, the filter, and save feedback.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCommands } from './commandRegistry'
import { connectKeybindings, keybindingOverrides, type KeybindingOverrides } from './keybindings.store'
import { KeybindingsSection } from './SettingsKeybindings'
import { settingsSaves } from './useSettings'

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

const run = (): void => {}
let unregister: () => void
let write: ReturnType<typeof vi.fn<(next: Record<string, string | null>) => void>>
const start = (o: KeybindingOverrides = {}): void => { write = vi.fn(); connectKeybindings(o, write) }

beforeEach(() => {
  unregister = registerCommands([
    { id: 't.find', label: 'Search: Find Things', defaultKey: 'Mod+Shift+Y', run },
    { id: 't.other', label: 'Test: Other Thing', defaultKey: 'Mod+Alt+Y', run },
  ])
  start()
})
afterEach(() => { cleanup(); unregister(); connectKeybindings({}, null) })

const row = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-field="keybinding.${id}"]`)!
const record = (label: string): HTMLElement => {
  const b = screen.getByRole('button', { name: `Change shortcut: ${label}` })
  fireEvent.click(b)
  return b
}
const press = (o: Partial<KeyboardEventInit>): void => { fireEvent.keyDown(document.activeElement ?? document.body, o) }

describe('Keyboard Shortcuts page', () => {
  it('lists every command with its chord and source, and the filter narrows the rows', () => {
    start({ 't.other': 'Mod+Alt+O' })
    render(<KeybindingsSection />)
    expect(row('t.find').textContent).toContain('Default')
    expect(row('t.other').textContent).toContain('Custom')
    expect(row('editor.save').textContent).toContain('Built-in')
    expect(within(row('t.find')).getAllByText(/Ctrl|Shift|Y/).length).toBeGreaterThan(0)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search shortcuts' }), { target: { value: 'find things' } })
    expect(row('t.find')).toBeTruthy()
    expect(row('t.other')).toBeNull()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search shortcuts' }), { target: { value: 'zzz nothing' } })
    expect(screen.getByRole('status').textContent).toMatch(/No shortcuts match/)
  })

  it('records the next chord; a bare modifier keeps listening; Escape cancels without writing', () => {
    render(<KeybindingsSection />)
    record('Test: Other Thing')
    expect(within(row('t.other')).getByRole('status').textContent).toMatch(/Press the new shortcut/)
    press({ key: 'Control', ctrlKey: true })
    press({ key: 'Escape', code: 'Escape' })
    expect(write).not.toHaveBeenCalled()
    record('Test: Other Thing')
    press({ key: 'o', code: 'KeyO', ctrlKey: true, altKey: true })
    expect(keybindingOverrides()).toEqual({ 't.other': 'Mod+Alt+O' })
    expect(write).toHaveBeenLastCalledWith({ 't.other': 'Mod+Alt+O' })
    expect(row('t.other').textContent).toContain('Custom')
  })

  it('a refused chord says why inline and keeps recording', () => {
    render(<KeybindingsSection />)
    record('Test: Other Thing')
    press({ key: 'k', code: 'KeyK' })
    expect(within(row('t.other')).getByRole('alert').textContent).toMatch(/needed for typing/)
    press({ key: 'c', code: 'KeyC', ctrlKey: true })
    expect(within(row('t.other')).getByRole('alert').textContent).toMatch(/copy shortcut/)
    expect(write).not.toHaveBeenCalled()
    press({ key: 'o', code: 'KeyO', ctrlKey: true, altKey: true })
    expect(keybindingOverrides()).toEqual({ 't.other': 'Mod+Alt+O' })
  })

  it('a chord in use names the other command; Replace moves it, Cancel keeps both as they were', () => {
    render(<KeybindingsSection />)
    record('Test: Other Thing')
    press({ key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true })
    const alert = within(row('t.other')).getByRole('alert')
    expect(alert.textContent).toMatch(/Ctrl\+Shift\+Y is already used by Search: Find Things/)
    fireEvent.click(within(alert).getByRole('button', { name: 'Cancel' }))
    expect(write).not.toHaveBeenCalled()
    record('Test: Other Thing')
    press({ key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true })
    fireEvent.click(within(row('t.other')).getByRole('button', { name: 'Replace' }))
    expect(keybindingOverrides()).toEqual({ 't.find': null, 't.other': 'Mod+Shift+Y' })
    expect(row('t.find').textContent).toContain('Not bound')
  })

  it('Reset puts one row back; Reset all asks first, then clears every override', () => {
    start({ 't.find': null, 't.other': 'Mod+Alt+O' })
    render(<KeybindingsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset Setting: Test: Other Thing' }))
    expect(keybindingOverrides()).toEqual({ 't.find': null })
    fireEvent.click(screen.getByRole('button', { name: 'Reset all' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toMatch(/1 custom shortcut goes back/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(keybindingOverrides()).toEqual({ 't.find': null })
    fireEvent.click(screen.getByRole('button', { name: 'Reset all' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reset all' }))
    expect(keybindingOverrides()).toEqual({})
    expect(screen.queryByRole('button', { name: 'Reset all' })).toBeNull()
  })

  it('shows the settings save state on the row just changed', () => {
    render(<KeybindingsSection />)
    record('Test: Other Thing')
    press({ key: 'o', code: 'KeyO', ctrlKey: true, altKey: true })
    let settle!: ReturnType<typeof settingsSaves.start>
    act(() => { settle = settingsSaves.start(['keybindings']) })
    expect(row('t.other').textContent).toContain('Saving…')
    expect(row('t.find').textContent).not.toContain('Saving…')
    act(() => settle({ ok: false, message: 'offline', retry: () => {} }))
    expect(within(row('t.other')).getByRole('alert').textContent).toMatch(/Could not save: offline/)
  })
})
