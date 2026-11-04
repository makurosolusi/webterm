/** @vitest-environment jsdom */
// Kartu Token akses: status off/on/env, aktifkan -> tautan sekali + Salin, rotasi tersembunyi untuk env,
// tab ini tetap jalan (token tersimpan di transport), nilai token tidak pernah masuk console.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilitiesSection } from './CapabilitiesSection'
import { TokenAccessCard } from './TokenAccessCard'
import { TOKEN_TEXT } from './tokenAccessLabels'
import { TOKEN_KEY, peekToken } from './transportToken'
import type { TokenStatus } from './tokenAccess.api.client'

const FIXTURE_TOKEN = 'fixture-token-abc123' // test-only
const OFF: TokenStatus = { enforced: false, source: 'none', canEnable: true }
const ON_FILE: TokenStatus = { enforced: true, source: 'file', canEnable: false }
const ON_ENV: TokenStatus = { enforced: true, source: 'env', canEnable: false }

type Call = { url: string; method: string; headers: Record<string, string> }
let calls: Call[] = []

function serve(statuses: TokenStatus[], post: { status: number; body: unknown } = { status: 200, body: { token: FIXTURE_TOKEN } }): void {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ url, method, headers: (init.headers ?? {}) as Record<string, string> })
    if (method === 'POST') return new Response(JSON.stringify(post.body), { status: post.status })
    const s = statuses[Math.min(i++, statuses.length - 1)]
    return new Response(JSON.stringify(s), { status: 200 })
  }))
}

const consoleSpies = (): ReturnType<typeof vi.spyOn>[] =>
  (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined))

