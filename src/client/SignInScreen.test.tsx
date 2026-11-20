/** @vitest-environment jsdom */
// Every SignInScreen mode against a stubbed /auth/* (transportToken.ts, account.api.client.ts):
// loading, sign-in (401, 429 countdown), first-run setup (inline checks: signIn/authForms.test.tsx) with and without proof (403, 400, 409),
// opening a window (next = the current path), polling, error + Retry, signed in -> exactly one reload.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SignInScreen, { SIGN_IN_POLL_MS, SIGN_IN_TEXT } from './SignInScreen'
import { AUTH_SETUP_PATH } from './account.api.client'
import { AUTH_LOGIN_PATH, AUTH_ME_PATH, AUTH_REQUEST_OPEN_PATH } from './transportToken'

type Reply = { status: number; body?: unknown; retryAfter?: string }
let me: boolean | 'fail' = false
let setupRequired = false
let openReply: { status: number; retryAfter?: string } | 'fail' = { status: 202 }
let loginReply: Reply = { status: 200, body: { user: { id: 1, username: 'ada' } } }
let setupReply: Reply = { status: 201, body: { user: { id: 1, username: 'ada' } } }
let calls: { url: string; init?: RequestInit }[] = []
let hidden = false
let meDelayMs = 0

const json = (r: Reply) => new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.retryAfter ? { 'Retry-After': r.retryAfter } : {} })

beforeEach(() => {
  vi.useFakeTimers()
  me = false; setupRequired = false; openReply = { status: 202 }; calls = []; hidden = false; meDelayMs = 0
  loginReply = { status: 200, body: { user: { id: 1, username: 'ada' } } }
  setupReply = { status: 201, body: { user: { id: 1, username: 'ada' } } }
  history.replaceState(null, '', '/')
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (hidden ? 'hidden' : 'visible'))
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url === AUTH_ME_PATH) {
      if (meDelayMs) await new Promise((r) => setTimeout(r, meDelayMs))
      if (me === 'fail') throw new TypeError('network down')
      return new Response(JSON.stringify({ signedIn: me, setupRequired, user: null, tokenSignIn: setupRequired }), { status: 200 })
    }
    if (url === AUTH_REQUEST_OPEN_PATH) {
      if (openReply === 'fail') throw new TypeError('network down')
      const headers: Record<string, string> = openReply.retryAfter ? { 'Retry-After': openReply.retryAfter } : {}
      return new Response('{}', { status: openReply.status, headers })
    }
    if (url === AUTH_LOGIN_PATH) return json(loginReply)
    if (url === AUTH_SETUP_PATH) return json(setupReply)
    return new Response(null, { status: 404 })
  }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  cleanup() // unmount: a live earlier screen would keep polling into the next case
})

const flush = () => act(() => vi.advanceTimersByTimeAsync(0))
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const meCalls = () => calls.filter((c) => c.url === AUTH_ME_PATH).length
const bodiesOf = (url: string) => calls.filter((c) => c.url === url).map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>)
const type = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } })
const alertText = () => screen.getByRole('alert').textContent

async function mount(now?: () => number) {
  const reload = vi.fn()
  render(<SignInScreen reload={reload} now={now} />)
  expect(screen.getByRole('status').textContent).toBe(SIGN_IN_TEXT.loading)
  await flush()
  return reload
}

