/** @vitest-environment jsdom */
// Claude provider card: mode switch, key is write-only (only "saved" is shown), unsaved edits are saved
// before Test connection, the honest test result and the restart hint; the key never reaches the console.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeProviderCard, PROVIDER_TEXT, validateGatewayUrl } from './ClaudeProviderCard'

const KEY = 'sk-test-only-0123456789abcdef' // test-only
type Call = { url: string; method: string; body?: string }
let calls: Call[] = []
let resetFails = 0

function serve(view: Record<string, unknown>, test = { ok: false, message: 'The endpoint rejected the credential.', at: 1 }): void {
  let current = { provider: view, lastTest: null, restartNeeded: 0 }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ url, method, body: init.body as string | undefined })
    if (method === 'PUT') {
      const b = JSON.parse(init.body as string)
      current = { provider: { mode: b.mode, baseUrl: b.baseUrl, credential: b.credential, secretSet: !!b.secret, ready: !!b.secret }, lastTest: null, restartNeeded: 1 }
      return new Response(JSON.stringify(current), { status: 200 })
    }
    if (method === 'POST' && url.endsWith('/reset')) {
      if (resetFails-- > 0) return new Response(JSON.stringify({ error: 'write_failed' }), { status: 500 })
      current = { provider: { mode: 'login', secretSet: false, ready: true }, lastTest: null, restartNeeded: 0 }
      return new Response(JSON.stringify(current), { status: 200 })
    }
    if (method === 'POST') return new Response(JSON.stringify({ test }), { status: 200 })
    return new Response(JSON.stringify(current), { status: 200 })
  }))
}

beforeEach(() => { calls = []; resetFails = 0 })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('ClaudeProviderCard', () => {
  it('login by default: no key field', async () => {
    serve({ mode: 'login', secretSet: false, ready: true })
    render(<ClaudeProviderCard />)
    expect(await screen.findByText(PROVIDER_TEXT.modeHelp.login)).toBeTruthy()
    expect(screen.queryByLabelText(PROVIDER_TEXT.key)).toBeNull()
  })

  it('a saved key shows only "saved", never a value', async () => {
    serve({ mode: 'apiKey', secretSet: true, ready: true })
    render(<ClaudeProviderCard />)
    const input = await screen.findByLabelText(PROVIDER_TEXT.key) as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.type).toBe('password')
    expect(input.placeholder).toBe(PROVIDER_TEXT.keySet)
  })

  // agent-211-A6: a damaged config is a sticky alert with a fix action, never a silent login default.
  it('a damaged config shows an alert; Reset failing keeps it with a retry, succeeding clears it', async () => {
    serve({ mode: 'login', secretSet: false, ready: true, configError: 'unreadable' })
    resetFails = 1
    render(<ClaudeProviderCard />)
    expect(await screen.findByText(new RegExp(PROVIDER_TEXT.damaged.slice(0, 40)))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: PROVIDER_TEXT.reset }))
    expect(await screen.findByText(PROVIDER_TEXT.resetFailed('write_failed'))).toBeTruthy()
    expect(screen.getByText(new RegExp(PROVIDER_TEXT.damaged.slice(0, 40)))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: PROVIDER_TEXT.reset }))
    await waitFor(() => expect(screen.queryByText(new RegExp(PROVIDER_TEXT.damaged.slice(0, 40)))).toBeNull())
    expect(screen.queryByText(PROVIDER_TEXT.resetFailed('write_failed'))).toBeNull()
    expect(calls.filter((c) => c.url.endsWith('/reset')).map((c) => c.method)).toEqual(['POST', 'POST'])
  })

  it('custom endpoint: Test saves the form first, then shows the honest result and the restart hint', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined))
    serve({ mode: 'login', secretSet: false, ready: true })
    render(<ClaudeProviderCard />)
    fireEvent.click(await screen.findByRole('button', { name: PROVIDER_TEXT.modes.custom }))
    fireEvent.change(screen.getByLabelText(PROVIDER_TEXT.baseUrl), { target: { value: 'https://gw.example.test' } })
    fireEvent.change(screen.getByLabelText(PROVIDER_TEXT.key), { target: { value: KEY } })
    fireEvent.click(screen.getByRole('button', { name: PROVIDER_TEXT.test }))
    expect(await screen.findByText('The endpoint rejected the credential.')).toBeTruthy()
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'POST'])
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ mode: 'custom', baseUrl: 'https://gw.example.test', credential: 'authToken', secret: KEY })
    // The test of what was just saved failed: no plain "Saved." success under it.
    expect(screen.getByText(PROVIDER_TEXT.savedCheckFailed)).toBeTruthy()
    expect(screen.queryByText(new RegExp(PROVIDER_TEXT.restart(1).slice(0, 30)))).toBeNull()
    await waitFor(() => expect((screen.getByLabelText(PROVIDER_TEXT.key) as HTMLInputElement).value).toBe(''))
    for (const s of spies) for (const c of s.mock.calls) expect(JSON.stringify(c)).not.toContain(KEY)
  })

  it('a passing test after Save keeps the plain "Saved." and the restart hint', async () => {
    serve({ mode: 'login', secretSet: false, ready: true }, { ok: true, message: 'Connected.', at: 1 })
    render(<ClaudeProviderCard />)
    fireEvent.click(await screen.findByRole('button', { name: PROVIDER_TEXT.modes.apiKey }))
    fireEvent.change(screen.getByLabelText(PROVIDER_TEXT.key), { target: { value: KEY } })
    fireEvent.click(screen.getByRole('button', { name: PROVIDER_TEXT.test }))
    expect(await screen.findByText('Connected.')).toBeTruthy()
    expect(screen.getByText(new RegExp(`^${PROVIDER_TEXT.saved} ${PROVIDER_TEXT.restart(1).slice(0, 30)}`))).toBeTruthy()
    expect(screen.queryByText(PROVIDER_TEXT.savedCheckFailed)).toBeNull()
  })

  it('onTested (setup wizard): the card hides its own result and reports each test to the host', async () => {
    serve({ mode: 'apiKey', secretSet: true, ready: true })
    const onTested = vi.fn()
    render(<ClaudeProviderCard onTested={onTested} />)
    fireEvent.click(await screen.findByRole('button', { name: PROVIDER_TEXT.test }))
    await waitFor(() => expect(onTested).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('The endpoint rejected the credential.')).toBeNull()
  })

  it('custom endpoint: base URL and model are comboboxes; a URL with a user or password is refused, the key stays a password box', async () => {
    serve({ mode: 'custom', baseUrl: '', credential: 'authToken', secretSet: false, ready: false })
    render(<ClaudeProviderCard />)
    const url = await screen.findByRole('combobox', { name: PROVIDER_TEXT.baseUrl }) as HTMLInputElement
    fireEvent.change(url, { target: { value: 'https://me:pw@gw.example.test' } })
    fireEvent.blur(url)
    expect(screen.getByRole('alert').textContent).toBe(PROVIDER_TEXT.urlCredentials)
    expect(validateGatewayUrl('ftp://gw')).toBe(PROVIDER_TEXT.badUrl)
    expect(validateGatewayUrl('https://gw.example.test/v1')).toBeNull()
    const model = screen.getByRole('combobox', { name: PROVIDER_TEXT.model })
    fireEvent.keyDown(model, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Claude Code default', 'haiku', 'sonnet', 'opus', 'fable'])
    expect((screen.getByLabelText(PROVIDER_TEXT.key) as HTMLInputElement).type).toBe('password')
  })
})
