/** @vitest-environment jsdom */
// Header chip: current profile, menu (checkmark, live badge, node count), switch -> POST + node data + notice,
// failed switch leaves the node untouched with Retry, New profile…, Manage profiles….
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowserServer, prof } from './browserProfile.fake'
import type { FakeServer } from './browserProfile.fake'

const rf = vi.hoisted(() => ({ updateNodeData: vi.fn() }))
vi.mock('@xyflow/react', () => ({ useReactFlow: () => rf }))
const notices = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('./workspaceSave.notice', () => ({ showNotice: notices.show }))
const settings = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('./settings.link', () => ({ openSettingsAt: settings.open }))
vi.mock('./activeWorkspace.context', () => ({ useActiveWorkspaceId: () => 'w1' }))

import BrowserProfileChip from './BrowserProfileChip'

let server: FakeServer
beforeEach(() => {
  rf.updateNodeData.mockReset(); notices.show.mockReset(); settings.open.mockReset()
  server = fakeBrowserServer([
    prof('w1', 'Default (Main)', { isDefaultOf: 'w1', live: true, nodeCount: 2 }),
    prof('bp-admin', 'Admin', { color: 'red', nodeCount: 1 }),
  ])
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const openMenu = async (profileId?: string) => {
  render(<BrowserProfileChip nodeId="n1" profileId={profileId} />)
  const chip = await screen.findByRole('button', { name: /Browser profile: / })
  fireEvent.click(chip)
  return screen.findByRole('menu', { name: 'Browser profiles' })
}

describe('BrowserProfileChip', () => {
  it('shows the current profile name, node count and the shared-session tooltip text', async () => {
    render(<BrowserProfileChip nodeId="n1" />)
    const chip = await screen.findByRole('button', { name: 'Browser profile: Default (Main). Change profile' })
    expect(chip.querySelector('[data-profile-dot]')).not.toBeNull()
    expect(chip.querySelector('[data-profile-nodes]')?.textContent).toBe('2')
  })

  it('lists profiles with a checkmark on the current one and live/node hints', async () => {
    await openMenu()
    const current = screen.getByRole('menuitemcheckbox', { name: /Default \(Main\)/ })
    expect(current.getAttribute('aria-checked')).toBe('true')
    expect(current.textContent).toContain('live')
    expect(screen.getByRole('menuitemcheckbox', { name: /Admin/ })).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: 'New profile…' })).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Manage profiles…' })).not.toBeNull()
  })

  it('picking another profile POSTs, stores profileId on the node and notifies once', async () => {
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Admin/ }))
    await waitFor(() => expect(rf.updateNodeData).toHaveBeenCalledWith('n1', { profileId: 'bp-admin' }))
    expect(server.calls).toContain('POST /api/browser/n1/profile')
    expect(notices.show).toHaveBeenCalledTimes(1)
    expect(notices.show.mock.calls[0][1]).toMatchObject({ severity: 'info', title: 'Moved to profile Admin; page reloaded' })
  })

  it('moving to the board Default clears profileId on the node', async () => {
    await openMenu('bp-admin')
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Default \(Main\)/ }))
    await waitFor(() => expect(rf.updateNodeData).toHaveBeenCalledWith('n1', { profileId: undefined }))
  })

  it('a refused move leaves the node as it was and offers Retry', async () => {
    server.fail['POST /api/browser/n1/profile'] = { status: 404, error: 'profile_not_found' }
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Admin/ }))
    await waitFor(() => expect(notices.show).toHaveBeenCalled())
    expect(rf.updateNodeData).not.toHaveBeenCalled()
    const notice = notices.show.mock.calls[0][1] as { severity: string; title: string; actions: { label: string; onClick: () => void }[] }
    expect(notice.severity).toBe('error')
    expect(notice.title).toContain('That profile no longer exists.')
    delete server.fail['POST /api/browser/n1/profile']
    notice.actions[0].onClick()
    await waitFor(() => expect(rf.updateNodeData).toHaveBeenCalledWith('n1', { profileId: 'bp-admin' }))
  })

  it('"Manage profiles…" opens Settings > Browser', async () => {
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage profiles…' }))
    expect(settings.open).toHaveBeenCalledWith('browser', 'browser-profiles')
  })

  it('"New profile…" creates then switches the node; a taken name shows inline', async () => {
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'New profile…' }))
    const name = await screen.findByLabelText('Profile name')
    fireEvent.change(name, { target: { value: 'Created' } })
    server.fail['POST /api/browser/profiles'] = { status: 409, error: 'profile_name_taken' }
    fireEvent.click(screen.getByRole('button', { name: 'Create and switch' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Another profile already has this name.')
    delete server.fail['POST /api/browser/profiles']
    fireEvent.click(screen.getByRole('button', { name: 'Create and switch' }))
    await waitFor(() => expect(server.calls).toContain('POST /api/browser/profiles'))
    await waitFor(() => expect(rf.updateNodeData).toHaveBeenCalledWith('n1', { profileId: 'bp-new' }))
  })

  it('"Create" stays disabled until the name is valid', async () => {
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'New profile…' }))
    expect((await screen.findByRole('button', { name: 'Create and switch' })).hasAttribute('disabled')).toBe(true)
  })
})
