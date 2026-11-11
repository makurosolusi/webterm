/**
 * @vitest-environment jsdom
 */
// The purpose sections compose the existing panels: each page mounts its panels (and only through the
// Settings sidebar), Spending links to Central's own limit. Every backend answers 404 here; the panels
// degrade on their own, which their own tests cover.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SettingsPanel } from './SettingsPanel'
import { SpendingSection } from './SpendingSection'

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"not_found"}', { status: 404 }))) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const open = (label: string): void => {
  render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={() => {}} onClose={() => {}} />)
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Section settings' })).getByRole('button', { name: label }))
}

describe('Settings purpose sections', () => {
  it.each([
    ['Rules & approvals', 'rules-section', ['policy-rules', 'policy-simulator', 'secrets-panel']],
    ['Memory', 'memory-section', ['agent-memory']],
    ['Automations', 'automations-section', ['routines-panel']],
    ['Spending', 'spending-section', ['cost-panel']],
    ['Health', 'health-section', ['doctor']],
    ['Developer', 'developer-section', ['control-panel']],
  ])('%s mounts its panels', async (label, section, panels) => {
    open(label)
    const root = await screen.findByTestId(section)
    for (const id of panels) expect(await within(root).findByTestId(id), id).toBeTruthy()
  })

  it('Spending links to the Central Agent section for Central\'s own limit', () => {
    const onNavigate = vi.fn()
    render(<SpendingSection onNavigate={onNavigate} />)
    expect(screen.getByText(/Central's own limit/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Central Agent' }))
    expect(onNavigate).toHaveBeenCalledWith({ section: 'central', field: 'central.costLimit' })
  })

  it('the Central Agent cost report link lands on Spending', async () => {
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={() => {}} onClose={() => {}} initialSection="spending" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Spending' })).toBeTruthy()
    expect(await screen.findByTestId('cost-panel')).toBeTruthy()
  })
})
