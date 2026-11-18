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
let chainBroken = false // test-only: filesWrite tersimpan on tapi prasyaratnya (files) mati
let engineStep = false // test-only: central menunggu mesin agen (kind belum ada di tipe bersama)
const mkView = (id: CapabilityId): CapabilityView => ({
  id, title: CAPABILITIES[id].title, blurb: CAPABILITIES[id].blurb,
  status: on.has(id) ? 'on' : id === 'browser' || (chainBroken && id === 'filesWrite') ? 'needs-step' : 'off',
  ...(id === 'browser' ? { step: { kind: 'chromiumPath' as const, label: 'Pilih lokasi' } } : {}),
  ...(chainBroken && id === 'filesWrite' ? { step: { kind: 'fixChain' as const, label: 'Turn on what’s needed' } } : {}),
  ...(engineStep && id === 'central'
    ? { status: 'needs-step' as const, step: { kind: 'agentEngine', label: 'Set up Claude Code' } as unknown as CapabilityView['step'] }
    : {}),
  ...(id === 'workers' && on.has(id) ? { subs: [{ key: 'k', label: 'Ask for approval before a worker runs', on: true }] } : {}),
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
  fireEvent.click(within(nav).getByRole('button', { name: 'Features' }))
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
    // The page itself (the sidebar's "Rules & secrets" is another page).
    expect(within(screen.getByRole('main', { name: 'Settings' })).queryByText(/webhook|polling|secret|mode|operator/i)).toBeNull()
    expect(main.querySelector('input[type="search"]')).toBeNull()
  })

  it('Browser, Files and Telegram only: one switch per card, no Central summary, no engine, no provider or token card', async () => {
    const main = await openCapabilities()
    // One titled card per feature, then the page's Advanced.
    expect([...main.querySelectorAll('[data-slot="settings-group"] > h3')].map((h) => h.textContent)).toEqual(['Browser', 'Files', 'Telegram'])
    // Two switched cards (Browser, Files); Telegram has its paste-token flow.
    expect(screen.getAllByRole('switch')).toHaveLength(2)
    expect([...main.querySelectorAll('[data-capability]')].map((el) => el.getAttribute('data-capability'))).toEqual(['browser', 'files', 'telegram'])
    expect(within(main).queryByRole('region', { name: 'Central Agent' })).toBeNull()
    expect(within(main).queryByText(/Managed in Central Agent/)).toBeNull()
    expect(within(main).queryByText('Engine')).toBeNull()
    expect(main.querySelector('[data-field="claude-provider"]')).toBeNull()
    expect(within(main).getAllByRole('region', { name: /Telegram/ }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Pilih lokasi' })).toBeTruthy()
    expect(screen.getByLabelText('Search engine')).toBeTruthy()
  })

  it('Edit and upload files is a sub-switch of the Files card (shown while Files is on)', async () => {
    on.add('files')
    try {
      const main = await openCapabilities()
      const files = main.querySelector('[data-capability="files"]') as HTMLElement
      const sub = within(files).getByRole('switch', { name: CAPABILITIES.filesWrite.title })
      expect(sub.closest('.st-field--sub')).toBeTruthy()
      fireEvent.click(sub)
      await waitFor(() => expect(calls).toContain('POST /api/capabilities/filesWrite'))
      expect(JSON.parse(bodies['POST /api/capabilities/filesWrite'] ?? '{}')).toEqual({ enabled: true })
    } finally {
      on.delete('files')
    }
  })

  it('a refused change is shown on the card that was changed, not at the page top', async () => {
    const main = await openCapabilities()
    const base = globalThis.fetch as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) =>
      (init.method === 'POST' && url === '/api/capabilities/files' ? new Response('{}', { status: 500 }) : base(url, init))))
    const files = main.querySelector('[data-capability="files"]') as HTMLElement
    fireEvent.click(within(files).getByRole('switch'))
    expect((await within(files).findByRole('alert')).textContent).toContain('did not go through')
    const browser = main.querySelector('[data-capability="browser"]') as HTMLElement
    expect(within(browser).queryByRole('alert')).toBeNull()
  })

  // Advanced: Chromium location (+ download) and Reset. Engine is in Central Agent, the data folder in Health.
  it('Advanced is closed and holds Chromium and Reset only', async () => {
    const main = await openCapabilities()
    const details = main.querySelector('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(within(details).getByText('Advanced')).toBeTruthy()
    expect(details.querySelector('[data-field="chromium"]')).toBeTruthy()
    expect(within(details).getByRole('button', { name: 'Reset capabilities' })).toBeTruthy()
    expect(within(details).queryByText('/tmp/webterm-data')).toBeNull()
    expect(details.querySelector('[data-field="agentEngine"]')).toBeNull()
  })

  it('the Browser step opens Advanced; Reset asks first, then calls the server and shows the result', async () => {
    const main = await openCapabilities()
    fireEvent.click(screen.getByRole('button', { name: 'Pilih lokasi' }))
    await waitFor(() => expect((main.querySelector('details') as HTMLDetailsElement).open).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Reset capabilities' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(calls).not.toContain('POST /api/capabilities/reset')
    fireEvent.click(screen.getByRole('button', { name: 'Reset capabilities' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reset capabilities' }))
    await waitFor(() => expect(calls).toContain('POST /api/capabilities/reset'))
    expect((await screen.findByText('Capabilities are back to their defaults')).closest('[data-action-result]')?.getAttribute('data-action-result')).toBe('ok')
  })

  it('search finds cards by title, blurb and keywords from the index, without mounting the page', async () => {
    await openCapabilities()
    const search = screen.getByRole('searchbox', { name: 'Search settings' })
    const rows = (q: string): string[] => {
      fireEvent.change(search, { target: { value: q } })
      const group = document.querySelector('[aria-labelledby="st-group-capabilities"]')
      return group ? [...group.querySelectorAll('.st-result-go')].map((el) => el.textContent ?? '').filter((t) => t.includes('›')) : [] // rows of settings, not the page row
    }
    expect(rows('Telegram')).toEqual([`Features › ${CAPABILITIES.telegram.title}`])
    expect(document.querySelector('[data-capability]')).toBeNull() // the page is not mounted while searching
    expect(rows('cookie')).toEqual([`Features › ${CAPABILITIES.browser.title}`])
    expect(rows('chrome')).toEqual([`Features › ${CAPABILITIES.browser.title}`, 'Features › Chromium location'])
    expect(rows('upload')).toEqual([`Features › ${CAPABILITIES.filesWrite.title}`])
    expect(rows('zzz-nothing')).toEqual([])
  })

  it('projectId dari SettingsPanel diteruskan ke kartu Telegram saat menautkan chat', async () => {
    telegramOn = true
    await openCapabilities()
    fireEvent.click(await screen.findByRole('button', { name: 'Link' }))
    await waitFor(() => expect(calls.some((c) => c.startsWith('POST') && c.endsWith('/bindings'))).toBe(true))
    const key = calls.find((c) => c.startsWith('POST') && c.endsWith('/bindings')) as string
    expect(JSON.parse(bodies[key] as string)).toMatchObject({ projectId: 'p1', chatId: '555' })
  })
})
