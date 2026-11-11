/** @vitest-environment jsdom */
// Policy: a field saved to the server shows the pick at once, then "Saved" or, on failure, the old
// value plus an inline error (role=alert) inside that field with Retry; the undo toast only follows a
// confirmed save. Real useSettings, fetch faked as a tiny server.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SettingsItemScopeProvider } from './settingsContext'
import { SettingsSearchProvider, ToggleField } from './SettingsFields'
import { useSettings, type UseSettings } from './useSettings'

let failPut: boolean
let puts: unknown[]
beforeEach(() => {
  failPut = true
  puts = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      if (failPut) return new Response(JSON.stringify({ error: 'disk full' }), { status: 500 }) // test-only
      puts.push(JSON.parse(String(init.body)))
      return new Response(null, { status: 200 })
    }
    return new Response(JSON.stringify(DEFAULT_SETTINGS), { status: 200 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

let last: UseSettings | null = null
function Harness({ query = '' }: { query?: string }) {
  const s = useSettings()
  last = s
  if (!s.hydrated) return null
  return (
    <SettingsSearchProvider query={query}>
      <SettingsItemScopeProvider category="Terminal" settings={s.settings} onChange={s.update}>
        <ToggleField id="blink" label="Cursor blink" hint="Blink the cursor." setting="cursorBlink" value={s.settings.cursorBlink} onChange={(v) => s.update({ cursorBlink: v })} />
      </SettingsItemScopeProvider>
    </SettingsSearchProvider>
  )
}

const fieldOf = (): HTMLElement => screen.getByLabelText('Cursor blink').closest('[data-slot="settings-field"]') as HTMLElement

describe('settings field save path', () => {
  it('a failed save reverts the value and shows the error at the field with Retry; no toast', async () => {
    render(<Harness />)
    const box = await screen.findByLabelText('Cursor blink') as HTMLInputElement
    const before = box.checked
    fireEvent.click(box)
    expect((screen.getByLabelText('Cursor blink') as HTMLInputElement).checked).toBe(!before) // pending shows at once

    const alert = await within(fieldOf()).findByRole('alert', {}, { timeout: 2000 })
    expect(alert.textContent).toContain('Could not save: disk full')
    await waitFor(() => expect((screen.getByLabelText('Cursor blink') as HTMLInputElement).checked).toBe(before)) // reverted
    expect(last?.history.notice).toBeNull()

    failPut = false
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect((screen.getByLabelText('Cursor blink') as HTMLInputElement).checked).toBe(!before)
    await waitFor(() => expect(within(fieldOf()).getByRole('status').textContent).toContain('Saved'), { timeout: 2000 })
    expect(puts).toEqual([{ cursorBlink: !before }])
    expect(last?.history.notice?.kind).toBe('changed') // toast only after the server confirmed
  })

  it('a modified setting shows the dot and a visible Reset; the page prefix only in search', async () => {
    failPut = false
    render(<Harness />)
    fireEvent.click(await screen.findByLabelText('Cursor blink'))
    expect(within(fieldOf()).getByText('(Modified)')).toBeTruthy()
    expect(fieldOf().querySelector('.st-category')).toBeNull()
    const reset = within(fieldOf()).getByRole('button', { name: 'Reset Setting: Cursor blink' })
    expect(reset.textContent).toBe('Reset')
    fireEvent.click(reset)
    expect((screen.getByLabelText('Cursor blink') as HTMLInputElement).checked).toBe(DEFAULT_SETTINGS.cursorBlink)
    expect(within(fieldOf()).queryByText('(Modified)')).toBeNull()

    cleanup()
    render(<Harness query="blink" />)
    await screen.findByLabelText('Cursor blink')
    expect(fieldOf().querySelector('.st-category')?.textContent).toBe('Terminal: ')
  })
})
