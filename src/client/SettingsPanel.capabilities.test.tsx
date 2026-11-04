/**
 * @vitest-environment jsdom
 */
// D8 (b §7): tab Kemampuan tanpa sisa UI env lama. Render SettingsPanel nyata dengan fetch distub (fixture 7 kemampuan).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITIES, CAPABILITY_IDS } from '../shared/featureCapabilities'
import type { CapabilitiesResponse, CapabilityId, CapabilityView } from '../shared/featureCapabilities'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SettingsPanel } from './SettingsPanel'
import { resetCapabilitiesCache } from './useCapabilities'

const on = new Set<CapabilityId>(['central', 'workers'])
let chainBroken = false // test-only: autonomy tersimpan on tapi prasyaratnya mati
let engineStep = false // test-only: central menunggu mesin agen (kind belum ada di tipe bersama)
const mkView = (id: CapabilityId): CapabilityView => ({
  id, title: CAPABILITIES[id].title, blurb: CAPABILITIES[id].blurb,
  status: on.has(id) ? 'on' : id === 'browser' || (chainBroken && id === 'autonomy') ? 'needs-step' : 'off',
  ...(id === 'browser' ? { step: { kind: 'chromiumPath' as const, label: 'Pilih lokasi' } } : {}),
  ...(chainBroken && id === 'autonomy' ? { step: { kind: 'fixChain' as const, label: 'Nyalakan yang dibutuhkan' } } : {}),
  ...(engineStep && id === 'central'
    ? { status: 'needs-step' as const, step: { kind: 'agentEngine', label: 'Pasang atau login Claude Code / OpenCode' } as unknown as CapabilityView['step'] }
    : {}),
  ...(id === 'workers' && on.has(id) ? { subs: [{ key: 'k', label: 'Minta persetujuan sebelum worker berjalan', on: true }] } : {}),
})
const fixture = (): CapabilitiesResponse => ({
  capabilities: CAPABILITY_IDS.map(mkView),
  advanced: { agentEngine: { value: 'auto', detected: 'claude' }, chromiumPath: { value: '', detected: false, active: null, source: null, overrideInvalid: false, candidates: [] }, dataDir: '/tmp/webterm-data' },
})

