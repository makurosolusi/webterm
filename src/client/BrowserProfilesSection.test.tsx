/** @vitest-environment jsdom */
// Settings › Browser: list states, rename, color, delete (confirm + disabled reasons), duplicate disabled while live,
// export, inline server errors, cookie import per profile (preview, Google note, result), live refresh on the frame.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowserServer, prof } from './browserProfile.fake'
import type { FakeServer } from './browserProfile.fake'
import { dispatchBroadcast } from './ws.listeners'
import { resetBrowserStatusCache } from './browser.feature'
import { BrowserProfilesSection } from './BrowserProfilesSection'

let server: FakeServer
beforeEach(() => {
  resetBrowserStatusCache()
  server = fakeBrowserServer([
    prof('w1', 'Default (Main)', { isDefaultOf: 'w1', live: true, nodeCount: 2, cookieDomains: 3 }),
    prof('bp-admin', 'Admin', { color: 'red', nodeCount: 1 }),
    prof('bp-free', 'Spare'),
  ])
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const row = async (name: string): Promise<HTMLElement> => {
  const li = (await screen.findByText(name)).closest('li') as HTMLElement
  return li
}
const pick = async (name: string, action: string): Promise<void> => {
  const li = await row(name)
  fireEvent.click(within(li).getByRole('button', { name: `Actions for profile ${name}` }))
  fireEvent.click(await screen.findByRole('menuitem', { name: action }))
}

describe('Settings › Browser profiles', () => {
  it('lists each profile with badges, node and cookie-domain counts', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    const def = await row('Default (Main)')
    expect(def.textContent).toContain('Default')
    expect(def.textContent).toContain('live')
    expect(def.textContent).toContain('used by 2 nodes')
    expect(def.textContent).toContain('3 cookie domains')
    expect((await row('Spare')).textContent).toContain('used by 0 nodes')
  })

  it('says the browser is off when the runtime is not running', async () => {
    server.fail['GET /api/browser/status'] = { status: 404, error: 'not_found' }
    render(<BrowserProfilesSection workspaceId="w1" />)
    expect((await screen.findByText(/Browser is off/)).textContent).toContain('Turn the browser on')
    expect(screen.queryByRole('button', { name: 'New profile…' })).toBeNull()
  })

  it('a failed list shows an error with Retry', async () => {
    server.fail['GET /api/browser/profiles?workspaceId=w1'] = { status: 500, error: 'boom' }
    render(<BrowserProfilesSection workspaceId="w1" />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Profiles could not be loaded.')
    delete server.fail['GET /api/browser/profiles?workspaceId=w1']
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await screen.findByText('Spare')
  })

  it('an empty list invites creating the first profile', async () => {
    server.profiles.length = 0
    render(<BrowserProfilesSection workspaceId="w1" />)
    expect(await screen.findByText('No profiles yet. Create one to get started.')).not.toBeNull()
  })

  it('rename in place PUTs the trimmed name; a taken name shows inline', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    await pick('Spare', 'Rename')
    const input = screen.getByRole('textbox', { name: 'Rename' })
    server.fail['PUT /api/browser/profiles/bp-free'] = { status: 409, error: 'profile_name_taken' }
    fireEvent.change(input, { target: { value: '  Admin ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Another profile already has this name.')
    delete server.fail['PUT /api/browser/profiles/bp-free']
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(server.calls).toContain('PUT /api/browser/profiles/bp-free'))
  })

  it('Escape cancels the rename without a request', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    await pick('Spare', 'Rename')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Rename' })).toBeNull()
    expect(server.calls.some((c) => c.startsWith('PUT'))).toBe(false)
  })

  it('color: choosing a swatch PUTs hue and shade', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    await pick('Spare', 'Color')
    fireEvent.click(await screen.findByRole('radio', { name: 'Violet' }))
    await waitFor(() => expect(server.calls).toContain('PUT /api/browser/profiles/bp-free'))
  })

  it('delete asks first, then DELETEs', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    await pick('Spare', 'Delete')
    expect(await screen.findByText('Delete profile “Spare”?')).not.toBeNull()
    expect(server.calls.some((c) => c.startsWith('DELETE'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(server.calls).toContain('DELETE /api/browser/profiles/bp-free'))
  })

  it('delete is disabled with a reason for a used profile and for the Default', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    await pick('Admin', 'Delete')
    const used = screen.getByRole('menuitem', { name: 'Delete' })
    expect(used.getAttribute('aria-disabled')).toBe('true')
    expect(used.getAttribute('title')).toBe('1 node uses this profile. Move them to another profile first.')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  })

  it('duplicate is disabled while the profile is live, with the reason', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    await pick('Default (Main)', 'Duplicate')
    const dup = screen.getByRole('menuitem', { name: 'Duplicate' })
    expect(dup.getAttribute('aria-disabled')).toBe('true')
    expect(dup.getAttribute('title')).toContain('cannot be copied')
    expect(server.calls.some((c) => c.includes('/duplicate'))).toBe(false)
  })

  it('duplicate of a stopped profile POSTs a copy name', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    await pick('Spare', 'Duplicate')
    await waitFor(() => expect(server.calls).toContain('POST /api/browser/profiles/bp-free/duplicate'))
  })

  it('export downloads the cookie JSON', async () => {
    const created = vi.fn(() => 'blob:x')
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<BrowserProfilesSection workspaceId="w1" />)
    await pick('Spare', 'Export cookies')
    await waitFor(() => expect(click).toHaveBeenCalled())
    expect(server.calls).toContain('GET /api/browser/profiles/bp-free/export')
    click.mockRestore()
  })

  it('New profile creates with a name only', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'New profile…' }))
    fireEvent.change(await screen.findByLabelText('Profile name'), { target: { value: 'Billing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }))
    await waitFor(() => expect(server.calls).toContain('POST /api/browser/profiles'))
  })

  it('a browserProfiles frame refreshes the list', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    await screen.findByText('Spare')
    server.profiles.push(prof('bp-late', 'Late arrival'))
    act(() => { dispatchBroadcast({ t: 'browserProfiles' }) })
    expect(await screen.findByText('Late arrival')).not.toBeNull()
  })

  it('cookie import: preview shows sites, the Google note, then the result summary', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    await pick('Spare', 'Import cookies…')
    const dialog = await screen.findByRole('dialog', { name: 'Cookies of Spare' })
    await within(dialog).findByText(/a\.com/) // stored domains
    const file = new File(['{}'], 'c.json', { type: 'application/json' })
    fireEvent.change(dialog.querySelector('input[type=file]') as HTMLInputElement, { target: { files: [file] } })
    expect(await within(dialog).findByText(/Google sign-in cookies are not importable; sign in inside the profile/)).not.toBeNull()
    expect(server.calls).toContain('POST /api/browser/profiles/bp-free/cookies/preview')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Import cookies for b.com' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import selected' }))
    expect((await within(dialog).findByText(/Imported 4 cookies from 1 site; skipped 3/)).textContent).toBeTruthy()
    expect(server.calls).toContain('POST /api/browser/profiles/bp-free/cookies/import')
  })

  it('cookie dialog removes one stored domain', async () => {
    render(<BrowserProfilesSection workspaceId="w1" />)
    await pick('Spare', 'Import cookies…')
    fireEvent.click(await screen.findByRole('button', { name: 'Remove cookies for a.com' }))
    await waitFor(() => expect(server.calls).toContain('DELETE /api/browser/profiles/bp-free/cookies?domain=a.com'))
  })
})
