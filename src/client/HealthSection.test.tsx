/**
 * @vitest-environment jsdom
 */
// Settings › Health: demo-mode banner, agent protection as plain lines (and its fallback), the Doctor; old
// `control` links land here.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { AGENT_PROTECTION_PATH, CONTROL_DOCTOR_PATH, CONTROL_EFFECTIVE_PATH } from './ControlPanel'
import { HealthSection } from './HealthSection'
import { SettingsPanel } from './SettingsPanel'
import { OPEN_SETTINGS_EVENT } from './settings.link'
import { resetCapabilitiesCache } from './useCapabilities'

const TELEGRAM_OFF = { id: 'telegram', title: 'Telegram bot', status: 'off', detail: 'No bot token. Connect a bot in the Telegram settings.', go: { field: 'capability.telegram' } }
const SKILLS_STALE = { id: 'skills', title: 'Agent skills and house rules', status: 'fail', detail: 'Out of date.', fix: 'Reinstall' }

function stub(mock: boolean, protection: unknown = null, checks: unknown[] = [{ id: 'dataDir', title: 'Data folder', status: 'ok', detail: 'Private.' }]): void {
  resetCapabilitiesCache()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === CONTROL_DOCTOR_PATH && init.method === 'POST') return new Response(JSON.stringify({ ...SKILLS_STALE, status: 'ok', detail: 'Current.', fix: undefined }), { status: 200 })
    if (url === CONTROL_DOCTOR_PATH) return new Response(JSON.stringify({ checks }), { status: 200 })
    if (url === '/api/capabilities') return new Response(JSON.stringify({ capabilities: [], advanced: { dataDir: '/home/u/.webterm-server' } }), { status: 200 })
    // test-only fixture
    if (url === CONTROL_EFFECTIVE_PATH) return new Response(JSON.stringify({ mock: { active: mock, keys: mock ? ['WEBTERM_CENTRAL_RUNTIME'] : [] }, rows: [] }), { status: 200 })
    if (url === AGENT_PROTECTION_PATH && protection) return new Response(JSON.stringify(protection), { status: 200 })
    return new Response('{"error":"not_found"}', { status: 404 })
  }))
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('HealthSection', () => {
  it('demo-mode banner with the MOCK badge, and one line per partly protected agent', async () => {
    stub(true, [{ kind: 'claude', level: 'protected', reasons: ['deny rules'] }, { kind: 'codex', level: 'mitigation', reasons: ['no sandbox'] }])
    render(<HealthSection />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('MOCK')
    expect(alert.textContent).toContain('Central is running in demo mode; replies are not real.')
    const items = await screen.findAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toContain('Partly protected — codex: no sandbox')
    expect(items.map((li) => li.textContent)).not.toContain('Agents are protected')
  })

  it('one plain line when every agent is protected; no banner without a simulated runtime', async () => {
    stub(false, [{ kind: 'claude', level: 'protected', reasons: [] }])
    render(<HealthSection />)
    expect(await screen.findByText('Agents are protected')).toBeTruthy()
    expect(screen.queryByText('MOCK')).toBeNull()
  })

  it('degrades without the protection API and still runs the Doctor', async () => {
    stub(false)
    render(<HealthSection />)
    expect(await screen.findByText('Agent protection status is not available yet.')).toBeTruthy()
    expect(await screen.findByText('Data folder', { selector: 'strong' })).toBeTruthy()
  })

  it('shows the data folder (moved from Features › Advanced)', async () => {
    stub(false)
    render(<HealthSection />)
    expect((await screen.findByTestId('data-dir')).textContent).toBe('/home/u/.webterm-server')
  })

  it('"where to fix it" is a link to that exact field; a Fix shows its result', async () => {
    stub(false, null, [TELEGRAM_OFF, SKILLS_STALE])
    const seen = vi.fn()
    window.addEventListener(OPEN_SETTINGS_EVENT, seen)
    render(<HealthSection />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open Telegram' }))
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: 'capabilities', field: 'capability.telegram' })
    window.removeEventListener(OPEN_SETTINGS_EVENT, seen)
    const row = document.querySelector('[data-check="skills"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Reinstall' }))
    await waitFor(() => expect(within(row).getByText('Fixed: Agent skills and house rules is OK now')).toBeTruthy())
  })

  it('an old `control` deep link opens Health', async () => {
    stub(false)
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={() => {}} onClose={() => {}} initialSection="control" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Health' })).toBeTruthy()
    expect(await screen.findByTestId('health-section')).toBeTruthy()
  })
})