describe('SignInScreen', () => {
  it('signed out: username + password and the local window are offered, no token field; polling flips to signed in and reloads once', async () => {
    const reload = await mount()
    expect(screen.getByRole('button', { name: SIGN_IN_TEXT.open })).toBeDefined()
    expect((screen.getByLabelText(SIGN_IN_TEXT.usernameLabel) as HTMLInputElement).autocomplete).toBe('username')
    expect((screen.getByLabelText(SIGN_IN_TEXT.passwordLabel) as HTMLInputElement).autocomplete).toBe('current-password')
    expect(screen.queryByLabelText(/token/i)).toBeNull()
    await advance(SIGN_IN_POLL_MS)
    expect(reload).not.toHaveBeenCalled()
    me = true
    await advance(SIGN_IN_POLL_MS)
    expect(screen.getByRole('status').textContent).toBe(SIGN_IN_TEXT.signedIn)
    await advance(SIGN_IN_POLL_MS * 3)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('the default props are stable: one /auth/me at mount, no render loop', async () => {
    render(<SignInScreen />)
    await flush()
    await flush()
    expect(meCalls()).toBe(1)
    expect(screen.getByRole('button', { name: SIGN_IN_TEXT.open })).toBeDefined()
  })

  it('two slow polls answering signed in still reload only once', async () => {
    const reload = await mount()
    me = true
    meDelayMs = SIGN_IN_POLL_MS * 1.5 // the second poll starts before the first answers
    await advance(SIGN_IN_POLL_MS * 5)
    expect(meCalls()).toBeGreaterThanOrEqual(3)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('polls only while the tab is visible, and checks at once when it comes back', async () => {
    const reload = await mount()
    hidden = true
    const before = meCalls()
    await advance(SIGN_IN_POLL_MS * 3)
    expect(meCalls()).toBe(before)
    hidden = false
    me = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(meCalls()).toBe(before + 1) // back in front: checked at once, not on the next tick
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('an unreachable server shows a hint but keeps polling', async () => {
    await mount()
    me = 'fail'
    await advance(SIGN_IN_POLL_MS)
    expect(screen.getByText(SIGN_IN_TEXT.offline)).toBeDefined()
    me = false
    await advance(SIGN_IN_POLL_MS)
    expect(screen.queryByText(SIGN_IN_TEXT.offline)).toBeNull()
  })

  it('already signed in at mount: error + Retry, never an automatic reload loop', async () => {
    me = true
    const reload = await mount()
    expect(screen.getByRole('alert').textContent).toContain(SIGN_IN_TEXT.stillRefused)
    await advance(SIGN_IN_POLL_MS * 3)
    expect(reload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.retry }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a failed first check shows the cause with a Retry that checks again', async () => {
    me = 'fail'
    await mount()
    expect(screen.getByRole('alert').textContent).toContain('network down')
    me = false
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.retry }))
    await flush()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: SIGN_IN_TEXT.open })).toBeDefined()
  })

  it('Open signed-in window: 202 shows progress; 429 counts down Retry-After with the button disabled', async () => {
    let clock = 1_000_000
    await mount(() => clock)
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.open }))
    await flush()
    expect(screen.getByText(SIGN_IN_TEXT.opening)).toBeDefined()
    openReply = { status: 429, retryAfter: '3' }
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.open }))
    await flush()
    expect(screen.getByText(SIGN_IN_TEXT.rateLimited(3))).toBeDefined()
    expect((screen.getByRole('button', { name: SIGN_IN_TEXT.open }) as HTMLButtonElement).disabled).toBe(true)
    clock += 1000
    await advance(1000)
    expect(screen.getByText(SIGN_IN_TEXT.rateLimited(2))).toBeDefined()
    clock += 2000
    await advance(1000)
    expect(screen.queryByText(/ask again/)).toBeNull()
    expect((screen.getByRole('button', { name: SIGN_IN_TEXT.open }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('Open signed-in window failing shows the cause, and Retry asks again', async () => {
    await mount()
    openReply = 'fail'
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.open }))
    await flush()
    expect(screen.getByRole('alert').textContent).toContain('Opening a signed-in window failed: network down')
    openReply = { status: 202 }
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.retry }))
    await flush()
    expect(screen.getByText(SIGN_IN_TEXT.opening)).toBeDefined()
    expect(bodiesOf(AUTH_REQUEST_OPEN_PATH).map((b) => b.next)).toEqual(['/', '/'])
    expect(calls.filter((c) => c.url === AUTH_REQUEST_OPEN_PATH)).toHaveLength(2)
  })

  it('keeps the requested URL: request-open lands on the current path + query, sign-in reloads in place', async () => {
    history.replaceState(null, '', '/w/ws-1?settings=account')
    const reload = await mount()
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.open }))
    await flush()
    expect(bodiesOf(AUTH_REQUEST_OPEN_PATH)).toEqual([{ next: '/w/ws-1?settings=account' }])
    type('signin-username', 'ada')
    type('signin-password', 'correct horse battery')
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.signIn }))
    await flush()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(location.pathname + location.search).toBe('/w/ws-1?settings=account')
  })

  it('sign-in: 401 says wrong username or password; 200 reloads once with the typed credentials', async () => {
    const reload = await mount()
    type('signin-username', ' ada ')
    type('signin-password', 'nope')
    loginReply = { status: 401, body: { error: 'invalid_credentials' } }
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.signIn }))
    await flush()
    expect(alertText()).toBe(SIGN_IN_TEXT.wrongCredentials)
    expect(reload).not.toHaveBeenCalled()
    loginReply = { status: 200, body: { user: { id: 1, username: 'ada' } } }
    type('signin-password', 'correct horse battery')
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.signIn }))
    await flush()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(bodiesOf(AUTH_LOGIN_PATH)).toEqual([{ username: 'ada', password: 'nope' }, { username: 'ada', password: 'correct horse battery' }])
  })

  it('sign-in: 429 counts down from Retry-After with the button disabled, then lets the user try again', async () => {
    let clock = 5_000_000
    await mount(() => clock)
    type('signin-username', 'ada')
    type('signin-password', 'nope')
    loginReply = { status: 429, body: { error: 'rate_limited' }, retryAfter: '2' }
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.signIn }))
    await flush()
    expect(alertText()).toBe(SIGN_IN_TEXT.tooMany(2))
    const button = () => screen.getByRole('button', { name: SIGN_IN_TEXT.signIn }) as HTMLButtonElement
    expect(button().disabled).toBe(true)
    clock += 1000
    await advance(1000)
    expect(alertText()).toBe(SIGN_IN_TEXT.tooMany(1))
    clock += 1000
    await advance(1000)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button().disabled).toBe(false)
  })

  it('the Show/Hide toggle flips the password field type and says its state', async () => {
    await mount()
    const field = screen.getByLabelText(SIGN_IN_TEXT.passwordLabel) as HTMLInputElement
    expect(field.type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(field.type).toBe('text')
    expect(screen.getByRole('button', { name: 'Hide password' }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('SignInScreen: first-run setup', () => {
  it('renders one card: no setup code, no open-window button, no disclosure; the privacy note sits below', async () => {
    setupRequired = true
    await mount()
    expect(screen.getByRole('heading').textContent).toBe(SIGN_IN_TEXT.setupTitle)
    expect(screen.getByText(SIGN_IN_TEXT.setupIntro)).toBeDefined()
    expect(screen.getByText(SIGN_IN_TEXT.localNote)).toBeDefined()
    expect(screen.queryByLabelText(/setup code/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /setup window/i })).toBeNull()
    expect(document.querySelector('details')).toBeNull()
    expect(document.querySelector('main')).not.toBeNull()
    expect(document.activeElement?.id).toBe('setup-username')
  })

  it('create stays disabled until valid; the 400s land in the alert and focus the field; 201 enters', async () => {
    setupRequired = true
    const reload = await mount()
    const create = () => screen.getByRole('button', { name: SIGN_IN_TEXT.create }) as HTMLButtonElement
    expect(create().disabled).toBe(true)
    type('setup-username', 'ada')
    type('setup-password', 'short')
    type('setup-confirm', 'short')
    expect(create().disabled).toBe(true)
    type('setup-password', 'long enough passphrase')
    expect(create().disabled).toBe(true)
    fireEvent.blur(document.getElementById('setup-confirm')!)
    expect(screen.getByText(SIGN_IN_TEXT.mismatch)).toBeDefined()
    type('setup-confirm', 'long enough passphrase')
    expect(create().disabled).toBe(false)
    setupReply = { status: 400, body: { error: 'weak_password' } }
    fireEvent.click(create())
    await flush()
    expect(alertText()).toBe(SIGN_IN_TEXT.weakPassword)
    expect(document.activeElement?.id).toBe('setup-password')
    setupReply = { status: 400, body: { error: 'invalid_username' } }
    fireEvent.click(create())
    await flush()
    expect(alertText()).toBe(SIGN_IN_TEXT.invalidUsername)
    expect(document.activeElement?.id).toBe('setup-username')
    setupReply = { status: 201, body: { user: { id: 1, username: 'ada' } } }
    fireEvent.click(create())
    await flush()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(bodiesOf(AUTH_SETUP_PATH).at(-1)).toEqual({ username: 'ada', password: 'long enough passphrase' })
  })

  it('409 already_setup: says so with a Sign in button that switches to the sign-in screen', async () => {
    setupRequired = true
    await mount()
    type('setup-username', 'ada')
    type('setup-password', 'long enough passphrase')
    type('setup-confirm', 'long enough passphrase')
    setupReply = { status: 409, body: { error: 'already_setup' } }
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.create }))
    await flush()
    expect(alertText()).toBe(SIGN_IN_TEXT.accountExists)
    setupRequired = false
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.signIn }))
    await flush()
    expect((screen.getByLabelText(SIGN_IN_TEXT.passwordLabel) as HTMLInputElement).autocomplete).toBe('current-password')
    expect(screen.getByRole('button', { name: SIGN_IN_TEXT.open })).toBeDefined()
  })
})
