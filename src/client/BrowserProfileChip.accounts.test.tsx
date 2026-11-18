/** @vitest-environment jsdom */
// Header chip + accounts: the green dot, the tooltip summary, the "Accounts in this profile" section of the menu
// (signed in / expired / unknown / not signed in / none / checking / failed) and Refresh.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfileAccount } from '../shared/browser.accounts'
import { fakeBrowserServer, prof } from './browserProfile.fake'
import type { FakeServer } from './browserProfile.fake'

vi.mock('@xyflow/react', () => ({ useReactFlow: () => ({ updateNodeData: vi.fn() }) }))
const notices = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('./workspaceSave.notice', () => ({ showNotice: notices.show }))
vi.mock('./settings.link', () => ({ openSettingsAt: vi.fn() }))
vi.mock('./activeWorkspace.context', () => ({ useActiveWorkspaceId: () => 'w1' }))

import BrowserProfileChip from './BrowserProfileChip'

// test-only accounts
const NOW = Date.now()
const google = (over: Partial<ProfileAccount> = {}): ProfileAccount => ({ provider: 'google', state: 'signed_in', displayName: 'Test Person', emailMasked: 't***@gmail.com', checkedAt: NOW, ...over })
const github = (over: Partial<ProfileAccount> = {}): ProfileAccount => ({ provider: 'github', state: 'signed_out', checkedAt: NOW, ...over })

let server: FakeServer
const setup = (accounts?: ProfileAccount[], enabled = true) => {
  server = fakeBrowserServer([prof('w1', 'Default (Main)', { isDefaultOf: 'w1', live: true, nodeCount: 1, ...(accounts ? { accounts } : {}) })])
  server.accountsEnabled = enabled
  server.refreshed = accounts ?? []
}
beforeEach(() => { notices.show.mockReset() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const chip = () => screen.findByRole('button', { name: /Browser profile: / })
const open = async () => {
  render(<BrowserProfileChip nodeId="n1" />)
  fireEvent.click(await chip())
  return screen.findByRole('menu', { name: 'Browser profiles' })
}

describe('chip indicator', () => {
  it('shows a green dot and says Signed in when an account is signed in', async () => {
    setup([google(), github()])
    render(<BrowserProfileChip nodeId="n1" />)
    const c = await chip()
    await waitFor(() => expect(c.querySelector('[data-accounts-dot]')).not.toBeNull())
    expect(c.getAttribute('aria-label')).toContain('Signed in')
  })
  it('has no dot when nobody is signed in', async () => {
    setup([google({ state: 'signed_out' }), github()])
    render(<BrowserProfileChip nodeId="n1" />)
    const c = await chip()
    expect(c.querySelector('[data-accounts-dot]')).toBeNull()
  })
  it('shows neither dot nor accounts when the switch is off, and never calls the refresh route', async () => {
    setup([google()], false)
    await open()
    expect((await chip()).querySelector('[data-accounts-dot]')).toBeNull()
    expect(screen.queryByText('Accounts in this profile')).toBeNull()
    expect(server.calls.some((c) => c.includes('/accounts/refresh'))).toBe(false)
  })
})

describe('menu section', () => {
  it('lists a signed-in account with name and masked email; signed-out providers stay out of the way', async () => {
    setup([google(), github()])
    await open()
    const row = await screen.findByRole('menuitem', { name: /Google · Test Person/ })
    expect(row.textContent).toContain('t***@gmail.com')
    expect(row.getAttribute('title')).toContain('Signed in · checked just now')
    expect(screen.queryByRole('menuitem', { name: /GitHub/ })).toBeNull()
  })
  it('says "Session expired" and "Unknown" with a reason', async () => {
    setup([google({ state: 'expired' }), github({ state: 'unknown' })])
    await open()
    expect(await screen.findByRole('menuitem', { name: /Google · Session expired/ })).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: /GitHub · Unknown/ }).getAttribute('title')).toContain('try again later')
  })
  it('says "Not signed in" when every provider is signed out, "No accounts detected" when nothing is known', async () => {
    setup([google({ state: 'signed_out' }), github()])
    await open()
    expect(await screen.findByRole('menuitem', { name: 'Not signed in' })).not.toBeNull()
    cleanup()
    setup(undefined)
    await open()
    expect(await screen.findByRole('menuitem', { name: 'No accounts detected' })).not.toBeNull()
  })
  it('checks once when it opens on nothing known (popover keeps the TTL) and shows what came back', async () => {
    setup(undefined)
    server.refreshed = [google(), github()]
    await open()
    await waitFor(() => expect(server.calls).toContain('POST /api/browser/profiles/w1/accounts/refresh?popover=1'))
    expect(await screen.findByRole('menuitem', { name: /Google · Test Person/ })).not.toBeNull()
  })
  it('does not re-check fresh data when the menu opens', async () => {
    setup([google(), github()])
    await open()
    await screen.findByRole('menuitem', { name: /Google · Test Person/ })
    expect(server.calls.some((c) => c.includes('/accounts/refresh'))).toBe(false)
  })
  it('Refresh accounts forces a check (no popover flag) and tells the result in one notice', async () => {
    setup([google(), github()])
    await open()
    server.refreshed = [google(), github()]
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Refresh accounts' }))
    await waitFor(() => expect(server.calls).toContain('POST /api/browser/profiles/w1/accounts/refresh'))
    await waitFor(() => expect(notices.show).toHaveBeenCalledTimes(1))
    expect(notices.show.mock.calls[0][1]).toMatchObject({ severity: 'info', title: '1 signed in' })
  })
  it('a failed Refresh is an error notice with Retry that checks again', async () => {
    setup([google(), github()])
    await open()
    server.fail['POST /api/browser/profiles/w1/accounts/refresh'] = { status: 500, error: 'boom' }
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Refresh accounts' }))
    await waitFor(() => expect(notices.show).toHaveBeenCalledTimes(1))
    const notice = notices.show.mock.calls[0][1] as { severity: string; title: string; actions: Array<{ label: string; onClick: () => void }> }
    expect(notice).toMatchObject({ severity: 'error', title: 'Accounts could not be checked.' })
    expect(notice.actions[0].label).toBe('Retry')
    delete server.fail['POST /api/browser/profiles/w1/accounts/refresh']
    notice.actions[0].onClick()
    await waitFor(() => expect(notices.show).toHaveBeenCalledTimes(2))
    expect(notices.show.mock.calls[1][1]).toMatchObject({ severity: 'info' })
  })
  it('never puts a full email address into the page', async () => {
    setup([google(), github()])
    await open()
    await screen.findByRole('menuitem', { name: /Google · Test Person/ })
    expect(document.body.innerHTML).not.toMatch(/test\.person|@gmail\.com[^"]*"[^>]*>[^<]*test/i)
  })
})
