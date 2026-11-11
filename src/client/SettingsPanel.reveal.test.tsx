/** @vitest-environment jsdom */
// "Reveal setting" (settingsPanel.reveal.ts): a `field` scrolls its `[data-field]` element to the centre,
// focuses its control, flashes it for ~1.5 s and opens a collapsed group around it; the Central links
// inside the panel name the field they land on. Fetch is stubbed (test-only fixtures).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITIES, CAPABILITY_IDS, type CapabilitiesResponse } from '../shared/featureCapabilities'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { SettingsFieldId } from './settings.link'
import { REVEAL_CLASS, REVEAL_MS } from './settingsPanel.reveal'
import { SettingsPanel } from './SettingsPanel'
import { resetCapabilitiesCache } from './useCapabilities'

const caps = (): CapabilitiesResponse => ({ // test-only
  capabilities: CAPABILITY_IDS.map((id) => ({ id, title: CAPABILITIES[id].title, blurb: CAPABILITIES[id].blurb, status: 'on' as const })),
  advanced: { agentEngine: { value: 'auto', detected: 'claude' }, chromiumPath: { value: '', detected: false, active: null, source: null, overrideInvalid: false, candidates: [] }, dataDir: '/tmp/d' },
})
const ENV = ['WEBTERM_CENTRAL_MODEL', 'WEBTERM_CENTRAL_TURN_STEPS'] // test-only
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

let scrolled: { el: Element; arg: unknown }[]
beforeEach(() => {
  resetCapabilitiesCache()
  scrolled = []
  Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) { scrolled.push({ el: this, arg }) }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/capabilities')) return json(caps())
    if (url === '/api/settings/env') return json({ locked: false, entries: ENV.map((key) => ({ key, value: '', effective: '', default: '', editable: true })) })
    if (url === '/api/central/checkin-settings') return json({ enabled: false, dailyLimit: 10, usedToday: 0 })
    return json({ items: [] })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (Element.prototype as Partial<Element>).scrollIntoView })

const panel = (section: string, field?: SettingsFieldId, onSectionChange = vi.fn()) =>
  render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} section={section} field={field} onSectionChange={onSectionChange} />)
const target = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-field="${id}"]`)!
const revealed = async (id: string): Promise<HTMLElement> => {
  await waitFor(() => expect(scrolled.some((s) => s.el === target(id))).toBe(true))
  return target(id)
}

describe('deep link to a setting', () => {
  it('scrolls the field to the centre, focuses its control and flashes it for ~1.5 s', async () => {
    panel('terminal', 'appTheme')
    const el = await revealed('appTheme')
    expect(scrolled.find((s) => s.el === el)?.arg).toEqual({ block: 'center' })
    expect(document.activeElement).toBe(within(el).getByRole('combobox'))
    expect(el.classList.contains(REVEAL_CLASS)).toBe(true)
    await waitFor(() => expect(el.classList.contains(REVEAL_CLASS)).toBe(false), { timeout: REVEAL_MS + 1000 })
  })

  it('opens the collapsed group around the field first (Central › Advanced)', async () => {
    panel('central', 'central.model')
    const el = await revealed('central.model')
    expect((el.closest('details') as HTMLDetailsElement).open).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(el.querySelector('select')))
  })

  it('opens a page\'s Advanced disclosure around the field (Terminal › Advanced › Default shell)', async () => {
    panel('shell', 'defaultShell') // a legacy section id still lands on the page that holds the field
    const el = await revealed('defaultShell')
    expect((el.closest('details') as HTMLDetailsElement).open).toBe(true)
  })

  it('without a field nothing is revealed: the section opens at the top', async () => {
    panel('terminal')
    await waitFor(() => expect(document.querySelector('.st-section-title')).not.toBeNull())
    await new Promise((r) => setTimeout(r, 100))
    expect(scrolled).toEqual([])
  })
})

describe('links inside Settings name the field they land on', () => {
  const cases: [string, string, SettingsFieldId][] = [
    ['Open Launch profiles', 'agent', 'claudeLaunchProfiles'],
    ['Open Model ladder & per-workspace overrides', 'agent', 'model-ladder'],
    ['Open Spending report', 'spending', 'cost-panel'],
    ['Open Browser', 'capabilities', 'capability.browser'],
    ['Open Telegram', 'capabilities', 'capability.telegram'],
  ]
  it.each(cases)('Central › %s → %s › %s', async (name, section, field) => {
    const onSectionChange = vi.fn()
    panel('central', undefined, onSectionChange)
    fireEvent.click(await screen.findByRole('button', { name }))
    expect(onSectionChange).toHaveBeenCalledWith(section, field)
  })

  it('uncontrolled, the panel reveals the target itself (Central → Agent › Launch profiles)', async () => {
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} initialSection="central" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open Launch profiles' }))
    await revealed('claudeLaunchProfiles')
  })

  it('Spending → Central’s own limit', async () => {
    const onSectionChange = vi.fn()
    panel('spending', undefined, onSectionChange)
    fireEvent.click(await within(screen.getByRole('main', { name: 'Settings' })).findByRole('button', { name: 'Central Agent' }))
    expect(onSectionChange.mock.calls).toEqual([['central', 'central.costLimit']])
  })

  it('a TOC click is a plain section change: the field is cleared', async () => {
    const onSectionChange = vi.fn()
    panel('central', 'central.profile', onSectionChange)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Section settings' })).getByRole('button', { name: 'Memory' }))
    expect(onSectionChange).toHaveBeenCalledWith('memory', undefined)
  })
})
