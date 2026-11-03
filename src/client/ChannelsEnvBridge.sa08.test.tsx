/**
 * @vitest-environment jsdom
 */
// WS-SA-08: lompat lintas-tab Channels -> Environment (onOpenEnv), kunci pindahan SA-02 di grup Telegram,
// hierarki ul>li, Segarkan terpisah dari chip, kartu Info server di chip Berbahaya, dan envLabels tanpa string mati.
// State dari registry nyata (setupEnv), bukan fixture sintetis.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { setupEnv } from '../server/envSettings.testutil'
import * as labels from './envLabels'
import { EnvSection } from './EnvSection'
import { SettingsPanel } from './SettingsPanel'
import { stubEnvApi } from './envTestFixtures'

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const realState = (rootGate = true) => ({ ...setupEnv().svc.state({ root: rootGate }), rootGate })

/** Panel penuh; status Channels = nonaktif (404) supaya hanya /api/settings/env yang diuji. */
function renderPanel(): void {
  stubEnvApi(realState())
  const envFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) =>
    url.startsWith('/api/channels') ? new Response('{}', { status: 404 }) : envFetch(url, init)))
  render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} />)
}

describe('Channels -> Environment bridge (onOpenEnv)', () => {
  it('renders the SA-02 moved keys in one Telegram group without duplicate React keys', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Channels' }))
    for (const key of ['WEBTERM_CENTRAL_BOTS', 'WEBTERM_CHANNEL_APPROVAL_BUTTONS', 'WEBTERM_TRUST_PROXY', 'WEBTERM_TELEGRAM']) {
      expect(await screen.findByLabelText(key)).toBeTruthy()
    }
    const groups = document.querySelectorAll('.st-ch-config details.st-env-group')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.querySelector('summary')?.textContent).toContain('Telegram')
    expect(errors.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false)
  })

  it('"Buka" on an Environment-owned prerequisite switches to Environment and focuses that key', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Channels' }))
    fireEvent.click((await screen.findAllByRole('button', { name: 'Buka WEBTERM_LEDGER' }))[0]!)
    const row = await screen.findByLabelText('WEBTERM_LEDGER')
    expect(document.querySelector('.st-section-title')?.textContent).toBe('Environment')
    await waitFor(() => expect(row.contains(document.activeElement)).toBe(true))
    expect(screen.queryByLabelText('WEBTERM_TELEGRAM')).toBeNull()
  })

  it('"Buka" on a Channels-owned prerequisite stays on Channels and focuses locally', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Channels' }))
    const open = (await screen.findAllByRole('button', { name: 'Buka WEBTERM_TELEGRAM' }))[0]!
    fireEvent.click(open)
    const row = screen.getByLabelText('WEBTERM_TELEGRAM')
    await waitFor(() => expect(row.contains(document.activeElement)).toBe(true))
    expect(document.querySelector('.st-section-title')?.textContent).toBe('Channels')
  })
})

describe('Environment markup', () => {
  it('every entry row <li> has a <ul> parent', async () => {
    stubEnvApi(realState())
    render(<EnvSection />)
    await screen.findByLabelText('WEBTERM_LEDGER')
    const rows = [...document.querySelectorAll('li.st-env-row')]
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.every((li) => li.parentElement?.tagName === 'UL')).toBe(true)
  })

  it('Segarkan sits outside the quick-filter chip group', async () => {
    stubEnvApi(realState())
    render(<EnvSection />)
    const refresh = await screen.findByRole('button', { name: 'Segarkan' })
    const chips = screen.getByRole('group', { name: 'Filter cepat' })
    expect(chips.contains(refresh)).toBe(false)
    expect(within(chips).getAllByRole('button')).toHaveLength(3)
    expect(refresh.className).toContain('st-env-refresh')
  })

  it('Info server stays visible under the Berbahaya chip, hides under other chips', async () => {
    stubEnvApi(realState(false))
    render(<EnvSection />)
    const card = (await screen.findByRole('region', { name: 'Info server' })).parentElement as HTMLElement
    expect(card.hidden).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Berbahaya' }))
    expect(card.hidden).toBe(false)
    expect(within(card).getByText(/Atur WEBTERM_TOKEN/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Berbahaya' }))
    fireEvent.click(screen.getByRole('button', { name: 'Perlu restart' }))
    expect(card.hidden).toBe(true)
  })
})

describe('envLabels', () => {
  it('exports only ENV and none of the removed dead strings', () => {
    expect(Object.keys(labels)).toEqual(['ENV'])
    const dead = ['categoryRoot', 'secretHint', 'bootstrapOnly', 'title', 'loading', 'refresh', 'restartBanner', 'save']
    for (const k of dead) expect(labels.ENV).not.toHaveProperty(k)
  })
})
