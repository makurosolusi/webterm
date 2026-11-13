/** @vitest-environment jsdom */
// Automation token card: status off/on/env, enable -> the bare value once + Copy, rotate hidden for env,
// no sign-in path (no /auth/login, no `?token=` link), the value never reaches the console.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TokenAccessCard } from './TokenAccessCard'
import { TOKEN_TEXT } from './tokenAccessLabels'
import type { TokenStatus } from './tokenAccess.api.client'

const FIXTURE_TOKEN = 'fixture-token-abc123' // test-only
const OFF: TokenStatus = { enforced: false, source: 'none', canEnable: true }
const ON_FILE: TokenStatus = { enforced: true, source: 'file', canEnable: false }
const ON_ENV: TokenStatus = { enforced: true, source: 'env', canEnable: false }

type Call = { url: string; method: string; headers: Record<string, string>; body?: string }
let calls: Call[] = []

function serve(statuses: TokenStatus[], post: { status: number; body: unknown } = { status: 200, body: { token: FIXTURE_TOKEN } }): void {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ url, method, headers: (init.headers ?? {}) as Record<string, string>, body: init.body as string | undefined })
    if (method === 'POST') return new Response(JSON.stringify(post.body), { status: post.status })
    const s = statuses[Math.min(i++, statuses.length - 1)]
    return new Response(JSON.stringify(s), { status: 200 })
  }))
}

const consoleSpies = (): ReturnType<typeof vi.spyOn>[] =>
  (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined))

beforeEach(() => { calls = [] })

