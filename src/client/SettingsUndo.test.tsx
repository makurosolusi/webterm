/**
 * @vitest-environment jsdom
 */
// Settings undo end to end inside the panel: the real `useSettings` (fetch faked as a tiny server)
// feeding the real `SettingsPanel`. Covers the toast, its Undo/Redo action, ⌘Z / ⇧⌘Z, and that a
// text field keeps the browser's own ⌘Z.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SettingsPanel } from './SettingsPanel'
import { SettingsUndoToast } from './SettingsUndoToast'
import { useSettings } from './useSettings'

vi.mock('./useCapabilities', () => ({
  useCapabilities: () => ({ data: null, loading: false, error: null, busyId: null, refresh: async () => undefined, toggle: async () => true, setSub: async () => true }),
  capabilityErrorMessage: () => '',
}))

vi.setConfig({ testTimeout: 60_000 }) // Dialog + sections in jsdom are slow under a loaded machine

let puts: unknown[] = []
beforeEach(() => {
  puts = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { puts.push(JSON.parse(String(init.body))); return new Response(null, { status: 200 }) }
    return new Response(JSON.stringify(DEFAULT_SETTINGS), { status: 200 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness() {
  const { settings, update, history, hydrated } = useSettings()
  if (!hydrated) return null
  // Terminal: its first switch (Cursor blink) is a plain server-saved setting.
  return <SettingsPanel settings={settings} onChange={update} onClose={() => undefined} history={history} initialSection="terminal" />
}

async function mount() {
  render(<Harness />)
  await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search settings' })).toBeTruthy())
  const box = screen.getAllByRole('switch')[0]!
  return { box, before: isOn() }
}

const isOn = (): boolean => screen.getAllByRole('switch')[0]!.getAttribute('aria-checked') === 'true'
const z = (el: Element, shift = false) => fireEvent.keyDown(el, { key: shift ? 'Z' : 'z', metaKey: true, shiftKey: shift })

describe('Settings undo', () => {
  it('a change shows "Changed …" with Undo once the server accepted it, and Undo restores the value (and persists it)', async () => {
    const { box, before } = await mount()
    fireEvent.click(box)
    expect(isOn()).toBe(!before) // the pick shows at once
    expect(screen.queryByText(/^Changed /)).toBeNull() // the toast waits for the server
    expect(await screen.findByText(/^Changed /, {}, { timeout: 2000 })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(isOn()).toBe(before)
    expect(await screen.findByText(/^Undid change to /, {}, { timeout: 2000 })).toBeTruthy()
    // The undo goes through the same coalesced PUT as an edit.
    await waitFor(() => expect(puts.length).toBeGreaterThan(0), { timeout: 2000 })
    const last = puts[puts.length - 1] as Record<string, unknown>
    expect(Object.values(last)).toContain(before)
  })

  it('⌘Z undoes and ⇧⌘Z redoes while focus is on a control in the panel', async () => {
    const { box, before } = await mount()
    fireEvent.click(box)
    box.focus()
    z(box)
    expect(isOn()).toBe(before)
    z(screen.getAllByRole('switch')[0]!, true)
    expect(isOn()).toBe(!before)
  })

  it('⌘Z in a text field with text is left to the browser', async () => {
    const { box, before } = await mount()
    fireEvent.click(box)
    const search = screen.getByRole('searchbox', { name: 'Search settings' })
    fireEvent.change(search, { target: { value: 'zz' } })
    const ev = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
    act(() => { search.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(false)
    fireEvent.change(search, { target: { value: '' } })
    expect(isOn()).toBe(!before)
  })

  it('a change made before the panel opened does not pop a toast; the next one does', () => {
    const change = { keys: ['fontSize' as const], before: { fontSize: 13 }, after: { fontSize: 14 }, at: 0 }
    const h = (seq: number) => ({ undo: vi.fn(), redo: vi.fn(), canUndo: true, canRedo: false, notice: { seq, kind: 'changed' as const, change } })
    const view = render(<SettingsUndoToast history={h(3)} />)
    expect(screen.queryByText(/^Changed /)).toBeNull()
    view.rerender(<SettingsUndoToast history={h(4)} />)
    expect(screen.getByText('Changed font size')).toBeTruthy()
  })
})
