/** @vitest-environment jsdom */
// Settings › Account against a stubbed /auth/*: loading/error, rename (401, 409), password change
// (client checks, 401, success signs others out + reloads the list), sessions (this device, revoke one,
// revoke others, empty, error + Retry) and Sign out. Plus the UA / relative-time formatters.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_PASSWORD_PATH, AUTH_REVOKE_OTHERS_PATH, AUTH_SESSIONS_PATH, AUTH_USERNAME_PATH, authRevokePath, type AuthSession } from './account.api.client'
import { ACCOUNT_TEXT, browserLabel, relativeTime } from './accountLabels'
import { AccountSection } from './AccountSection'
import { AUTH_LOGOUT_PATH, AUTH_ME_PATH } from './transportToken'

const NOW = 1_800_000_000_000 // test-only
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'
const HERE: AuthSession = { id: 'aaaaaaaaaaaa', createdAt: NOW - 86_400_000, lastSeen: NOW - 30_000, ua: CHROME_MAC, current: true }
const OTHER: AuthSession = { id: 'bbbbbbbbbbbb', createdAt: NOW - 86_400_000 * 3, lastSeen: NOW - 7_200_000, ua: FIREFOX_LINUX, current: false }

type Reply = { status: number; body?: unknown }
let meReply: Reply
let sessions: AuthSession[] | 'fail'
let replies: Record<string, Reply>
let calls: { url: string; body?: string }[]

beforeEach(() => {
  meReply = { status: 200, body: { signedIn: true, setupRequired: false, user: { id: 1, username: 'ada' }, tokenSignIn: false } }
  sessions = [HERE, OTHER]
  replies = {}
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: init.body as string | undefined })
    if (url === AUTH_ME_PATH) return new Response(JSON.stringify(meReply.body), { status: meReply.status })
    if (url === AUTH_SESSIONS_PATH) {
      if (sessions === 'fail') return new Response(JSON.stringify({ error: 'not_signed_in' }), { status: 401 })
      return new Response(JSON.stringify({ items: sessions }), { status: 200 })
    }
    const r = replies[url] ?? { status: 404, body: { error: 'not_found' } }
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const type = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } })
const posted = (url: string) => calls.filter((c) => c.url === url).map((c) => (c.body ? JSON.parse(c.body) : null))
const form = (title: string) => screen.getByRole('form', { name: title })

async function mount() {
  const reload = vi.fn()
  render(<AccountSection reload={reload} now={() => NOW} />)
  expect(screen.getByRole('status').textContent).toBe(ACCOUNT_TEXT.loading)
  await flush()
  await flush()
  return reload
}

