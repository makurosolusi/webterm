/** @vitest-environment jsdom */
// Settings › Keyboard Shortcuts: the Command | Keybinding | When | Source table, recording (Escape
// cancels, refusals inline), a conflict naming the other command with Replace, per-row Reset, Reset all
// behind a confirm, text / record-keys / conflict filters, sort, roving focus, the row menu, deep links.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCommands } from './commandRegistry'
import { connectKeybindings, keybindingOverrides, type KeybindingOverrides } from './keybindings.store'
import { revealSettingsField } from './settingsPanel.reveal'
import { KeybindingsSection } from './SettingsKeybindings'
import { settingsSaves } from './useSettings'

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= () => {}
})

const run = (): void => {}
let unregister: () => void
let write: ReturnType<typeof vi.fn<(next: Record<string, string | null>) => void>>
const start = (o: KeybindingOverrides = {}): void => { write = vi.fn(); connectKeybindings(o, write) }

beforeEach(() => {
  unregister = registerCommands([
    { id: 't.find', label: 'Search: Find Things', defaultKey: 'Mod+Shift+Y', run },
    { id: 't.other', label: 'Test: Other Thing', defaultKey: 'Mod+Alt+Y', run },
    { id: 't.free', label: 'Test: Unbound Thing', run },
    { id: 'handoff.continue.w1', label: 'Agents: Continue from yesterday in Alpha', bindable: false, run },
  ])
  start()
})
afterEach(() => { cleanup(); unregister(); connectKeybindings({}, null) })

const row = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[role="row"][data-field="keybinding.${id}"]`)!
const cells = (id: string): HTMLElement[] => within(row(id)).getAllByRole('cell')
const detail = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-detail-for="${id}"]`)!
const record = (label: string): void => { fireEvent.click(screen.getByRole('button', { name: `Change keybinding: ${label}` })) }
const press = (o: Partial<KeyboardEventInit>): void => { fireEvent.keyDown(document.activeElement ?? document.body, o) }
const filter = (): HTMLInputElement => screen.getByRole('searchbox', { name: 'Search shortcuts' })

