/**
 * @vitest-environment jsdom
 */
// ES-14 permukaan ENVSIMPLE: teks UI kemampuan bebas kata/elemen terlarang (PREAMBLE, D8) dan nama env var.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITIES, CAPABILITY_IDS } from '../shared/featureCapabilities'
import type { CapabilitiesResponse, CapabilityId, CapabilityView } from '../shared/featureCapabilities'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SettingsPanel, toSectionId } from './SettingsPanel'
import { resetCapabilitiesCache } from './useCapabilities'

// `mode` as a whole word (jargon), not inside "model": Central Agent has a Model & cost group.
const BANNED_WORDS = /webhook|polling|secret|\bmodes?\b|restart|berbahaya|operator/i
const ENV_NAMES = /\b(WEBTERM|NODETERM)_[A-Z0-9_]+/
const NEW_LABELS = ['advancedLabels.ts', 'capabilitiesLabels.ts', 'telegramCardLabels.ts', 'centralSettingsLabels.ts']
const UI_SOURCES = [...NEW_LABELS, 'CapabilitiesSection.tsx', 'AdvancedSection.tsx', 'CapabilityCard.tsx', 'CapabilityOffer.tsx', 'TelegramCard.tsx', 'CentralSettingsSection.tsx', 'centralSettings.controls.tsx']
const OLD_UI = /Diubah|Perlu restart|Berbahaya|Segarkan|Default|Aktif sekarang|Tersimpan|Atur ulang|Ledger|Bayangan|Belum berpengaruh|tab Channels|Dikunci|Token root|Info server/

const read = (f: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), f), 'utf8')
/** Literal string + teks JSX dari sumber, tanpa komentar (komentar boleh menyebut istilah lama sebagai KENAPA). */
function uiText(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')
  const lits = [...code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '')
  const jsx = [...code.matchAll(/>([^<>{}\n]+)</g)].map((m) => m[1] as string)
  return [...lits, ...jsx]
}

describe('sumber teks UI baru', () => {
  it('pemindai menemukan teks pada berkas label', () => {
    for (const f of NEW_LABELS) expect(uiText(read(f)).filter((t) => t.trim().length > 3).length, f).toBeGreaterThan(2)
    expect(uiText("const a = 'halo dunia' // WEBTERM_X")).toEqual(['halo dunia'])
  })

  it.each(UI_SOURCES)('%s: tanpa kata terlarang dan tanpa nama env var', (f) => {
    const text = uiText(read(f))
    expect(text.filter((t) => BANNED_WORDS.test(t)), `kata terlarang di ${f}`).toEqual([])
    expect(text.filter((t) => ENV_NAMES.test(t)), `env var di ${f}`).toEqual([])
    expect(text.filter((t) => OLD_UI.test(t)), `istilah UI lama di ${f}`).toEqual([])
  })

  it('channelsLabels (sisa galat Telegram) tanpa nama env var', () => {
    expect(uiText(read('channelsLabels.ts')).filter((t) => ENV_NAMES.test(t))).toEqual([])
  })

  it('katalog bersama (judul, blurb, label sub-opsi) tanpa kata terlarang dan env var', () => {
    const texts = CAPABILITY_IDS.flatMap((id) => {
      const d = CAPABILITIES[id]
      return [d.title, d.blurb, ...(d.subs ?? []).map((s) => s.label)]
    })
    expect(texts.filter((t) => BANNED_WORDS.test(t) || ENV_NAMES.test(t))).toEqual([])
  })
})

const mkView = (id: CapabilityId, on: ReadonlySet<CapabilityId>): CapabilityView => ({
  id, title: CAPABILITIES[id].title, blurb: CAPABILITIES[id].blurb,
  status: on.has(id) ? 'on' : id === 'browser' ? 'needs-step' : 'off',
  ...(id === 'browser' ? { step: { kind: 'chromiumPath' as const, label: 'Pilih lokasi' } } : {}),
  ...(id === 'workers' && on.has(id) ? { subs: [{ key: 'runRequireApproval', label: 'Ask for approval before a worker runs', on: true }] } : {}),
})
const fixture = (on: ReadonlySet<CapabilityId>): CapabilitiesResponse => ({
  capabilities: CAPABILITY_IDS.map((id) => mkView(id, on)),
  advanced: { agentEngine: { value: 'auto', detected: 'claude' }, chromiumPath: { value: '', detected: false, active: null, source: null, overrideInvalid: false, candidates: [] }, dataDir: '/tmp/webterm-data' },
})

async function openCapabilities(on: ReadonlySet<CapabilityId>): Promise<HTMLElement> {
  resetCapabilitiesCache()
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(JSON.stringify(url.startsWith('/api/capabilities') ? fixture(on) : { items: [] }), { status: 200 })))
  render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} projectId="p1" />)
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Section settings' })).getByRole('button', { name: 'Capabilities' }))
  await screen.findAllByRole('switch')
  return screen.getByRole('main', { name: 'Settings' })
}

beforeEach(() => resetCapabilitiesCache())
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('render Settings: 8 elemen UI lama (D8) tidak ada', () => {
  it('teks halaman penuh bebas kata terlarang, nama env var, dan istilah UI lama', async () => {
    await openCapabilities(new Set<CapabilityId>(['central', 'workers']))
    const text = document.body.textContent ?? ''
    expect(text).toContain('Central Agent')
    expect(text).not.toMatch(BANNED_WORDS)
    expect(text).not.toMatch(ENV_NAMES)
    expect(text).not.toMatch(OLD_UI)
    expect(text).not.toMatch(/WEBTERM_TOKEN/)
  })

  it('tanpa chip filter, tanpa tab Channels/Environment, tanpa heading kelompok', async () => {
    await openCapabilities(new Set<CapabilityId>(['central']))
    expect(screen.queryByRole('button', { name: /Diubah|Perlu restart|Berbahaya|Segarkan/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Channels' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Environment' })).toBeNull()
    expect(screen.queryByRole('heading', { name: /^(Dasar|Central)$/ })).toBeNull()
    expect(toSectionId('env')).toBe('capabilities')
    expect(toSectionId('channels')).toBe('capabilities')
  })

  it('tiga kartu bersakelar (Central/Worker/Otonomi = satu baris ringkasan, Telegram = Hubungkan/Putuskan), lima kartu total', async () => {
    const main = await openCapabilities(new Set<CapabilityId>(['central']))
    expect(screen.getAllByRole('switch')).toHaveLength(CAPABILITY_IDS.length - 4)
    expect(main.querySelectorAll('[data-capability]')).toHaveLength(CAPABILITY_IDS.length - 2)
  })

  it('Lanjutan tertutup dengan tepat empat butir', async () => {
    const main = await openCapabilities(new Set<CapabilityId>(['central']))
    const details = main.querySelector('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelectorAll(':scope > div').length).toBe(4) // butir, bukan kontrol: Chromium punya beberapa tombol
  })

  it('Central: tanpa sakelar persetujuan worker terpisah (Propose selalu bertanya), halaman bebas kata terlarang dan env var', async () => {
    await openCapabilities(new Set<CapabilityId>(['central', 'workers']))
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Section settings' })).getByRole('button', { name: 'Central' }))
    await screen.findByRole('radiogroup', { name: 'What Central may do' })
    expect(screen.queryByRole('switch', { name: 'Ask before each worker runs' })).toBeNull()
    const text = screen.getByRole('main', { name: 'Settings' }).textContent ?? ''
    expect(text).not.toMatch(BANNED_WORDS)
    expect(text).not.toMatch(ENV_NAMES)
  })
})
