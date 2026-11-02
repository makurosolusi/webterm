/**
 * @vitest-environment jsdom
 */
// Section Environment: grup + badge, simpan/reset, secret write-only, locked/dangerous, error, banner restart.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EnvSection } from './EnvSection'
import { SettingsSearchProvider } from './SettingsFields'
import type { EnvEntry, EnvState } from './envSettingsApi'

vi.setConfig({ testTimeout: 30_000 })

const SENTINEL = 'TOK-SENTINEL-1234567890'
const mk = (e: Partial<EnvEntry> & Pick<EnvEntry, 'key' | 'kind'>): EnvEntry => ({
  group: 'telegram', label: `Label ${e.key}`, description: `Desc ${e.key}`, source: 'default',
  restartRequired: false, pendingRestart: false, dangerous: false, editable: true, ...e,
})
const base = (): EnvState => ({
  locked: false,
  entries: [
    mk({ key: 'PORT', kind: 'string', group: 'bootstrap', set: true, source: 'env', editable: false, restartRequired: true }),
    mk({ key: 'WEBTERM_TELEGRAM', kind: 'flag', value: 'off', default: 'off' }),
    mk({ key: 'WEBTERM_LEDGER', kind: 'enum', group: 'ledger', options: ['off', 'shadow', 'on'], value: 'shadow', default: 'off', source: 'override', restartRequired: true }),
    mk({ key: 'WEBTERM_CENTRAL_MODEL', kind: 'string', group: 'central', value: 'm1', default: 'm1' }),
    mk({ key: 'WEBTERM_RETRIES', kind: 'number', group: 'central', value: '3', default: '3' }),
    mk({ key: 'WEBTERM_TELEGRAM_BOT_TOKEN', kind: 'secret', set: false }),
    mk({ key: 'WEBTERM_OPENCODE_BIN', kind: 'string', group: 'control', value: 'x', dangerous: true, editable: false }),
  ],
})

interface Call { method: string; body?: string }
let calls: Call[]
let getState: EnvState
let putReply: { status: number; body: unknown } | ((body: Record<string, unknown>) => { status: number; body: unknown })

beforeEach(() => {
  calls = []
  getState = base()
  putReply = { status: 200, body: { ...base(), restartRequired: [] } }
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ method, body: init.body as string | undefined })
    if (method === 'GET') return new Response(JSON.stringify(getState), { status: 200 })
    const r = typeof putReply === 'function' ? putReply(JSON.parse(init.body as string)) : putReply
    return new Response(JSON.stringify(r.body), { status: r.status })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const puts = (): unknown[] => calls.filter((c) => c.method === 'PUT').map((c) => JSON.parse(c.body!))
const row = async (key: string): Promise<HTMLElement> => screen.findByRole('listitem', { name: key })