let calls: string[]
let bodies: Record<string, string | undefined>
let telegramOn = false
beforeEach(() => {
  calls = []
  bodies = {}
  telegramOn = false
  chainBroken = false
  engineStep = false
  resetCapabilitiesCache()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url}`
    calls.push(key)
    bodies[key] = init.body as string | undefined
    if (key === 'GET /api/channels/telegram/pending') {
      return new Response(JSON.stringify({ items: telegramOn ? [{ chatId: '555', type: 'private', firstSeen: 1, lastSeen: 2, count: 1 }] : [] }), { status: 200 })
    }
    if (!url.startsWith('/api/capabilities')) return new Response(JSON.stringify({ items: [] }), { status: 200 })
    const body = fixture()
    if (telegramOn && url === '/api/capabilities') body.capabilities = body.capabilities.map((c) => (c.id === 'telegram' ? { ...c, status: 'on' as const } : c))
    return new Response(JSON.stringify(body), { status: 200 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function openCapabilities(): Promise<HTMLElement> {
  render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} projectId="p1" />)
  const nav = screen.getByRole('navigation', { name: 'Section settings' })
  fireEvent.click(within(nav).getByRole('button', { name: 'Kemampuan' }))
  await screen.findAllByRole('switch')
  return screen.getByRole('main', { name: 'Settings' })
}

describe('tab Kemampuan (D8)', () => {
  it('tidak memuat sisa UI Environment/Channels/restart/berbahaya', async () => {
    const main = await openCapabilities()
    const body = document.body
    expect(screen.queryByRole('button', { name: /Diubah|Perlu restart|Berbahaya|Segarkan/ })).toBeNull()
    expect(within(body).queryByText(/restart/i)).toBeNull()
    expect(within(body).queryByText(/Default|Aktif sekarang|Tersimpan|Atur ulang/)).toBeNull()
    expect(within(body).queryByText(/WEBTERM_[A-Z_]+/)).toBeNull()
    expect(within(body).queryByText(/Ledger|Bayangan/)).toBeNull()
    expect(within(body).queryByText(/Belum berpengaruh/)).toBeNull()
    expect(within(body).queryByRole('heading', { name: /^(Dasar|Central)$/ })).toBeNull()
    expect(within(body).queryByText(/tab Channels/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Channels' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Environment' })).toBeNull()
    expect(within(body).queryByText(/Berbahaya|Dikunci|Token root|Info server|WEBTERM_TOKEN/)).toBeNull()
    expect(within(body).queryByText(/webhook|polling|secret|mode|operator/i)).toBeNull()
    expect(main.querySelector('input[type="search"]')).toBeNull()
  })

  it('satu sakelar per kartu (Telegram memakai Hubungkan/Putuskan), sub-opsi hanya saat Worker on', async () => {
    const main = await openCapabilities()
    // Enam kartu bersakelar; Telegram punya alur tempel-token, bukan sakelar.
    expect(screen.getAllByRole('switch')).toHaveLength(CAPABILITY_IDS.length - 1)
    expect(main.querySelectorAll('[data-capability]')).toHaveLength(CAPABILITY_IDS.length)
    expect(screen.getByLabelText('Minta persetujuan sebelum worker berjalan')).toBeTruthy()
    expect(within(main).getAllByRole('region', { name: /Telegram/ }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Pilih lokasi' })).toBeTruthy()
  })

  // Batasnya EMPAT BUTIR (mesin, Chromium, folder data, setel ulang), bukan empat kontrol: butir Chromium
  // sengaja punya beberapa tombol (simpan / pakai otomatis / deteksi ulang / kandidat).
  it('Lanjutan tertutup, berisi tepat empat butir', async () => {
    const main = await openCapabilities()
    const details = main.querySelector('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(within(details).getByText('Lanjutan')).toBeTruthy()
    expect(details.querySelectorAll(':scope > div').length).toBe(4)
    expect(within(details).getByText('/tmp/webterm-data')).toBeTruthy()
  })

  it('tombol langkah Browser membuka Lanjutan; Setel ulang memanggil server lalu memuat ulang', async () => {
    const main = await openCapabilities()
    fireEvent.click(screen.getByRole('button', { name: 'Pilih lokasi' }))
    await waitFor(() => expect((main.querySelector('details') as HTMLDetailsElement).open).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Setel ulang kemampuan' }))
    await waitFor(() => expect(calls).toContain('POST /api/capabilities/reset'))
  })

  it('pencarian mencocokkan judul bagian, judul, blurb, dan kata kunci kartu', async () => {
    const main = await openCapabilities()
    const search = screen.getByRole('searchbox', { name: 'Cari setting' })
    const hits = (q: string): string[] => {
      fireEvent.change(search, { target: { value: q } })
      return [...main.querySelectorAll('[data-capability]')].map((el) => el.getAttribute('data-capability') ?? '')
    }
    expect(hits('Telegram')).toEqual(['telegram'])
    expect(document.querySelector('.st-search-count')?.textContent).toBe('1 setting ditemukan')
    expect(hits('chrome')).toEqual(['browser'])
    expect(main.querySelector('details')).not.toBeNull() // Lanjutan (lokasi Chrome) ikut tampil
    expect(hits('cookie')).toEqual(['browser'])
    expect(hits('localhost')).toEqual(['browser'])
    expect(hits('token')).toEqual(['telegram'])
    expect(hits('unggah')).toEqual(['filesWrite'])
    expect(hits('zzz-tidak-ada')).toEqual([])
    expect(hits('kemampuan')).toHaveLength(CAPABILITY_IDS.length) // judul bagian: semua tampil
  })

  it('langkah agentEngine (Agent Pusat butuh Claude Code/OpenCode) membuka Lanjutan, bukan toggle/reset', async () => {
    engineStep = true
    const main = await openCapabilities()
    fireEvent.click(screen.getByRole('button', { name: 'Pasang atau login Claude Code / OpenCode' }))
    await waitFor(() => expect((main.querySelector('details') as HTMLDetailsElement).open).toBe(true))
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([])
  })

  it('"Nyalakan yang dibutuhkan" menyalakan kartu itu lewat toggle, TIDAK menyetel ulang semua pilihan', async () => {
    chainBroken = true
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true) // kartu Otonomi berbahaya: menyalakan dikonfirmasi
    await openCapabilities()
    fireEvent.click(screen.getByRole('button', { name: 'Nyalakan yang dibutuhkan' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    confirm.mockRestore()
    await waitFor(() => expect(calls).toContain('POST /api/capabilities/autonomy'))
    expect(JSON.parse(bodies['POST /api/capabilities/autonomy'] ?? '{}')).toEqual({ enabled: true })
    expect(calls).not.toContain('POST /api/capabilities/reset')
  })

  it('projectId dari SettingsPanel diteruskan ke kartu Telegram saat menautkan chat', async () => {
    telegramOn = true
    await openCapabilities()
    fireEvent.click(await screen.findByRole('button', { name: 'Tautkan' }))
    await waitFor(() => expect(calls.some((c) => c.startsWith('POST') && c.endsWith('/bindings'))).toBe(true))
    const key = calls.find((c) => c.startsWith('POST') && c.endsWith('/bindings')) as string
    expect(JSON.parse(bodies[key] as string)).toMatchObject({ projectId: 'p1', chatId: '555' })
  })
})
