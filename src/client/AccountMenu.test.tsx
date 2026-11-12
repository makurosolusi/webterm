/** @vitest-environment jsdom */
// Title-bar account menu: header with the username (loading, failed), Account settings, Settings,
// Keyboard Shortcuts, and Sign out with busy and failure states; the no-account variant.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountMenu, ACCOUNT_MENU_TEXT, type AccountMenuProps } from './AccountMenu'
import { ACCOUNT_TEXT } from './accountLabels'
import { fetchMe, logout } from './transportToken'

vi.mock('./transportToken', () => ({ fetchMe: vi.fn(), logout: vi.fn() }))
const me = vi.mocked(fetchMe)
const out = vi.mocked(logout)

beforeEach(() => {
  me.mockReset().mockResolvedValue({ signedIn: true, setupRequired: false, user: { id: 1, username: 'ada' }, tokenSignIn: false }) // test-only
  out.mockReset()
})
afterEach(cleanup)

function openMenu(over: Partial<AccountMenuProps> = {}) {
  const props = { onOpenAccount: vi.fn(), onOpenSettings: vi.fn(), onOpenHelp: vi.fn(), reload: vi.fn(), ...over }
  render(<AccountMenu {...props} />)
  const trigger = screen.getByRole('button', { name: ACCOUNT_MENU_TEXT.button })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
  return props
}
const item = (name: string) => screen.getByRole('menuitem', { name })

describe('AccountMenu', () => {
  it('a click opens the menu with who is signed in (placeholder while loading)', async () => {
    openMenu()
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByText(ACCOUNT_MENU_TEXT.loading)).toBeTruthy()
    expect(await screen.findByText('Signed in as ada')).toBeTruthy()
    for (const n of [ACCOUNT_MENU_TEXT.accountSettings, ACCOUNT_MENU_TEXT.settings, ACCOUNT_MENU_TEXT.shortcuts, ACCOUNT_MENU_TEXT.signOut]) expect(item(n)).toBeTruthy()
  })

  it('Escape closes it', async () => {
    openMenu()
    await screen.findByText('Signed in as ada')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('Account settings opens Settings › Account; Settings and Keyboard Shortcuts call theirs', async () => {
    const p = openMenu()
    fireEvent.click(item(ACCOUNT_MENU_TEXT.accountSettings))
    expect(p.onOpenAccount).toHaveBeenCalledTimes(1)
    expect(p.onOpenSettings).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    fireEvent.pointerDown(screen.getByRole('button', { name: ACCOUNT_MENU_TEXT.button }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(item(ACCOUNT_MENU_TEXT.shortcuts))
    expect(p.onOpenHelp).toHaveBeenCalledTimes(1)
  })

  it('a failed account fetch says so in the header; the menu still works', async () => {
    me.mockRejectedValue(new Error('GET /auth/me -> 500'))
    const p = openMenu()
    expect(await screen.findByText(ACCOUNT_TEXT.loadFailed('GET /auth/me -> 500'))).toBeTruthy()
    fireEvent.click(item(ACCOUNT_MENU_TEXT.settings))
    expect(p.onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('Sign out calls logout, shows busy, and reloads on success', async () => {
    let done!: () => void
    out.mockReturnValue(new Promise<void>((r) => { done = r }))
    const p = openMenu()
    fireEvent.click(item(ACCOUNT_MENU_TEXT.signOut))
    expect(out).toHaveBeenCalledTimes(1)
    const busy = item(ACCOUNT_MENU_TEXT.signingOut)
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    expect(p.reload).not.toHaveBeenCalled()
    done()
    await waitFor(() => expect(p.reload).toHaveBeenCalledTimes(1))
  })

  it('a refused Sign out stays open, shows the error and can be retried', async () => {
    out.mockRejectedValue(new Error('POST /auth/logout -> 503'))
    const p = openMenu()
    fireEvent.click(item(ACCOUNT_MENU_TEXT.signOut))
    expect((await screen.findByRole('alert')).textContent).toBe(ACCOUNT_TEXT.failed('Signing out', 'POST /auth/logout -> 503'))
    expect(p.reload).not.toHaveBeenCalled()
    expect(item(ACCOUNT_MENU_TEXT.signOut).getAttribute('aria-disabled')).toBeNull()
  })

  it('without an account system: Settings, Keyboard Shortcuts and Sign out only, no account fetch', () => {
    openMenu({ onOpenAccount: undefined })
    expect(screen.queryByRole('menuitem', { name: ACCOUNT_MENU_TEXT.accountSettings })).toBeNull()
    expect(screen.queryByText(ACCOUNT_MENU_TEXT.loading)).toBeNull()
    expect(screen.getAllByRole('menuitem').map((e) => e.textContent)).toEqual([ACCOUNT_MENU_TEXT.settings, ACCOUNT_MENU_TEXT.shortcuts, ACCOUNT_MENU_TEXT.signOut])
    expect(me).not.toHaveBeenCalled()
  })
})
