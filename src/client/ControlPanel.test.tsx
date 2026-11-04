/**
 * @vitest-environment jsdom
 */
// Settings › Control (F0-c): grouped table, modified bar, env-only filter, MOCK badge, protection fallback.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { AGENT_PROTECTION_PATH, CONTROL_EFFECTIVE_PATH, ControlPanel, type EffectiveConfig, type EffectiveRow } from './ControlPanel'
import { SettingsPanel } from './SettingsPanel'

// test-only fixture rows
const row = (key: string, extra: Partial<EffectiveRow>): EffectiveRow => ({
  key, label: key, description: '', subsystem: 'Central agent', value: 'off', secret: false, source: 'default',
  reason: 'Code default.', modified: false, ui: null, envOnly: true, ...extra,
})
const config = (mock: boolean): EffectiveConfig => ({
  mock: { active: mock, keys: mock ? ['WEBTERM_CENTRAL_RUNTIME'] : [] },
  rows: [
    row('WEBTERM_CENTRAL', { value: 'on', source: 'settings', modified: true, ui: 'Settings › Capabilities › Central agent', envOnly: false }),
    row('WEBTERM_CENTRAL_RUNTIME', { value: mock ? 'mock' : 'auto (claude)', ...(mock ? { mock: true as const } : {}), ui: 'x', envOnly: false }),
    row('WEBTERM_CENTRAL_MAX_STEPS', { value: '2' }),
    row('WEBTERM_TELEGRAM_BOT_TOKEN', { subsystem: 'Telegram', secret: true, set: true, value: '', ui: 'y', envOnly: false }),
  ],
})

function stub(mock: boolean, protection: unknown = null): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === CONTROL_EFFECTIVE_PATH) return new Response(JSON.stringify(config(mock)), { status: 200 })
    if (url === AGENT_PROTECTION_PATH && protection) return new Response(JSON.stringify(protection), { status: 200 })
    return new Response('{"error":"not_found"}', { status: 404 })
  }))
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ControlPanel', () => {
  it('groups by subsystem, marks modified rows, shows secrets as set/unset, degrades without protection API', async () => {
    stub(false)
    render(<ControlPanel />)
    const central = await screen.findByRole('region', { name: 'Central agent' })
    expect(within(central).getAllByRole('row')).toHaveLength(4) // header + 3
    expect(screen.getByRole('region', { name: 'Telegram' }).textContent).toContain('set')
    expect(document.querySelector('[data-key="WEBTERM_CENTRAL"]')?.getAttribute('data-modified')).toBe('true')
    expect(document.querySelector('[data-key="WEBTERM_CENTRAL_MAX_STEPS"]')?.hasAttribute('data-modified')).toBe(false)
    expect(await screen.findByText('Agent protection status is not available yet.')).toBeTruthy()
    expect(screen.queryByText('MOCK')).toBeNull()
  })

  it('env-only and modified filters, and text search', async () => {
    stub(false)
    render(<ControlPanel />)
    await screen.findByRole('region', { name: 'Central agent' })
    fireEvent.click(screen.getByLabelText('Env-only (no UI switch)'))
    expect(screen.getByRole('status').textContent).toBe('1 of 4 settings')
    expect(document.querySelector('[data-key="WEBTERM_CENTRAL_MAX_STEPS"]')).not.toBeNull()
    fireEvent.click(screen.getByLabelText('Env-only (no UI switch)'))
    fireEvent.click(screen.getByLabelText('Modified'))
    expect(screen.getByRole('status').textContent).toBe('1 of 4 settings')
    fireEvent.click(screen.getByLabelText('Modified'))
    fireEvent.change(screen.getByLabelText('Filter settings'), { target: { value: 'telegram' } })
    expect(screen.getByRole('status').textContent).toBe('1 of 4 settings')
  })

  it('red MOCK badge when a runtime is simulated, and renders protection levels', async () => {
    stub(true, [{ kind: 'claude', level: 'protected', reasons: ['deny rules'] }, { kind: 'codex', level: 'mitigation', reasons: [] }])
    render(<ControlPanel />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('MOCK')
    expect(alert.textContent).toContain('WEBTERM_CENTRAL_RUNTIME')
    const items = await screen.findAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual(['claude: Protected — deny rules', 'codex: Mitigation only'])
  })

  it('load failure is reported, not silent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    render(<ControlPanel />)
    expect((await screen.findByRole('alert')).textContent).toContain('could not be loaded')
  })

  it('is mounted as the Control tab in Settings', async () => {
    stub(false)
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={() => {}} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Control' }))
    expect(await screen.findByTestId('control-panel')).toBeTruthy()
    expect(await screen.findByRole('region', { name: 'Central agent' })).toBeTruthy()
  })
})
