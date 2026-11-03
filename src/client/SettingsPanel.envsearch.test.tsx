/**
 * @vitest-environment jsdom
 */
// Pencarian lintas Environment di SettingsPanel: provider dan EnvSection di-mock (milik ENV-03/04)
// supaya yang diuji murni kontrak ENV-05 — hitungan env+Channels, tautan tab Channels, draft selamat.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SettingsPanel } from './SettingsPanel'

// test-only: entri sintetis, tanpa nilai nyata.
const fixture = vi.hoisted(() => {
  const base = { kind: 'flag', value: 'off', source: 'default', editable: true, valid: true }
  return [
    { ...base, key: 'WEBTERM_LEDGER', label: 'Catatan ledger', description: 'Menyimpan riwayat', owner: 'ledger', section: 'Ledger', group: 'ledger' },
    { ...base, key: 'WEBTERM_TELEGRAM', label: 'Bot Telegram', description: 'Aktifkan bot', owner: 'channels', section: 'Telegram', group: 'telegram' },
    { ...base, key: 'WEBTERM_CENTRAL_NOTIFY', label: 'Notifikasi pusat', description: 'Kirim ringkasan lewat telegram', owner: 'central', section: 'Central', group: 'central' },
  ]
})

vi.mock('./useEnvSettings', async () => {
  const React = await import('react')
  const Ctx = React.createContext<unknown>(null)
  return {
    EnvSettingsProvider: ({ children, query }: { children: React.ReactNode; query: string }) => {
      const [draft, setDraftState] = React.useState<Map<string, string>>(new Map())
      const api = {
        state: { entries: fixture }, draft, query,
        setDraft: (k: string, v: string) => setDraftState((m) => new Map(m).set(k, v)),
      }
      return React.createElement(Ctx.Provider, { value: api }, children)
    },
    useEnvSettingsContext: () => React.useContext(Ctx),
  }
})

vi.mock('./EnvSection', async () => {
  const React = await import('react')
  const { useEnvSettingsContext } = await import('./useEnvSettings')
  const { matchesEntry } = await import('./envSearch')
  return {
    EnvSection: () => {
      const env = useEnvSettingsContext() as unknown as {
        state: { entries: typeof fixture }; draft: Map<string, string>; query: string; setDraft(k: string, v: string): void
      }
      const rows = env.state.entries.filter((e) => e.owner !== 'channels' && matchesEntry(e as never, env.query))
      return React.createElement('div', null,
        React.createElement('button', { onClick: () => env.setDraft('WEBTERM_LEDGER', 'on') }, 'isi draft'),
        React.createElement('output', { 'data-testid': 'draft' }, [...env.draft].join(',')),
        ...rows.map((e) => React.createElement('div',
          { key: e.key, className: 'st-field', 'data-slot': 'settings-field', 'data-env-key': e.key }, e.label)))
    },
  }
})

afterEach(cleanup)

const renderPanel = () =>
  render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} />)
const search = () => screen.getByRole('searchbox', { name: 'Cari setting' })
const count = () => document.querySelector('.st-search-count')?.textContent

describe('SettingsPanel search across Environment', () => {
  it('finds an env row by KEY and counts it', () => {
    renderPanel()
    fireEvent.change(search(), { target: { value: 'WEBTERM_LEDGER' } })
    expect(document.querySelector('[data-env-key="WEBTERM_LEDGER"]')).not.toBeNull()
    expect(count()).toBe('1 setting ditemukan')
  })

  it('finds by description and sums env rows with the Channels-owned hit', () => {
    renderPanel()
    fireEvent.change(search(), { target: { value: 'telegram' } })
    // Central cocok lewat deskripsi, Telegram milik Channels: keduanya terhitung.
    expect(document.querySelector('[data-env-key="WEBTERM_CENTRAL_NOTIFY"]')).not.toBeNull()
    expect(document.querySelector('[data-env-key="WEBTERM_TELEGRAM"]')).toBeNull()
    expect(count()).toBe('2 setting ditemukan')
  })

  it('points a Channels-owned hit to the Channels tab and leaves search mode on click', () => {
    renderPanel()
    fireEvent.change(search(), { target: { value: 'telegram' } })
    fireEvent.click(screen.getByRole('button', { name: 'ada di tab Channels' }))
    expect((search() as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('heading', { level: 2, name: 'Channels' })).toBeTruthy()
    expect(within(screen.getByRole('navigation', { name: 'Section settings' }))
      .getByRole('button', { name: 'Channels' }).getAttribute('aria-current')).toBe('true')
  })

  it('keeps unsaved env drafts while typing in and clearing the search', () => {
    renderPanel()
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Section settings' })).getByRole('button', { name: 'Environment' }))
    fireEvent.click(screen.getByRole('button', { name: 'isi draft' }))
    expect(screen.getByTestId('draft').textContent).toBe('WEBTERM_LEDGER,on')

    fireEvent.change(search(), { target: { value: 'ledger' } })
    fireEvent.change(search(), { target: { value: 'ledger riwayat' } })
    expect(screen.getByTestId('draft').textContent).toBe('WEBTERM_LEDGER,on')
    fireEvent.change(search(), { target: { value: '' } })
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Section settings' })).getByRole('button', { name: 'Environment' }))
    expect(screen.getByTestId('draft').textContent).toBe('WEBTERM_LEDGER,on')
  })
})
