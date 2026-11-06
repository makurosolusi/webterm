/** @vitest-environment jsdom */
// Every SignInScreen state against a stubbed /auth/* (transportToken.ts): loading, signed out,
// opening, rate-limited countdown, error + Retry, signed in -> exactly one reload.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SignInScreen, { SIGN_IN_POLL_MS, SIGN_IN_TEXT } from './SignInScreen'
import { AUTH_LOGIN_PATH, AUTH_ME_PATH, AUTH_REQUEST_OPEN_PATH } from './transportToken'

let me: boolean | 'fail' = false
let openReply: { status: number; retryAfter?: string } | 'fail' = { status: 202 }
let loginStatus = 204
let calls: { url: string; init?: RequestInit }[] = []
let hidden = false
let meDelayMs = 0

beforeEach(() => {
  vi.useFakeTimers()
  me = false; openReply = { status: 202 }; loginStatus = 204; calls = []; hidden = false; meDelayMs = 0
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (hidden ? 'hidden' : 'visible'))
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url === AUTH_ME_PATH) {
      if (meDelayMs) await new Promise((r) => setTimeout(r, meDelayMs))
      if (me === 'fail') throw new TypeError('network down')
      return new Response(JSON.stringify({ signedIn: me }), { status: 200 })
    }
    if (url === AUTH_REQUEST_OPEN_PATH) {
      if (openReply === 'fail') throw new TypeError('network down')
      const headers: Record<string, string> = openReply.retryAfter ? { 'Retry-After': openReply.retryAfter } : {}
      return new Response('{}', { status: openReply.status, headers })
    }
    if (url === AUTH_LOGIN_PATH) return new Response(null, { status: loginStatus })
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

async function mount(now?: () => number) {
  const reload = vi.fn()
  render(<SignInScreen reload={reload} now={now} />)
  expect(screen.getByRole('status').textContent).toBe(SIGN_IN_TEXT.loading)
  await flush()
  return reload
}

describe('SignInScreen', () => {
  it('signed out: both ways in are offered; polling flips to signed in and reloads exactly once', async () => {
    const reload = await mount()
    expect(screen.getByRole('button', { name: SIGN_IN_TEXT.open })).toBeDefined()
    expect(screen.getByLabelText(SIGN_IN_TEXT.tokenLabel)).toBeDefined()
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
    expect(calls.filter((c) => c.url === AUTH_REQUEST_OPEN_PATH)).toHaveLength(2)
  })

  it('token form: 403 and 409 explain inline; 204 signs in and reloads once', async () => {
    const reload = await mount()
    const field = screen.getByLabelText(SIGN_IN_TEXT.tokenLabel)
    const submit = () => { fireEvent.change(field, { target: { value: ' s3cret ' } }); fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.signIn })) }
    loginStatus = 403
    submit()
    await flush()
    expect(screen.getByRole('alert').textContent).toBe(SIGN_IN_TEXT.wrongToken)
    loginStatus = 409
    submit()
    await flush()
    expect(screen.getByRole('alert').textContent).toBe(SIGN_IN_TEXT.noToken)
    loginStatus = 204
    submit()
    await flush()
    expect(reload).toHaveBeenCalledTimes(1)
    const posted = calls.filter((c) => c.url === AUTH_LOGIN_PATH).map((c) => c.init?.body)
    expect(posted).toEqual(Array(3).fill(JSON.stringify({ token: 's3cret' })))
  })

  it('the show/hide toggle is a labelled IconButton that flips the field type', async () => {
    await mount()
    const field = screen.getByLabelText(SIGN_IN_TEXT.tokenLabel) as HTMLInputElement
    expect(field.type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN_TEXT.showToken }))
    expect(field.type).toBe('text')
    expect(screen.getByRole('button', { name: SIGN_IN_TEXT.hideToken })).toBeDefined()
  })
})