describe('Keyboard Shortcuts table', () => {
  it('header and every row share one grid with exactly 4 cells; source sits in the Source cell', () => {
    start({ 't.other': 'Mod+Alt+O' })
    render(<KeybindingsSection />)
    const head = screen.getAllByRole('columnheader')
    expect(head.map((h) => h.textContent)).toEqual(['Command', 'Keybinding', 'When', 'Source'])
    expect(head[0].parentElement!.className).toContain('st-kb-grid')
    for (const r of document.querySelectorAll('[data-field^="keybinding."]')) {
      expect(r.className).toContain('st-kb-grid')
      expect(within(r as HTMLElement).getAllByRole('cell')).toHaveLength(4)
    }
    expect(cells('t.find')[3].textContent).toBe('Default')
    expect(cells('t.other')[3].textContent).toBe('User')
    expect(cells('editor.save')[3].textContent).toBe('Default') // fixed: Default plus a lock, no third word
    expect(within(cells('editor.save')[3]).getByRole('img', { name: /can’t be changed/ })).toBeTruthy()
    expect(cells('t.find')[1].textContent).toMatch(/Ctrl\+Shift\+Y/)
    // Scope lives in When, not in the label.
    expect(cells('editor.save')[0].textContent).toBe('File: Save')
    expect(cells('editor.save')[2].textContent).toBe('Editor node focused')
    expect(cells('browser.reload')[2].textContent).toBe('Browser node focused')
    expect(cells('t.find')[2].textContent).toBe('')
  })

  it('an unbound row has an empty Keybinding cell with no border box, named "Not bound" for screen readers', () => {
    render(<KeybindingsSection />)
    const key = cells('t.free')[1]
    expect(key.textContent).toBe('')
    expect(key.getAttribute('aria-label')).toBe('Not bound')
    expect(key.querySelector('.st-kb-record')).toBeNull()
  })

  it('per-workspace palette commands are not listed', () => {
    render(<KeybindingsSection />)
    expect(document.querySelector('[data-command^="handoff.continue."]')).toBeNull()
    fireEvent.change(filter(), { target: { value: 'continue from yesterday' } })
    expect(screen.getByRole('status').textContent).toMatch(/No shortcuts match/)
  })

  it('text filter narrows the rows and says when nothing matches', () => {
    render(<KeybindingsSection />)
    fireEvent.change(filter(), { target: { value: 'find things' } })
    expect(row('t.find')).toBeTruthy()
    expect(row('t.other')).toBeNull()
    fireEvent.change(filter(), { target: { value: 'editor node focused' } })
    expect(row('editor.save')).toBeTruthy()
    fireEvent.change(filter(), { target: { value: 'zzz nothing' } })
    expect(screen.getByRole('status').textContent).toMatch(/No shortcuts match “zzz nothing”/)
  })

  it('record keys mode searches by the pressed chord', () => {
    render(<KeybindingsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Record keys' }))
    expect(filter().getAttribute('placeholder')).toBe('Press keys to search')
    fireEvent.keyDown(filter(), { key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true })
    expect(filter().value).toBe('Ctrl+Shift+Y')
    expect(row('t.find')).toBeTruthy()
    expect(row('t.other')).toBeNull()
    fireEvent.keyDown(filter(), { key: 'q', code: 'KeyQ', ctrlKey: true, altKey: true, shiftKey: true })
    expect(screen.getByRole('status').textContent).toBe('No commands are bound to Ctrl+Alt+Shift+Q.')
    fireEvent.click(screen.getByRole('button', { name: 'Record keys' }))
    expect(row('t.other')).toBeTruthy()
  })

  it('the "N conflicts" chip filters to rows sharing a chord, with a warning in the Keybinding cell', () => {
    start({ 't.other': 'Mod+Shift+Y' })
    render(<KeybindingsSection />)
    expect(within(cells('t.find')[1]).getByRole('img', { name: 'Also bound to: Test: Other Thing' })).toBeTruthy()
    const chip = screen.getByRole('button', { name: '2 conflicts' })
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect([...document.querySelectorAll('[data-field^="keybinding."]')].map((r) => r.getAttribute('data-command')).sort()).toEqual(['t.find', 't.other'])
    fireEvent.click(chip)
    expect(row('t.free')).toBeTruthy()
  })

  it('clicking a header sorts and toggles aria-sort: ascending, descending, back to grouped', () => {
    render(<KeybindingsSection />)
    const head = (): HTMLElement => screen.getAllByRole('columnheader')[0]
    const order = (): string[] => [...document.querySelectorAll('[data-field^="keybinding.t."]')].map((r) => r.getAttribute('data-command')!)
    expect(head().getAttribute('aria-sort')).toBe('none')
    fireEvent.click(within(head()).getByRole('button', { name: /Command/ }))
    expect(head().getAttribute('aria-sort')).toBe('ascending')
    expect(order()).toEqual(['t.find', 't.other', 't.free'])
    fireEvent.click(within(head()).getByRole('button', { name: /Command/ }))
    expect(head().getAttribute('aria-sort')).toBe('descending')
    expect(order()).toEqual(['t.free', 't.other', 't.find'])
    fireEvent.click(within(head()).getByRole('button', { name: /Command/ }))
    expect(head().getAttribute('aria-sort')).toBe('none')
    expect(screen.getAllByRole('columnheader')[2].getAttribute('aria-sort')).toBeNull() // When is not sortable
  })

  it('records via pencil or double-click; a bare modifier keeps listening; Escape cancels without writing', () => {
    render(<KeybindingsSection />)
    record('Test: Other Thing')
    expect(within(row('t.other')).getByRole('status').textContent).toMatch(/Press the new shortcut/)
    press({ key: 'Control', ctrlKey: true })
    press({ key: 'Escape', code: 'Escape' })
    expect(write).not.toHaveBeenCalled()
    fireEvent.doubleClick(row('t.other'))
    press({ key: 'o', code: 'KeyO', ctrlKey: true, altKey: true })
    expect(keybindingOverrides()).toEqual({ 't.other': 'Mod+Alt+O' })
    expect(write).toHaveBeenLastCalledWith({ 't.other': 'Mod+Alt+O' })
    expect(cells('t.other')[3].textContent).toBe('User')
    fireEvent.doubleClick(row('editor.save')) // fixed: never records
    expect(within(row('editor.save')).queryByRole('status')).toBeNull()
  })

  it('a refused chord says why in the sub-row and keeps recording', () => {
    render(<KeybindingsSection />)
    record('Test: Other Thing')
    press({ key: 'k', code: 'KeyK' })
    expect(within(detail('t.other')).getByRole('alert').textContent).toMatch(/needed for typing/)
    press({ key: 'c', code: 'KeyC', ctrlKey: true })
    expect(within(detail('t.other')).getByRole('alert').textContent).toMatch(/copy shortcut/)
    expect(write).not.toHaveBeenCalled()
    press({ key: 'o', code: 'KeyO', ctrlKey: true, altKey: true })
    expect(keybindingOverrides()).toEqual({ 't.other': 'Mod+Alt+O' })
  })

  it('a chord in use names the other command; Replace moves it, Cancel keeps both as they were', () => {
    render(<KeybindingsSection />)
    record('Test: Other Thing')
    press({ key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true })
    const alert = within(detail('t.other')).getByRole('alert')
    expect(alert.textContent).toMatch(/Ctrl\+Shift\+Y is already used by Search: Find Things/)
    fireEvent.click(within(alert).getByRole('button', { name: 'Cancel' }))
    expect(write).not.toHaveBeenCalled()
    record('Test: Other Thing')
    press({ key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true })
    fireEvent.click(within(detail('t.other')).getByRole('button', { name: 'Replace' }))
    expect(keybindingOverrides()).toEqual({ 't.find': null, 't.other': 'Mod+Shift+Y' })
    expect(cells('t.find')[1].getAttribute('aria-label')).toBe('Not bound')
  })

  it('Reset is on User rows only; Reset all asks first, then clears every override', () => {
    start({ 't.find': null, 't.other': 'Mod+Alt+O' })
    render(<KeybindingsSection />)
    expect(screen.queryByRole('button', { name: 'Reset keybinding: Test: Unbound Thing' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reset keybinding: Test: Other Thing' }))
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

  it('context menu: Reset only for User rows; Remove and Show Same Keybindings act on the row', () => {
    start({ 't.other': 'Mod+Alt+O' })
    render(<KeybindingsSection />)
    const items = (): string[] => screen.getAllByRole('menuitem').map((m) => m.textContent ?? '')
    fireEvent.contextMenu(row('t.find'))
    expect(items().some((t) => t.includes('Reset Keybinding'))).toBe(false)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.contextMenu(row('t.other'))
    expect(items().some((t) => t.includes('Reset Keybinding'))).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: /Remove Keybinding/ }))
    expect(keybindingOverrides()).toEqual({ 't.other': null })
    fireEvent.contextMenu(row('t.find'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Show Same Keybindings/ }))
    expect(filter().value).toBe('Ctrl+Shift+Y')
    expect(row('t.other')).toBeNull()
  })

  it('rows are one roving tab stop: arrows move focus, Enter records, Delete removes', () => {
    render(<KeybindingsSection />)
    const rows = [...document.querySelectorAll<HTMLElement>('[data-field^="keybinding."]')]
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1)
    act(() => rows[0].focus())
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[1])
    expect(rows[1].tabIndex).toBe(0)
    expect(rows[0].tabIndex).toBe(-1)
    fireEvent.keyDown(rows[1], { key: 'End' })
    expect(document.activeElement).toBe(rows[rows.length - 1])
    act(() => row('t.other').focus())
    fireEvent.keyDown(row('t.other'), { key: 'Delete' })
    expect(keybindingOverrides()).toEqual({ 't.other': null })
    fireEvent.keyDown(row('t.other'), { key: 'Enter' })
    expect(within(row('t.other')).getByRole('status').textContent).toMatch(/Press the new shortcut/)
  })

  it('a deep link keybinding.<id> still reveals the row', () => {
    const { container } = render(<KeybindingsSection />)
    const stop = revealSettingsField(() => container, 'keybinding.t.other')
    expect(row('t.other').contains(document.activeElement)).toBe(true)
    expect(row('t.other').classList.contains('st-reveal')).toBe(true)
    stop()
  })

  it('shows the settings save state under the row just changed', () => {
    render(<KeybindingsSection />)
    record('Test: Other Thing')
    press({ key: 'o', code: 'KeyO', ctrlKey: true, altKey: true })
    let settle!: ReturnType<typeof settingsSaves.start>
    act(() => { settle = settingsSaves.start(['keybindings']) })
    expect(detail('t.other').textContent).toContain('Saving…')
    expect(detail('t.find')).toBeNull()
    act(() => settle({ ok: false, message: 'offline', retry: () => {} }))
    expect(within(detail('t.other')).getByRole('alert').textContent).toMatch(/Could not save: offline/)
  })
})