describe('AccountSection', () => {
  it('shows the username and the sessions, this device marked, with relative last-active times', async () => {
    await mount()
    expect(screen.getByTestId('account-username').textContent).toBe('ada')
    const rows = within(screen.getByRole('list', { name: ACCOUNT_TEXT.sessionsTitle })).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Chrome on macOS')
    expect(rows[0]!.textContent).toContain(ACCOUNT_TEXT.thisDevice)
    expect(rows[0]!.textContent).toContain(ACCOUNT_TEXT.lastActive('just now'))
    expect(rows[1]!.textContent).toContain('Firefox on Linux')
    expect(rows[1]!.textContent).toContain(ACCOUNT_TEXT.lastActive('2 hours ago'))
    expect(rows[1]!.textContent).not.toContain(ACCOUNT_TEXT.thisDevice)
  })

  it('a failed /auth/me shows the cause with Retry', async () => {
    meReply = { status: 500, body: {} }
    render(<AccountSection reload={vi.fn()} now={() => NOW} />)
    await flush()
    expect(screen.getByRole('alert').textContent).toContain('GET /auth/me -> 500')
    meReply = { status: 200, body: { signedIn: true, setupRequired: false, user: { id: 1, username: 'ada' }, tokenSignIn: false } }
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_TEXT.retry }))
    await flush()
    await flush()
    expect(screen.getByTestId('account-username').textContent).toBe('ada')
  })

  it('change username: 401 wrong password, 409 taken, then 200 shows the new name', async () => {
    await mount()
    type('account-new-username', 'grace')
    type('account-username-password', 'wrong')
    replies[AUTH_USERNAME_PATH] = { status: 401, body: { error: 'invalid_credentials' } }
    fireEvent.click(within(form(ACCOUNT_TEXT.usernameTitle)).getByRole('button', { name: ACCOUNT_TEXT.saveUsername }))
    await flush()
    expect(within(form(ACCOUNT_TEXT.usernameTitle)).getByRole('alert').textContent).toBe(ACCOUNT_TEXT.wrongPassword)
    replies[AUTH_USERNAME_PATH] = { status: 409, body: { error: 'username_taken' } }
    fireEvent.click(within(form(ACCOUNT_TEXT.usernameTitle)).getByRole('button', { name: ACCOUNT_TEXT.saveUsername }))
    await flush()
    expect(within(form(ACCOUNT_TEXT.usernameTitle)).getByRole('alert').textContent).toBe(ACCOUNT_TEXT.usernameTaken)
    replies[AUTH_USERNAME_PATH] = { status: 200, body: { user: { id: 1, username: 'grace' } } }
    type('account-username-password', 'correct horse battery')
    fireEvent.click(within(form(ACCOUNT_TEXT.usernameTitle)).getByRole('button', { name: ACCOUNT_TEXT.saveUsername }))
    await flush()
    expect(screen.getByTestId('account-username').textContent).toBe('grace')
    expect(screen.getByText(ACCOUNT_TEXT.usernameChanged)).toBeTruthy()
    expect(posted(AUTH_USERNAME_PATH).at(-1)).toEqual({ username: 'grace', password: 'correct horse battery' })
  })

  it('change password: short and mismatched are refused locally, 401 names the current password, 200 signs others out', async () => {
    await mount()
    const f = () => form(ACCOUNT_TEXT.passwordTitle)
    const submit = () => fireEvent.click(within(f()).getByRole('button', { name: ACCOUNT_TEXT.savePassword }))
    type('account-current-password', 'old password here')
    type('account-new-password', 'short')
    submit()
    await flush()
    expect(within(f()).getByRole('alert').textContent).toBe(ACCOUNT_TEXT.weakPassword)
    type('account-new-password', 'a brand new passphrase')
    type('account-confirm-password', 'something else')
    submit()
    await flush()
    expect(within(f()).getByRole('alert').textContent).toBe(ACCOUNT_TEXT.mismatch)
    expect(posted(AUTH_PASSWORD_PATH)).toEqual([])
    type('account-confirm-password', 'a brand new passphrase')
    replies[AUTH_PASSWORD_PATH] = { status: 401, body: { error: 'invalid_credentials' } }
    submit()
    await flush()
    expect(within(f()).getByRole('alert').textContent).toBe(ACCOUNT_TEXT.wrongCurrent)
    replies[AUTH_PASSWORD_PATH] = { status: 200, body: { ok: true } }
    const listsBefore = calls.filter((c) => c.url === AUTH_SESSIONS_PATH).length
    sessions = [HERE]
    submit()
    await flush()
    await flush()
    expect(screen.getByText(ACCOUNT_TEXT.passwordChanged)).toBeTruthy()
    expect(posted(AUTH_PASSWORD_PATH).at(-1)).toEqual({ current: 'old password here', next: 'a brand new passphrase' })
    expect(calls.filter((c) => c.url === AUTH_SESSIONS_PATH).length).toBe(listsBefore + 1) // the list reloads
    expect(within(screen.getByRole('list', { name: ACCOUNT_TEXT.sessionsTitle })).getAllByRole('listitem')).toHaveLength(1)
  })

  it('a 429 on a change counts down instead of a generic failure', async () => {
    await mount()
    type('account-new-username', 'grace')
    type('account-username-password', 'x')
    replies[AUTH_USERNAME_PATH] = { status: 429, body: { error: 'rate_limited' } }
    fireEvent.click(within(form(ACCOUNT_TEXT.usernameTitle)).getByRole('button', { name: ACCOUNT_TEXT.saveUsername }))
    await flush()
    expect(within(form(ACCOUNT_TEXT.usernameTitle)).getByRole('alert').textContent).toBe(ACCOUNT_TEXT.tooMany(1))
  })

  it('Sign out on another row revokes that session; "Sign out all other sessions" reports the count', async () => {
    await mount()
    replies[authRevokePath(OTHER.id)] = { status: 204 }
    sessions = [HERE]
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_TEXT.signOutRowLabel('Firefox on Linux') }))
    await flush()
    await flush()
    expect(calls.some((c) => c.url === authRevokePath(OTHER.id))).toBe(true)
    expect(within(screen.getByRole('list', { name: ACCOUNT_TEXT.sessionsTitle })).getAllByRole('listitem')).toHaveLength(1)
    expect((screen.getByRole('button', { name: ACCOUNT_TEXT.signOutOthers }) as HTMLButtonElement).disabled).toBe(true)

    sessions = [HERE, OTHER, { ...OTHER, id: 'cccccccccccc' }]
    cleanup()
    await mount()
    replies[AUTH_REVOKE_OTHERS_PATH] = { status: 200, body: { revoked: 2 } }
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_TEXT.signOutOthers }))
    await flush()
    expect(screen.getByText(ACCOUNT_TEXT.signedOutOthers(2))).toBeTruthy()
  })

  it('a row that already ended says so; the sessions error state has Retry', async () => {
    await mount()
    replies[authRevokePath(OTHER.id)] = { status: 404, body: { error: 'not_found' } }
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_TEXT.signOutRowLabel('Firefox on Linux') }))
    await flush()
    expect(screen.getByText(ACCOUNT_TEXT.rowGone)).toBeTruthy()
    cleanup()
    sessions = 'fail'
    await mount()
    expect(screen.getByRole('alert').textContent).toContain(ACCOUNT_TEXT.sessionsFailed(`GET ${AUTH_SESSIONS_PATH} -> 401 not_signed_in`))
    sessions = []
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_TEXT.retry }))
    await flush()
    expect(screen.getByText(ACCOUNT_TEXT.sessionsEmpty)).toBeTruthy()
  })

  it('Sign out is this device\'s row only (no second button); it posts /auth/logout and reloads, a refusal stays and says so', async () => {
    const reload = await mount()
    expect(screen.queryByRole('button', { name: ACCOUNT_TEXT.signOut })).toBeNull()
    replies[AUTH_LOGOUT_PATH] = { status: 500 }
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_TEXT.signOutRowLabel(`Chrome on macOS (${ACCOUNT_TEXT.thisDevice})`) }))
    await flush()
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('Signing out failed')
    replies[AUTH_LOGOUT_PATH] = { status: 204 }
    fireEvent.click(screen.getByRole('button', { name: ACCOUNT_TEXT.signOutRowLabel(`Chrome on macOS (${ACCOUNT_TEXT.thisDevice})`) }))
    await flush()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('account formatters', () => {
  it('names the browser and OS from a User-Agent', () => {
    expect(browserLabel(CHROME_MAC)).toBe('Chrome on macOS')
    expect(browserLabel(FIREFOX_LINUX)).toBe('Firefox on Linux')
    expect(browserLabel('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge on Windows')
    expect(browserLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1')).toBe('Safari on iOS')
    expect(browserLabel(null)).toBe('Unknown browser')
  })

  it('says how long ago', () => {
    expect(relativeTime(NOW - 5_000, NOW)).toBe('just now')
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago')
    expect(relativeTime(NOW - 86_400_000, NOW)).toBe('yesterday')
    expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe('3 days ago')
  })
})
