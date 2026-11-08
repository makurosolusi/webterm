/**
 * @vitest-environment jsdom
 */
// Settings › Health: demo-mode banner, agent protection as plain lines (and its fallback), the Doctor; old
// `control` links land here.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { AGENT_PROTECTION_PATH, CONTROL_DOCTOR_PATH, CONTROL_EFFECTIVE_PATH } from './ControlPanel'
import { HealthSection } from './HealthSection'
import { SettingsPanel } from './SettingsPanel'

function stub(mock: boolean, protection: unknown = null): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    // test-only fixture
    if (url === CONTROL_EFFECTIVE_PATH) return new Response(JSON.stringify({ mock: { active: mock, keys: mock ? ['WEBTERM_CENTRAL_RUNTIME'] : [] }, rows: [] }), { status: 200 })
    if (url === CONTROL_DOCTOR_PATH) return new Response('{"checks":[{"id":"dataDir","title":"Data folder","status":"ok","detail":"Private."}]}', { status: 200 })
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
    expect(await screen.findByText('Data folder')).toBeTruthy()
  })

  it('an old `control` deep link opens Health', async () => {
    stub(false)
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={() => {}} onClose={() => {}} initialSection="control" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Health' })).toBeTruthy()
    expect(await screen.findByTestId('health-section')).toBeTruthy()
  })
})
