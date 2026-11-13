/**
 * @vitest-environment jsdom
 */
// Opening a Settings page only reads. A write on open would flip real switches (workers, autonomy) and restart
// Central and Telegram on every visit. The backend answers like a live install with Central and the Worker
// orchestrator on and autonomy off, so the Central level control and the Features cards render for real.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SettingsPanel } from './SettingsPanel'
import { SETTINGS_SECTIONS } from './settingsSections.registry'

const view = (id: string, status: 'on' | 'off') => ({ id, title: id, blurb: '', status })
const CAPABILITIES = {
  capabilities: [
    view('central', 'on'), view('workers', 'on'), view('autonomy', 'off'), view('browser', 'off'),
    view('files', 'on'), view('filesWrite', 'off'), view('telegram', 'on'),
  ],
  advanced: {
    agentEngine: { value: 'auto', detected: 'claude' },
    chromiumPath: { value: '', detected: false, active: null, source: null, overrideInvalid: false, candidates: [] },
    dataDir: '/data',
  },
}
const entry = (key: string, value: string) => ({
  key, kind: 'number', group: 'central', label: key, description: '', value, source: 'default', default: value,
  restartRequired: false, pendingRestart: false, dangerous: false, editable: true,
})
const ANSWERS: Record<string, unknown> = {
  '/api/capabilities': CAPABILITIES,
  '/api/settings/env': { locked: false, entries: [entry('WEBTERM_CENTRAL_DAILY_SPAWNS', '20'), entry('WEBTERM_CENTRAL_MAX_INFLIGHT', '3'), entry('WEBTERM_CENTRAL_DAILY_COST_MICROS', '0')] },
  '/api/central/checkin-settings': { enabled: false, dailyLimit: 3, usedToday: 0 },
  '/api/control/doctor': { checks: [] },
  '/api/control/effective': { mock: { active: false, keys: [] }, rows: [] },
  '/api/agents/protection': [],
}

/** Pages whose reads this test answers: proves the real load path ran, not an early bail-out. */
const READS: Record<string, string[]> = {
  central: ['/api/capabilities', '/api/settings/env', '/api/central/checkin-settings'],
  capabilities: ['/api/capabilities'],
  health: ['/api/control/doctor'],
  developer: ['/api/control/effective'],
}

let calls: { method: string; path: string }[] = []
beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input instanceof Request ? input.url : input), 'http://x').pathname
    calls.push({ method: (init?.method ?? 'GET').toUpperCase(), path })
    const body = ANSWERS[path]
    return body === undefined
      ? new Response('{"error":"not_found"}', { status: 404, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Let every load effect and its fetch chain settle. */
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const writes = () => calls.filter((c) => c.method !== 'GET')

describe('opening a Settings page never writes', () => {
  it.each(SETTINGS_SECTIONS.map((s) => [s.label, s.id] as const))('%s', async (_label, id) => {
    const onChange = vi.fn()
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={onChange} onClose={() => {}} initialSection={id} />)
    await settle()
    for (const path of READS[id] ?? []) expect(calls.some((c) => c.method === 'GET' && c.path === path), `${id} reads ${path}`).toBe(true)
    expect(writes()).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('walking every page from the sidebar, one after another, writes nothing', async () => {
    const onChange = vi.fn()
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={onChange} onClose={() => {}} />)
    const nav = screen.getByRole('navigation', { name: 'Section settings' })
    for (const button of within(nav).getAllByRole('button')) {
      fireEvent.click(button)
      await settle()
    }
    expect(writes()).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
  })
})
