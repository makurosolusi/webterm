/**
 * @vitest-environment jsdom
 */
// Settings › Developer table (F0-c): owned rows by default, "Show everything" for the rest, grouped by
// subsystem, modified bar, secrets as set/unset, label first with the key under it; mounted as Developer.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { CONTROL_WHERE } from '../shared/envSettings.contract'
import { CONTROL_EFFECTIVE_PATH, ControlPanel, type EffectiveConfig, type EffectiveRow } from './ControlPanel'
import { resetDeveloperModeCache, writeDeveloperMode } from './developerMode'
import { SettingsPanel } from './SettingsPanel'

// test-only fixture rows
const row = (key: string, extra: Partial<EffectiveRow>): EffectiveRow => ({
  key, label: key, description: '', subsystem: 'Central agent', value: 'off', secret: false, source: 'default',
  reason: 'Code default.', modified: false, ui: CONTROL_WHERE, kind: 'flag', editable: true,
  restart: 'hot', setting: 'off', pendingRestart: false, ...extra,
})
// test-only fixture: one owned row, three that "Show everything" reveals
const config = (): EffectiveConfig => ({
  mock: { active: false, keys: [] },
  rows: [
    row('WEBTERM_CENTRAL', { value: 'on', source: 'settings', modified: true, ui: 'Settings › Capabilities › Central agent', editable: false }),
    row('WEBTERM_CENTRAL_RUNTIME', { value: 'mock', mock: true, ui: 'x', editable: false }),
    row('WEBTERM_CENTRAL_TURN_STEPS', { label: 'Turn steps', value: '12', kind: 'number', setting: '12' }),
    row('WEBTERM_TOKEN', { subsystem: 'Bootstrap', secret: true, set: true, value: '', ui: null, editable: false, lockReason: 'Bootstrap-only by design.' }),
  ],
})

function stub(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === CONTROL_EFFECTIVE_PATH) return new Response(JSON.stringify(config()), { status: 200 })
    if (url === '/api/control/doctor') return new Response('{"checks":[]}', { status: 200 })
    return new Response('{"error":"not_found"}', { status: 404 })
  }))
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const status = (): string => screen.getAllByRole('status').map((s) => s.textContent).find((t) => t?.includes(' of ')) ?? ''

describe('Developer table', () => {
  it('shows only rows owned here by default, label first and the key under it', async () => {
    stub()
    render(<ControlPanel />)
    const central = await screen.findByRole('region', { name: 'Central agent' })
    expect(within(central).getAllByRole('row')).toHaveLength(2) // header + the owned row
    expect(status()).toBe('1 of 4 settings')
    const cell = document.querySelector('[data-key="WEBTERM_CENTRAL_TURN_STEPS"] td') as HTMLElement
    expect(cell.firstElementChild?.textContent).toBe('Turn steps')
    expect(cell.querySelector('code')?.textContent).toBe('WEBTERM_CENTRAL_TURN_STEPS')
    expect(screen.queryByRole('region', { name: 'Bootstrap' })).toBeNull()
    expect(screen.queryByLabelText('Modified')).toBeNull()
    expect(screen.queryByLabelText('Bootstrap only (no UI switch)')).toBeNull()
  })

  it('Show everything reveals managed, derived and bootstrap rows; the filter box still narrows', async () => {
    stub()
    render(<ControlPanel />)
    await screen.findByRole('region', { name: 'Central agent' })
    fireEvent.click(screen.getByRole('switch', { name: 'Show everything' }))
    expect(status()).toBe('4 of 4 settings')
    expect(screen.getByRole('region', { name: 'Bootstrap' }).textContent).toContain('set')
    expect(document.querySelector('[data-key="WEBTERM_CENTRAL"]')?.getAttribute('data-modified')).toBe('true')
    expect(document.querySelector('[data-key="WEBTERM_CENTRAL_TURN_STEPS"]')?.hasAttribute('data-modified')).toBe(false)
    expect(document.querySelector('[data-key="WEBTERM_CENTRAL_RUNTIME"]')?.textContent).toContain('MOCK')
    fireEvent.change(screen.getByLabelText('Filter settings'), { target: { value: 'bootstrap' } })
    expect(status()).toBe('1 of 4 settings')
  })

  it('load failure is reported, not silent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    render(<ControlPanel />)
    const alerts = await screen.findAllByRole('alert')
    expect(alerts.map((a) => a.textContent).join(' ')).toContain('effective configuration could not be loaded')
  })

  it('is mounted as the Developer section in Settings, with eval cases in a closed disclosure', async () => {
    stub()
    writeDeveloperMode(true) // Developer is listed only in developer mode
    try {
      render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={() => {}} onClose={() => {}} />)
      fireEvent.click(screen.getByRole('button', { name: 'Developer' }))
      expect(await screen.findByTestId('control-panel')).toBeTruthy()
      expect(await screen.findByRole('region', { name: 'Central agent' })).toBeTruthy()
      const details = screen.getByText('Show eval cases').closest('details') as HTMLDetailsElement
      expect(details.open).toBe(false)
    } finally {
      writeDeveloperMode(false)
      resetDeveloperModeCache()
    }
  })
})
