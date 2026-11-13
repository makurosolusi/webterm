/** @vitest-environment jsdom */
// "Reveal setting" (settingsPanel.reveal.ts): a `field` scrolls its `[data-field]` element to the centre,
// focuses the field block (never a control that commits on keys), flashes it for ~1.5 s and opens a collapsed group around it; links inside the
// panel name the field they land on. Fetch is stubbed (test-only fixtures).
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
  it('scrolls the field to the centre, focuses the field block (not a radio) and flashes it for ~1.5 s', async () => {
    panel('terminal', 'appTheme')
    const el = await revealed('appTheme')
    expect(scrolled.find((s) => s.el === el)?.arg).toEqual({ block: 'center' })
    // Theme is a segmented choice: a focused radio would turn the next arrow key into a change.
    expect(document.activeElement).toBe(el)
    expect(el.tabIndex).toBe(-1)
    expect(document.activeElement?.closest('[role="radio"]')).toBeNull()
    expect(el.classList.contains(REVEAL_CLASS)).toBe(true)
    await waitFor(() => expect(el.classList.contains(REVEAL_CLASS)).toBe(false), { timeout: REVEAL_MS + 1000 })
  })

  it('an arrow key after a reveal of Central\'s level changes nothing and sends nothing', async () => {
    const onChange = vi.fn()
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={onChange} onClose={vi.fn()} section="central" field="central.level" />)
    const el = await revealed('central.level')
    const posts = (): number => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method && init.method !== 'GET').length
    const before = posts()
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'Home', 'End']) fireEvent.keyDown(document.activeElement ?? el, { key })
    expect(document.activeElement?.getAttribute('role')).not.toBe('radio')
    expect(posts()).toBe(before)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('opens the collapsed group around the field first (Central › Advanced)', async () => {
    panel('central', 'central.checkinLimit')
    const el = await revealed('central.checkinLimit')
    expect((el.closest('details') as HTMLDetailsElement).open).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(el)) // a select commits on arrows (Windows/Linux)
  })

  it('opens a page\'s Advanced disclosure around the field (Terminal › Advanced › Word separators)', async () => {
    panel('shell', 'terminalWordSeparator') // a legacy section id still lands on the page that holds the field
    const el = await revealed('terminalWordSeparator')
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
  it('Claude › Advanced: a moved field (Central’s profile) opens the collapsed Advanced group', async () => {
    panel('claude', 'centralClaudeProfileId')
    const el = await revealed('centralClaudeProfileId')
    expect((el.closest('details') as HTMLDetailsElement).open).toBe(true)
  })

  it('a TOC click is a plain section change: the field is cleared', async () => {
    const onSectionChange = vi.fn()
    panel('central', 'central.level', onSectionChange)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Section settings' })).getByRole('button', { name: 'Rules & secrets' }))
    expect(onSectionChange).toHaveBeenCalledWith('rules', undefined)
  })
})
