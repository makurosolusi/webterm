/** @vitest-environment jsdom */
// Signed out, the desktop boot renders only the sign-in page: no /api request (settings, closed
// history, presence) is started that the server would answer 403.
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { bootView, SignedOut } from './appBoot'
import { SIGN_IN_POLL_MS, SIGN_IN_TEXT } from './SignInScreen'
import { AUTH_ME_PATH } from './transportToken'

let signedIn: boolean | 'fail' = false
let setupRequired = false
let urls: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  signedIn = false
  setupRequired = false
  urls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    if (url !== AUTH_ME_PATH) return new Response(null, { status: 403 })
    if (signedIn === 'fail') throw new TypeError('network down')
    return new Response(JSON.stringify({ signedIn, setupRequired }), { status: 200 })
  }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('bootView', () => {
  it('signed in -> the app', async () => {
    signedIn = true
    expect(await bootView()).toBe('app')
  })

  it('a session without an account yet (setup pending) -> the sign-in page, which shows the setup form', async () => {
    signedIn = true
    setupRequired = true
    expect(await bootView()).toBe('sign-in')
  })

  it('signed out -> the sign-in page, and only /auth/me is asked while it shows', async () => {
    expect(await bootView()).toBe('sign-in')
    render(<TooltipProvider><SignedOut /></TooltipProvider>)
    await act(async () => { await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS * 3) })
    expect(screen.getByText(SIGN_IN_TEXT.title)).toBeTruthy()
    expect(urls.length).toBeGreaterThan(1)
    expect(urls.filter((u) => u.startsWith('/api/'))).toEqual([])
  })

  it('signed out or setup pending -> the shared socket is never opened (it would 403 and flip to auth)', async () => {
    const socket = vi.fn()
    vi.stubGlobal('WebSocket', socket)
    setupRequired = true
    signedIn = true
    expect(await bootView()).toBe('sign-in')
    render(<TooltipProvider><SignedOut /></TooltipProvider>)
    await act(async () => { await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS * 3) })
    expect(socket).not.toHaveBeenCalled()
  })

  it('an unreachable server -> the sign-in page (it keeps polling), with the failure named', async () => {
    signedIn = 'fail'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await bootView()).toBe('sign-in')
    expect(String(warn.mock.calls[0]?.[0])).toContain('checking the UI session at boot failed')
  })
})
