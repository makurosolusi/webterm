/**
 * @vitest-environment jsdom
 */
// The purpose sections compose the existing panels: each page mounts its panels (and only through the
// Settings sidebar). Memory, Automations and Spending left Settings for the Control side bar: they are gone
// from the sidebar but still found by search, which opens that tab. Every backend answers 404 here.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SettingsPanel } from './SettingsPanel'
import { appNavigate } from './appRoute'
import { setSideBar, useCentralTabRequest } from './secondarySideBar.store'

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"not_found"}', { status: 404 }))) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const open = (label: string): void => {
  render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={() => {}} onClose={() => {}} />)
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Section settings' })).getByRole('button', { name: label }))
}

describe('Settings purpose sections', () => {
  it.each([
    ['Rules & secrets', 'rules-section', ['policy-rules', 'secrets-panel', 'rules-advanced', 'policy-add-rule', 'policy-simulator']],
    ['About this machine', 'health-section', ['doctor']],
  ])('%s mounts its panels', async (label, section, panels) => {
    open(label)
    const root = await screen.findByTestId(section)
    for (const id of panels) expect(await within(root).findByTestId(id), id).toBeTruthy()
  })

  it('Rules & secrets sits in the Agents group (no one-item Safety group); Memory, Automations and Spending are gone from the sidebar', () => {
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={() => {}} onClose={() => {}} />)
    const nav = screen.getByRole('navigation', { name: 'Section settings' })
    expect(within(within(nav).getByRole('group', { name: 'Agents' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Claude', 'Central', 'Rules & secrets'])
    expect(within(nav).queryByRole('group', { name: 'Safety' })).toBeNull()
    for (const gone of ['Memory', 'Automations', 'Spending']) expect(within(nav).queryByRole('button', { name: gone })).toBeNull()
  })

  it('Developer (opened by link; the nav hides it outside developer mode) mounts its panels', async () => {
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={() => {}} onClose={() => {}} initialSection="developer" />)
    const root = await screen.findByTestId('developer-section')
    expect(await within(root).findByTestId('control-panel')).toBeTruthy()
  })

  it.each([['remember', 'Memory', 'memory'], ['routine', 'Automations', 'automations'], ['bill', 'Spending', 'spending']])(
    'searching "%s" finds %s and opens the Control tab, closing Settings', (query, label, tab) => {
      const onClose = vi.fn()
      let seen: ReturnType<typeof useCentralTabRequest> = null
      function Probe(): null { seen = useCentralTabRequest(); return null }
      render(<><SettingsPanel settings={DEFAULT_SETTINGS} onChange={() => {}} onClose={onClose} /><Probe /></>)
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: query } })
      const group = screen.getByRole('region', { name: 'Control panel' })
      expect(appNavigate()).toBeNull() // no router here: the side bar opens directly
      fireEvent.click(within(group).getByRole('button', { name: new RegExp(`› ${label}$`) }))
      expect(onClose).toHaveBeenCalled()
      expect(seen).toMatchObject({ tab })
      setSideBar({ open: false })
    })
})