/** Confirms the app AlertDialog asking `q`. */
async function agree(q: { title: string; action: string }): Promise<void> {
  const dialog = await screen.findByRole('alertdialog', { name: q.title })
  fireEvent.click(within(dialog).getByRole('button', { name: q.action }))
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('TokenAccessCard', () => {
  it('off: plain-words status, when to use it, Aktifkan shown, Rotasi hidden', async () => {
    serve([OFF])
    render(<TokenAccessCard />)
    expect(await screen.findByText(TOKEN_TEXT.off)).toBeTruthy()
    expect(screen.getByText(TOKEN_TEXT.why)).toBeTruthy()
    expect(screen.getByRole('button', { name: TOKEN_TEXT.enable })).toBeTruthy()
    expect(screen.queryByRole('button', { name: TOKEN_TEXT.rotate })).toBeNull()
  })

  it('off from another address: no Aktifkan button, explains why', async () => {
    serve([{ ...OFF, canEnable: false }])
    render(<TokenAccessCard />)
    expect(await screen.findByText(TOKEN_TEXT.offRemote)).toBeTruthy()
    expect(screen.queryByRole('button', { name: TOKEN_TEXT.enable })).toBeNull()
  })

  it('on from file: Rotasi shown, Aktifkan hidden', async () => {
    serve([ON_FILE])
    render(<TokenAccessCard />)
    expect(await screen.findByText(TOKEN_TEXT.onFile)).toBeTruthy()
    expect(screen.getByRole('button', { name: TOKEN_TEXT.rotate })).toBeTruthy()
    expect(screen.queryByRole('button', { name: TOKEN_TEXT.enable })).toBeNull()
  })

  it('on from env: explains it is managed outside, no Rotasi', async () => {
    serve([ON_ENV])
    render(<TokenAccessCard />)
    expect(await screen.findByText(TOKEN_TEXT.onEnv)).toBeTruthy()
    expect(screen.queryByRole('button', { name: TOKEN_TEXT.rotate })).toBeNull()
    expect(screen.queryByRole('button', { name: TOKEN_TEXT.enable })).toBeNull()
  })

  it('asks in the app dialog, never window.confirm; Cancel sends nothing', async () => {
    serve([OFF])
    const confirm = vi.spyOn(window, 'confirm')
    render(<TokenAccessCard />)
    fireEvent.click(await screen.findByRole('button', { name: TOKEN_TEXT.enable }))
    const dialog = await screen.findByRole('alertdialog', { name: TOKEN_TEXT.confirmEnable.title })
    fireEvent.click(within(dialog).getByRole('button', { name: TOKEN_TEXT.cancel }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(await screen.findByText(TOKEN_TEXT.unchanged)).toBeTruthy()
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
    expect(confirm).not.toHaveBeenCalled()
  })

  it('enable: confirm, the bare token shown once with Copy, no sign-in request, never logged', async () => {
    const spies = consoleSpies()
    serve([OFF, ON_FILE])
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<TokenAccessCard />)
    fireEvent.click(await screen.findByRole('button', { name: TOKEN_TEXT.enable }))
    await agree(TOKEN_TEXT.confirmEnable)

    const input = (await screen.findByLabelText(TOKEN_TEXT.valueLabel)) as HTMLInputElement
    expect(input.value).toBe(FIXTURE_TOKEN) // the value itself, never a `/?token=` sign-in link
    expect(calls.find((c) => c.method === 'POST')?.url).toBe('/api/settings/token/enable')
    expect(calls.every((c) => c.url.startsWith('/api/settings/token'))).toBe(true) // no /auth/login
    await screen.findByText(TOKEN_TEXT.onFile)
    for (const c of calls) expect(JSON.stringify(c)).not.toContain(FIXTURE_TOKEN)
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: TOKEN_TEXT.copy }))
    expect(writeText).toHaveBeenCalledWith(FIXTURE_TOKEN)
    expect(await screen.findByRole('button', { name: TOKEN_TEXT.copied })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: TOKEN_TEXT.done }))
    expect(screen.queryByLabelText(TOKEN_TEXT.valueLabel)).toBeNull()
    expect(document.body.textContent).not.toContain(FIXTURE_TOKEN)

    for (const s of spies) for (const args of s.mock.calls) expect(JSON.stringify(args)).not.toContain(FIXTURE_TOKEN)
  })

  it('rotate shows the new value; the card offers no way to sign in with it', async () => {
    serve([ON_FILE])
    render(<TokenAccessCard />)
    expect(screen.getByRole('region', { name: TOKEN_TEXT.title }).textContent).toContain(TOKEN_TEXT.intro)
    fireEvent.click(await screen.findByRole('button', { name: TOKEN_TEXT.rotate }))
    await agree(TOKEN_TEXT.confirmRotate)
    await screen.findByLabelText(TOKEN_TEXT.valueLabel)
    expect(calls.find((c) => c.method === 'POST')?.url).toBe('/api/settings/token/rotate')
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull()
    expect(screen.queryByRole('textbox', { name: /link/i })).toBeNull()
  })

  it('copy without clipboard access shows the manual-copy hint', async () => {
    serve([OFF])
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    render(<TokenAccessCard />)
    fireEvent.click(await screen.findByRole('button', { name: TOKEN_TEXT.enable }))
    await agree(TOKEN_TEXT.confirmEnable)
    fireEvent.click(await screen.findByRole('button', { name: TOKEN_TEXT.copy }))
    expect(await screen.findByText(TOKEN_TEXT.copyFailed)).toBeTruthy()
  })

  it.each([
    ['agent_cannot_approve', TOKEN_TEXT.agentCannot],
    ['approval_browser_only', TOKEN_TEXT.browserOnly],
    ['loopback_only', TOKEN_TEXT.loopbackOnly],
  ])('403 %s maps to honest text, no value, no sign-in', async (code, text) => {
    serve([OFF], { status: 403, body: { error: code } })
    render(<TokenAccessCard />)
    fireEvent.click(await screen.findByRole('button', { name: TOKEN_TEXT.enable }))
    await agree(TOKEN_TEXT.confirmEnable)
    expect(screen.getByRole('button', { name: TOKEN_TEXT.enabling }).getAttribute('aria-busy')).toBe('true')
    await waitFor(() => expect(document.querySelector('[data-action-result="failed"] [role="alert"]')?.textContent).toContain(text))
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByLabelText(TOKEN_TEXT.valueLabel)).toBeNull()
    expect(calls.some((c) => c.url.startsWith('/auth/'))).toBe(false)
  })

  it('status load failure is shown with Retry, not swallowed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    render(<TokenAccessCard />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(TOKEN_TEXT.loadFailed))
    serve([OFF])
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: TOKEN_TEXT.retry }))
    expect(await screen.findByText(TOKEN_TEXT.off)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