describe('EnvSection', () => {
  it('renders groups in stable order with bootstrap last and source badges', async () => {
    render(<EnvSection />)
    await row('WEBTERM_LEDGER')
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(headings).toEqual(['Ledger', 'Telegram', 'Central', 'Kontrol', 'Bootstrap (hanya lewat env)'])
    expect(within(await row('WEBTERM_LEDGER')).getByText('override')).toBeTruthy()
    expect(within(await row('WEBTERM_LEDGER')).getByText('restart')).toBeTruthy()
    expect(within(await row('WEBTERM_TELEGRAM')).getByText('default')).toBeTruthy()
    expect(within(await row('WEBTERM_OPENCODE_BIN')).getByText('berbahaya')).toBeTruthy()
  })

  it('shows pending restart badge', async () => {
    getState.entries[2] = { ...getState.entries[2]!, pendingRestart: true }
    render(<EnvSection />)
    expect(within(await row('WEBTERM_LEDGER')).getByText('menunggu restart')).toBeTruthy()
  })

  it('saves a flag with the right PUT body', async () => {
    render(<EnvSection />)
    const r = await row('WEBTERM_TELEGRAM')
    const save = within(r).getByRole('button', { name: 'Simpan WEBTERM_TELEGRAM' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(within(r).getByRole('radio', { name: 'on' }))
    fireEvent.click(save)
    await waitFor(() => expect(puts()).toEqual([{ set: { WEBTERM_TELEGRAM: 'on' } }]))
  })

  it('saves an enum, a number and a string', async () => {
    render(<EnvSection />)
    fireEvent.click(within(await row('WEBTERM_LEDGER')).getByRole('radio', { name: 'on' }))
    fireEvent.click(within(await row('WEBTERM_LEDGER')).getByRole('button', { name: 'Simpan WEBTERM_LEDGER' }))
    const num = within(await row('WEBTERM_RETRIES')).getByLabelText('Label WEBTERM_RETRIES (WEBTERM_RETRIES)')
    fireEvent.change(num, { target: { value: '7' } })
    fireEvent.click(within(await row('WEBTERM_RETRIES')).getByRole('button', { name: 'Simpan WEBTERM_RETRIES' }))
    const str = within(await row('WEBTERM_CENTRAL_MODEL')).getByLabelText('Label WEBTERM_CENTRAL_MODEL (WEBTERM_CENTRAL_MODEL)')
    fireEvent.change(str, { target: { value: 'm2' } })
    fireEvent.click(within(await row('WEBTERM_CENTRAL_MODEL')).getByRole('button', { name: 'Simpan WEBTERM_CENTRAL_MODEL' }))
    await waitFor(() => expect(puts()).toEqual([
      { set: { WEBTERM_LEDGER: 'on' } }, { set: { WEBTERM_RETRIES: '7' } }, { set: { WEBTERM_CENTRAL_MODEL: 'm2' } },
    ]))
  })

  it('offers Reset only for overrides and sends unset', async () => {
    render(<EnvSection />)
    expect(within(await row('WEBTERM_TELEGRAM')).queryByRole('button', { name: /^Reset/ })).toBeNull()
    const r = await row('WEBTERM_LEDGER')
    expect(within(r).getByText(/mengembalikan ke nilai env atau default/)).toBeTruthy()
    fireEvent.click(within(r).getByRole('button', { name: 'Reset WEBTERM_LEDGER' }))
    await waitFor(() => expect(puts()).toEqual([{ unset: ['WEBTERM_LEDGER'] }]))
  })

  it('keeps secrets write-only: empty input, no sentinel in DOM after save', async () => {
    render(<EnvSection />)
    const r = await row('WEBTERM_TELEGRAM_BOT_TOKEN')
    const input = within(r).getByLabelText('Label WEBTERM_TELEGRAM_BOT_TOKEN (WEBTERM_TELEGRAM_BOT_TOKEN)') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    expect(within(r).getByText('Kosong')).toBeTruthy()
    fireEvent.change(input, { target: { value: SENTINEL } })
    putReply = { status: 200, body: { ...base(), entries: base().entries.map((e) => (e.kind === 'secret' ? { ...e, set: true, source: 'override' } : e)), restartRequired: ['WEBTERM_TELEGRAM_BOT_TOKEN'] } }
    fireEvent.click(within(r).getByRole('button', { name: 'Simpan WEBTERM_TELEGRAM_BOT_TOKEN' }))
    await waitFor(() => expect(within(r).getByText('Terisi')).toBeTruthy())
    expect(puts()).toEqual([{ set: { WEBTERM_TELEGRAM_BOT_TOKEN: SENTINEL } }])
    expect(input.value).toBe('')
    expect(document.body.innerHTML).not.toContain(SENTINEL)
    expect(within(r).getByRole('button', { name: 'Hapus WEBTERM_TELEGRAM_BOT_TOKEN' })).toBeTruthy()
  })

  it('clears the secret input even when the save fails, without echoing it', async () => {
    putReply = { status: 400, body: { error: 'invalid_value', key: 'WEBTERM_TELEGRAM_BOT_TOKEN', reason: 'has an unexpected shape' } }
    render(<EnvSection />)
    const r = await row('WEBTERM_TELEGRAM_BOT_TOKEN')
    const input = within(r).getByLabelText(/WEBTERM_TELEGRAM_BOT_TOKEN\)$/) as HTMLInputElement
    fireEvent.change(input, { target: { value: SENTINEL } })
    fireEvent.click(within(r).getByRole('button', { name: 'Simpan WEBTERM_TELEGRAM_BOT_TOKEN' }))
    expect((await within(r).findByRole('alert')).textContent).toBe('Nilai ditolak server: has an unexpected shape.')
    expect(input.value).toBe('')
    expect(document.body.innerHTML).not.toContain(SENTINEL)
  })

  it('removes an override secret via unset', async () => {
    getState.entries[5] = { ...getState.entries[5]!, set: true, source: 'override' }
    render(<EnvSection />)
    fireEvent.click(within(await row('WEBTERM_TELEGRAM_BOT_TOKEN')).getByRole('button', { name: 'Hapus WEBTERM_TELEGRAM_BOT_TOKEN' }))
    await waitFor(() => expect(puts()).toEqual([{ unset: ['WEBTERM_TELEGRAM_BOT_TOKEN'] }]))
  })

  it('disables everything and shows a banner when locked', async () => {
    getState.locked = true
    render(<EnvSection />)
    expect(await screen.findByText(/Dikunci oleh WEBTERM_ENV_SETTINGS=off/)).toBeTruthy()
    const r = await row('WEBTERM_TELEGRAM')
    for (const b of within(r).getAllByRole('radio')) expect((b as HTMLButtonElement).disabled).toBe(true)
    expect((within(await row('WEBTERM_TELEGRAM_BOT_TOKEN')).getByLabelText(/BOT_TOKEN\)$/) as HTMLInputElement).disabled).toBe(true)
    expect((within(await row('WEBTERM_LEDGER')).getByRole('button', { name: 'Reset WEBTERM_LEDGER' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables non-editable dangerous entries and explains why', async () => {
    render(<EnvSection />)
    const r = await row('WEBTERM_OPENCODE_BIN')
    expect((within(r).getByLabelText(/OPENCODE_BIN\)$/) as HTMLInputElement).disabled).toBe(true)
    expect(within(r).getByText(/Butuh token root/)).toBeTruthy()
  })

  it('shows bootstrap entries read-only without any value', async () => {
    render(<EnvSection />)
    const r = await row('PORT')
    expect(r.textContent).toContain('hanya lewat env')
    expect(r.textContent).toContain('Terisi')
    expect(within(r).queryByRole('button')).toBeNull()
    expect(within(r).queryByRole('textbox')).toBeNull()
  })

  it('shows the static reason for invalid_value on the entry', async () => {
    putReply = { status: 400, body: { error: 'invalid_value', key: 'WEBTERM_RETRIES', reason: 'must be a number' } }
    render(<EnvSection />)
    const r = await row('WEBTERM_RETRIES')
    fireEvent.change(within(r).getByLabelText(/RETRIES\)$/), { target: { value: 'zzz-typed' } })
    fireEvent.click(within(r).getByRole('button', { name: 'Simpan WEBTERM_RETRIES' }))
    const alert = await within(r).findByRole('alert')
    expect(alert.textContent).toBe('Nilai ditolak server: must be a number.')
    expect(document.body.textContent).not.toContain('zzz-typed')
  })

  it.each([
    [403, 'token_required', 'Butuh token root untuk mengubah pengaturan ini.'],
    [403, 'locked', 'Pengaturan dikunci oleh WEBTERM_ENV_SETTINGS=off.'],
    [413, 'payload_too_large', 'Permintaan terlalu besar.'],
    [500, 'store_failed', 'Server gagal menyimpan perubahan. Tidak ada yang berubah.'],
  ])('maps %i %s to a brief message', async (status, error, message) => {
    putReply = { status, body: { error } }
    render(<EnvSection />)
    const r = await row('WEBTERM_TELEGRAM')
    fireEvent.click(within(r).getByRole('radio', { name: 'on' }))
    fireEvent.click(within(r).getByRole('button', { name: 'Simpan WEBTERM_TELEGRAM' }))
    expect((await within(r).findByRole('alert')).textContent).toBe(message)
  })

  it('shows a network error without details', async () => {
    render(<EnvSection />)
    const r = await row('WEBTERM_TELEGRAM')
    fireEvent.click(within(r).getByRole('radio', { name: 'on' }))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch http://x/api/settings/env') }))
    fireEvent.click(within(r).getByRole('button', { name: 'Simpan WEBTERM_TELEGRAM' }))
    expect((await within(r).findByRole('alert')).textContent).toBe('Tidak bisa menghubungi server.')
  })

  it('shows a restart banner from the PUT response and replaces state', async () => {
    putReply = { status: 200, body: { ...base(), entries: base().entries.map((e) => (e.key === 'WEBTERM_LEDGER' ? { ...e, value: 'on', pendingRestart: true } : e)), restartRequired: ['WEBTERM_LEDGER', 'WEBTERM_TELEGRAM'] } }
    render(<EnvSection />)
    fireEvent.click(within(await row('WEBTERM_LEDGER')).getByRole('radio', { name: 'on' }))
    fireEvent.click(within(await row('WEBTERM_LEDGER')).getByRole('button', { name: 'Simpan WEBTERM_LEDGER' }))
    expect(await screen.findByText('Perlu restart server untuk: WEBTERM_LEDGER, WEBTERM_TELEGRAM')).toBeTruthy()
    expect(within(await row('WEBTERM_LEDGER')).getByText('menunggu restart')).toBeTruthy()
  })

  it('shows a brief load error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    render(<EnvSection />)
    expect((await screen.findByRole('alert')).textContent).toBe('Permintaan gagal. Coba lagi.')
  })

  it('renders nothing and does not fetch while a settings search is active', () => {
    const { container } = render(<SettingsSearchProvider query="font"><EnvSection /></SettingsSearchProvider>)
    expect(container.textContent).toBe('')
    expect(calls).toHaveLength(0)
  })
})
