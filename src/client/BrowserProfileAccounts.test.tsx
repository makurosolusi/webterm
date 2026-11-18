/** @vitest-environment jsdom */
// Settings > Browser: the accounts line under each profile (states, empty, not live, Refresh with feedback, failure, switch off).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfileAccount } from '../shared/browser.accounts'
import { fakeBrowserServer, prof } from './browserProfile.fake'
import type { FakeServer } from './browserProfile.fake'
import { resetBrowserStatusCache } from './browser.feature'
import { BrowserProfilesSection } from './BrowserProfilesSection'

// test-only accounts
const NOW = Date.now()
const google = (over: Partial<ProfileAccount> = {}): ProfileAccount => ({ provider: 'google', state: 'signed_in', displayName: 'Test Person', emailMasked: 't***@gmail.com', checkedAt: NOW - 5 * 60_000, ...over })

let server: FakeServer
beforeEach(() => {
  resetBrowserStatusCache()
  server = fakeBrowserServer([
    prof('w1', 'Default (Main)', { isDefaultOf: 'w1', live: true, accounts: [google(), { provider: 'github', state: 'signed_out', checkedAt: NOW }] }),
    prof('bp-admin', 'Admin', { color: 'red', live: true }),
    prof('bp-cold', 'Cold', { accounts: [google({ state: 'expired' })] }),
  ])
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const block = async (name: string): Promise<HTMLElement> => {
  const li = (await screen.findByText(name)).closest('li') as HTMLElement
  return li.querySelector('[data-profile-accounts]') as HTMLElement
}

describe('Settings accounts line', () => {
  it('shows provider, name, masked email, state and age; a signed-out provider is not listed', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    const b = await block('Default (Main)')
    const row = b.querySelector('[data-account="google"]') as HTMLElement
    expect(row.textContent).toContain('Google · Test Person')
    expect(row.textContent).toContain('t***@gmail.com')
    expect(row.textContent).toContain('checked 5 min ago')
    expect(b.querySelector('[data-account="github"]')).toBeNull()
  })
  it('says "No accounts detected" for an unchecked profile, and why when its browser is not running', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    expect((await block('Admin')).textContent).toContain('No accounts detected')
    cleanup()
    server.profiles = [prof('bp-cold2', 'Cold two')]
    render(<BrowserProfilesSection workspaceId="w1" />)
    const b = await block('Cold two')
    expect(b.textContent).toContain('checked while a browser runs')
    expect(within(b).queryByRole('button', { name: /Refresh accounts/ })).toBeNull()
  })
  it('lists an expired session', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    expect((await block('Cold')).querySelector('[data-account="google"]')?.getAttribute('data-state')).toBe('expired')
  })
  it('Refresh forces a check, shows busy and then the result line', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    const b = await block('Admin')
    server.refreshed = [google({ checkedAt: Date.now() })]
    fireEvent.click(within(b).getByRole('button', { name: /Refresh accounts/ }))
    await waitFor(() => expect(server.calls).toContain('POST /api/browser/profiles/bp-admin/accounts/refresh'))
    await waitFor(() => expect(b.querySelector('[data-action-result="ok"]')?.textContent).toContain('1 signed in'))
    expect(b.querySelector('[data-account="google"]')?.textContent).toContain('Test Person')
  })
  it('a failed refresh says so with the cause', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    const b = await block('Admin')
    server.fail['POST /api/browser/profiles/bp-admin/accounts/refresh'] = { status: 500, error: 'boom' }
    fireEvent.click(within(b).getByRole('button', { name: /Refresh accounts/ }))
    await waitFor(() => expect(b.querySelector('[data-action-result="failed"]')?.textContent).toContain('Could not check accounts'))
  })
  it('is hidden entirely when the switch is off', async () => {
    server.accountsEnabled = false
    render(<BrowserProfilesSection workspaceId="w1" />)
    await screen.findByText('Admin')
    expect(document.querySelector('[data-profile-accounts]')).toBeNull()
  })
})
