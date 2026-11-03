/**
 * @vitest-environment jsdom
 */
// Section "Fitur & server": header/filter/Segarkan, struktur Lanjutan, kartu server, banner, catatan Channels,
// pencarian tanpa membuang draft, lompat ke kunci, simpan massal, provider luar vs provider sendiri.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvSection } from './EnvSection'
import { SettingsSearchProvider } from './SettingsFields'
import { baseState, mkEntry, putBodies, stubEnvApi } from './envTestFixtures'
import { EnvSettingsProvider } from './useEnvSettings'

vi.mock('./EnvEntryRow', async () => (await import('./envTestFixtures')).mockRowModule())
vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const item = (key: string): HTMLElement => document.querySelector(`[data-env-item="${key}"]`) as HTMLElement
const isHidden = (key: string): boolean => item(key).hasAttribute('hidden')

describe('EnvSection', () => {
  it('renders title, filters and Segarkan on one header, user sections open, advanced collapsed in Lanjutan', async () => {
    stubEnvApi(baseState())
    render(<EnvSection />)
    await screen.findByTestId('row-K_ONE')
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Fitur & server')
    const head = document.querySelector('.st-env-head') as HTMLElement
    for (const name of ['Diubah', 'Perlu restart', 'Berbahaya', 'Segarkan']) expect(within(head).getByRole('button', { name })).toBeTruthy()
    const [secA, lanjutan] = [...document.querySelectorAll('details')] as HTMLDetailsElement[]
    expect(secA!.open).toBe(true)
    expect(secA!.querySelector('summary')?.textContent).toContain('Sec A')
    expect(lanjutan!.open).toBe(false)
    expect(lanjutan!.querySelector('summary')?.textContent).toContain('Lanjutan')
    expect(lanjutan!.contains(screen.getByTestId('row-K_ADV'))).toBe(true)
  })

  it('shows the server card; the explanation only when the root gate is off', async () => {
    stubEnvApi(baseState())
    render(<EnvSection />)
    await screen.findByRole('region', { name: 'Info server' })
    expect(screen.queryByText(/butuh WEBTERM_TOKEN/)).toBeNull()
    cleanup()
    stubEnvApi({ ...baseState(), rootGate: false, server: { tokenSet: false, settingsLocked: false } })
    render(<EnvSection />)
    expect(await screen.findByText(/butuh WEBTERM_TOKEN/)).toBeTruthy()
  })

  it('shows the locked banner and passes locked to rows', async () => {
    stubEnvApi({ ...baseState(), locked: true })
    render(<EnvSection />)
    expect(await screen.findByText(/Dikunci oleh WEBTERM_ENV_SETTINGS=off/)).toBeTruthy()
    expect(screen.getByTestId('row-K_ONE').dataset.locked).toBe('true')
  })

  it('keeps channels entries in Environment when channelsOwned is off, replaces them with one link when on (default)', async () => {
    const st = baseState()
    st.entries = [...st.entries, mkEntry({ key: 'K_TG', owner: 'channels' })]
    stubEnvApi(st)
    render(<EnvSection channelsOwned={false} />)
    expect(await screen.findByTestId('row-K_TG')).toBeTruthy()
    expect(screen.queryByText('Konfigurasi Telegram ada di tab Channels.')).toBeNull()
    cleanup()
    stubEnvApi(st)
    const onOpenChannels = vi.fn()
    render(<EnvSection onOpenChannels={onOpenChannels} />)
    await screen.findByTestId('row-K_ONE')
    expect(screen.queryByTestId('row-K_TG')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Konfigurasi Telegram ada di tab Channels.' }))
    expect(onOpenChannels).toHaveBeenCalledWith('K_TG')
  })

  it('quick filter "Berbahaya" hides the others without unmounting and toggles off', async () => {
    stubEnvApi(baseState())
    render(<EnvSection />)
    await screen.findByTestId('row-K_ONE')
    const chip = screen.getByRole('button', { name: 'Berbahaya' })
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(isHidden('K_DANGER')).toBe(false)
    expect(isHidden('K_ONE')).toBe(true)
    expect(screen.getByTestId('row-K_ONE')).toBeTruthy()
    fireEvent.click(chip)
    expect(isHidden('K_ONE')).toBe(false)
  })

  it('shows a no-match note when the filter leaves nothing', async () => {
    stubEnvApi(baseState())
    render(<EnvSection />)
    await screen.findByTestId('row-K_ONE')
    fireEvent.click(screen.getByRole('button', { name: 'Perlu restart' }))
    expect(screen.getByText('Tidak ada pengaturan yang cocok.')).toBeTruthy()
  })

  it('search hides rows (no return null), opens Lanjutan on a match, and never drops drafts', async () => {
    stubEnvApi(baseState())
    const ui = (q: string) => <SettingsSearchProvider query={q}><EnvSection /></SettingsSearchProvider>
    const { rerender } = render(ui(''))
    await screen.findByTestId('row-K_ONE')
    fireEvent.click(screen.getByText('draft K_ONE'))
    rerender(ui('k_adv'))
    expect(isHidden('K_ONE')).toBe(true)
    expect(isHidden('K_ADV')).toBe(false)
    expect((document.querySelectorAll('details')[1] as HTMLDetailsElement).open).toBe(true)
    expect(screen.getByText('1 perubahan belum disimpan')).toBeTruthy()
    rerender(ui(''))
    expect(isHidden('K_ONE')).toBe(false)
    expect(screen.getByTestId('row-K_ONE').dataset.draft).toBe('on')
  })

  it('fetches lazily once on a query and not before anything asks for it', async () => {
    const stub = stubEnvApi(baseState())
    render(<EnvSettingsProvider query=""><p>no consumer</p></EnvSettingsProvider>)
    await Promise.resolve()
    expect(stub.calls).toHaveLength(0)
  })

  it('uses an outer provider (no second fetch / second state) when present', async () => {
    const stub = stubEnvApi(baseState())
    render(<EnvSettingsProvider query=""><EnvSection /></EnvSettingsProvider>)
    await screen.findByTestId('row-K_ONE')
    expect(stub.calls.filter((c) => c.method === 'GET')).toHaveLength(1)
  })

  it('Segarkan refetches and keeps a draft that still differs', async () => {
    const stub = stubEnvApi(baseState())
    render(<EnvSection />)
    fireEvent.click(await screen.findByText('draft K_ONE'))
    fireEvent.click(screen.getByRole('button', { name: 'Segarkan' }))
    await waitFor(() => expect(stub.calls.filter((c) => c.method === 'GET')).toHaveLength(2))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Segarkan' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByTestId('row-K_ONE').dataset.draft).toBe('on')
  })

  it('saves drafts of several keys in one PUT via the save bar', async () => {
    const stub = stubEnvApi(baseState())
    render(<EnvSection />)
    fireEvent.click(await screen.findByText('draft K_ONE'))
    fireEvent.click(screen.getByText('draft K_TWO'))
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }))
    await waitFor(() => expect(putBodies(stub)).toEqual([{ set: { K_ONE: 'on', K_TWO: 'changed' } }]))
  })

  it('onJump opens Lanjutan, scrolls and focuses the control of the target key', async () => {
    stubEnvApi(baseState())
    Element.prototype.scrollIntoView = vi.fn()
    render(<EnvSection />)
    fireEvent.click(await screen.findByText('jump K_ONE'))
    expect((document.querySelectorAll('details')[1] as HTMLDetailsElement).open).toBe(true)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    expect(item('K_ADV').contains(document.activeElement)).toBe(true)
  })

  it('shows a brief load error without crashing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    render(<EnvSection />)
    expect((await screen.findByRole('alert')).textContent).toBe('Permintaan gagal. Coba lagi.')
  })
})
