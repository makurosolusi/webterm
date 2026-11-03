/**
 * @vitest-environment jsdom
 */
// Konfigurasi Telegram di tab Channels: baris Env asli (bukan tiruan), simpan lewat save bar yang sama,
// token tak pernah dirender, fokus lompatan dari Environment, dan Environment tak lagi memuat kontrol Telegram.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { ChannelsTelegramConfig } from './ChannelsTelegramConfig'
import { EnvSection } from './EnvSection'
import { SettingsPanel } from './SettingsPanel'
import { mkEntry, mkState, putBodies, stubEnvApi } from './envTestFixtures'
import { EnvSettingsProvider } from './useEnvSettings'

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const TG = { owner: 'channels', section: 'Telegram', group: 'g1' } as const
// test-only: nilai sintetis yang tidak boleh muncul di DOM.
const LEAKED = '123456:LEAKED-TOKEN-VALUE'

const tgState = () => mkState([
  mkEntry({ key: 'WEBTERM_TELEGRAM', label: 'Telegram', ...TG }),
  mkEntry({ key: 'WEBTERM_TELEGRAM_MODE', label: 'Mode masuk Telegram', kind: 'enum', options: ['poll', 'webhook'], value: '', ...TG }),
  mkEntry({ key: 'WEBTERM_TELEGRAM_BOT_TOKEN', label: 'Token bot Telegram', kind: 'secret', value: '', secretSet: true, source: 'override', ...TG }),
  mkEntry({ key: 'WEBTERM_TELEGRAM_WEBHOOK_SECRET', label: 'Secret webhook Telegram', kind: 'secret', value: '', secretSet: false, audience: 'advanced', ...TG }),
  mkEntry({ key: 'WEBTERM_LEDGER', label: 'Ledger', kind: 'string', value: 'off', owner: 'platform', section: 'Dasar' }),
])

describe('ChannelsTelegramConfig', () => {
  it('renders toggle, mode and write-only token from registry state with its own provider', async () => {
    stubEnvApi(tgState())
    render(<ChannelsTelegramConfig />)
    expect(await screen.findByLabelText('WEBTERM_TELEGRAM')).toBeTruthy()
    expect(screen.getByLabelText('WEBTERM_TELEGRAM_MODE')).toBeTruthy()
    const token = screen.getByLabelText('WEBTERM_TELEGRAM_BOT_TOKEN')
    expect(within(token).getByText(/Terisi/)).toBeTruthy()
    expect((within(token).getByPlaceholderText('Nilai baru (write-only)') as HTMLInputElement).value).toBe('')
    expect(screen.getByLabelText('WEBTERM_TELEGRAM_WEBHOOK_SECRET')).toBeTruthy()
    expect(screen.queryByLabelText('WEBTERM_LEDGER')).toBeNull()
  })

  it('saves toggle + token in one PUT via the shared save bar and never renders the token', async () => {
    const stub = stubEnvApi(tgState())
    render(<ChannelsTelegramConfig />)
    const tokenInput = within(await screen.findByLabelText('WEBTERM_TELEGRAM_BOT_TOKEN')).getByPlaceholderText('Nilai baru (write-only)')
    fireEvent.click(within(screen.getByLabelText('WEBTERM_TELEGRAM')).getByRole('switch'))
    fireEvent.change(tokenInput, { target: { value: LEAKED } })
    expect(screen.getByText('2 perubahan belum disimpan')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    await waitFor(() => expect(putBodies(stub)).toEqual([{ set: { WEBTERM_TELEGRAM: 'on', WEBTERM_TELEGRAM_BOT_TOKEN: LEAKED } }]))
    await waitFor(() => expect(screen.getByText('Tersimpan')).toBeTruthy())
    expect(document.body.textContent).not.toContain(LEAKED)
    expect([...document.querySelectorAll('input')].some((i) => i.value.includes(LEAKED))).toBe(false)
  })

  it('shares the draft with an outer provider and focuses focusKey once, then reports onFocused', async () => {
    stubEnvApi(tgState())
    const onFocused = vi.fn()
    render(<EnvSettingsProvider query=""><ChannelsTelegramConfig focusKey="WEBTERM_TELEGRAM_MODE" onFocused={onFocused} /></EnvSettingsProvider>)
    await waitFor(() => expect(onFocused).toHaveBeenCalledTimes(1))
    expect(screen.getByLabelText('WEBTERM_TELEGRAM_MODE').contains(document.activeElement)).toBe(true)
  })
})

describe('Environment hands Telegram over to Channels', () => {
  it('drops Telegram controls from Environment and its link switches to the Channels tab with focus', async () => {
    const stub = stubEnvApi(tgState())
    const envFetch = globalThis.fetch
    // Status Channels = nonaktif (404); hanya /api/settings/env yang diuji di sini.
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) =>
      url.startsWith('/api/channels') ? new Response('{}', { status: 404 }) : envFetch(url, init)))
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Environment' }))
    const link = await screen.findByRole('button', { name: 'Konfigurasi Telegram ada di tab Channels.' })
    expect(screen.getByLabelText('WEBTERM_LEDGER')).toBeTruthy()
    expect(screen.queryByLabelText('WEBTERM_TELEGRAM')).toBeNull()
    expect(screen.queryByLabelText('WEBTERM_TELEGRAM_BOT_TOKEN')).toBeNull()
    fireEvent.click(link)
    const first = await screen.findByLabelText('WEBTERM_TELEGRAM')
    expect(document.querySelector('.st-section-title')?.textContent).toBe('Channels')
    await waitFor(() => expect(first.contains(document.activeElement)).toBe(true))
    expect(stub.calls.filter((c) => c.method === 'GET')).toHaveLength(1)
  })

  it('EnvSection without Telegram entries shows no link', async () => {
    stubEnvApi(mkState([mkEntry({ key: 'K_ONE' })]))
    render(<EnvSection />)
    await screen.findByLabelText('K_ONE')
    expect(screen.queryByText('Konfigurasi Telegram ada di tab Channels.')).toBeNull()
  })
})