beforeEach(() => { calls = []; sessionStorage.clear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('TokenAccessCard', () => {
  it('off: plain-words status, when to use it, Aktifkan shown, Rotasi hidden', async () => {
    serve([OFF])
    render(<TokenAccessCard reload={vi.fn()} />)
    expect(await screen.findByText(TOKEN_TEXT.off)).toBeTruthy()
    expect(screen.getByText(TOKEN_TEXT.why)).toBeTruthy()
    expect(screen.getByRole('button', { name: TOKEN_TEXT.enable })).toBeTruthy()
    expect(screen.queryByRole('button', { name: TOKEN_TEXT.rotate })).toBeNull()
  })

  it('off from another address: no Aktifkan button, explains why', async () => {
    serve([{ ...OFF, canEnable: false }])
    render(<TokenAccessCard reload={vi.fn()} />)
    expect(await screen.findByText(TOKEN_TEXT.offRemote)).toBeTruthy()
    expect(screen.queryByRole('button', { name: TOKEN_TEXT.enable })).toBeNull()
  })

  it('on from file: Rotasi shown, Aktifkan hidden', async () => {
    serve([ON_FILE])
    render(<TokenAccessCard reload={vi.fn()} />)
    expect(await screen.findByText(TOKEN_TEXT.onFile)).toBeTruthy()
    expect(screen.getByRole('button', { name: TOKEN_TEXT.rotate })).toBeTruthy()
    expect(screen.queryByRole('button', { name: TOKEN_TEXT.enable })).toBeNull()
  })

  it('on from env: explains it is managed outside, no Rotasi', async () => {
    serve([ON_ENV])
    render(<TokenAccessCard reload={vi.fn()} />)
    expect(await screen.findByText(TOKEN_TEXT.onEnv)).toBeTruthy()
    expect(screen.queryByRole('button', { name: TOKEN_TEXT.rotate })).toBeNull()
    expect(screen.queryByRole('button', { name: TOKEN_TEXT.enable })).toBeNull()
  })

  it('declined confirm sends nothing', async () => {
    serve([OFF])
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<TokenAccessCard reload={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: TOKEN_TEXT.enable }))
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('enable: confirm, link shown once with Copy, token stored for this tab, never logged', async () => {
    const spies = consoleSpies()
    serve([OFF, ON_FILE])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const reload = vi.fn()
    render(<TokenAccessCard reload={reload} />)
    fireEvent.click(await screen.findByRole('button', { name: TOKEN_TEXT.enable }))
    expect(confirm).toHaveBeenCalledWith(TOKEN_TEXT.confirmEnable)

    const input = (await screen.findByLabelText(TOKEN_TEXT.linkLabel)) as HTMLInputElement
    expect(input.value).toBe(`${location.origin}/?token=${FIXTURE_TOKEN}`)
    expect(calls.find((c) => c.method === 'POST')?.url).toBe('/api/settings/token/enable')

    // Tab ini tetap jalan: token di sessionStorage (cara transportToken.ts membaca) dan dipakai GET berikutnya.
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(FIXTURE_TOKEN)
    expect(peekToken()).toBe(FIXTURE_TOKEN)
    await screen.findByText(TOKEN_TEXT.onFile)
    expect(calls.at(-1)?.headers['x-webterm-token']).toBe(FIXTURE_TOKEN)

    fireEvent.click(screen.getByRole('button', { name: TOKEN_TEXT.copy }))
    expect(writeText).toHaveBeenCalledWith(input.value)
    expect(await screen.findByRole('button', { name: TOKEN_TEXT.copied })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: TOKEN_TEXT.done }))
    expect(screen.queryByLabelText(TOKEN_TEXT.linkLabel)).toBeNull()
    expect(document.body.textContent).not.toContain(FIXTURE_TOKEN)
    expect(reload).toHaveBeenCalledTimes(1)

    for (const s of spies) for (const args of s.mock.calls) expect(JSON.stringify(args)).not.toContain(FIXTURE_TOKEN)
  })

  it('closing the card with the link open clears it and reloads so the whole tab uses the new token', async () => {
    serve([ON_FILE])
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const reload = vi.fn()
    const { unmount } = render(<TokenAccessCard reload={reload} />)
    fireEvent.click(await screen.findByRole('button', { name: TOKEN_TEXT.rotate }))
    await screen.findByLabelText(TOKEN_TEXT.linkLabel)
    expect(calls.find((c) => c.method === 'POST')?.url).toBe('/api/settings/token/rotate')
    unmount()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('copy without clipboard access shows the manual-copy hint', async () => {
    serve([OFF])
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    render(<TokenAccessCard reload={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: TOKEN_TEXT.enable }))
    fireEvent.click(await screen.findByRole('button', { name: TOKEN_TEXT.copy }))
    expect(await screen.findByText(TOKEN_TEXT.copyFailed)).toBeTruthy()
  })

  it.each([
    ['agent_cannot_approve', TOKEN_TEXT.agentCannot],
    ['approval_browser_only', TOKEN_TEXT.browserOnly],
    ['loopback_only', TOKEN_TEXT.loopbackOnly],
  ])('403 %s maps to honest text, no link, nothing stored', async (code, text) => {
    serve([OFF], { status: 403, body: { error: code } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<TokenAccessCard reload={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: TOKEN_TEXT.enable }))
    expect((await screen.findByRole('alert')).textContent).toBe(text)
    expect(screen.queryByLabelText(TOKEN_TEXT.linkLabel)).toBeNull()
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  it('status load failure is shown, not swallowed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    render(<TokenAccessCard reload={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(TOKEN_TEXT.loadFailed))
  })

  it.each(['token', 'akses', 'keamanan', 'tunnel'])('Settings search "%s" finds the card', async (q) => {
    serve([OFF])
    render(<CapabilitiesSection projectId="p1" query={q} sectionTitle="Kemampuan" />)
    expect(await screen.findByRole('region', { name: TOKEN_TEXT.title })).toBeTruthy()
  })

  it('unrelated search hides the card', () => {
    serve([OFF])
    render(<CapabilitiesSection projectId="p1" query="chromium" sectionTitle="Kemampuan" />)
    expect(screen.queryByRole('region', { name: TOKEN_TEXT.title })).toBeNull()
  })
})
