/** @vitest-environment jsdom */
// Test connection view against a hand-fed NDJSON stream: spinner on the running stage, ok/failed/skipped
// rows, elapsed seconds + Cancel, the final banners and the button label cycle.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { CONNECTION_TEXT, ConnectionTest, testButtonLabel } from './ConnectionTest'
import { useConnectionTest } from './connectionTest.client'

/** fetch answering one NDJSON stream that the test writes line by line. */
function ndjsonServer() {
  const enc = new TextEncoder()
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
  const calls: { url: string; method?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, ...(init.method ? { method: init.method } : {}) })
    const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c } })
    init.signal?.addEventListener('abort', () => ctrl?.error(new DOMException('aborted', 'AbortError')))
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })
  }))
  return {
    calls,
    send: async (e: unknown): Promise<void> => {
      await vi.waitFor(() => { if (!ctrl) throw new Error('no stream yet') })
      await act(async () => { ctrl?.enqueue(enc.encode(`${JSON.stringify(e)}\n`)); await new Promise((r) => setTimeout(r, 0)) })
    },
  }
}

function Harness(): React.JSX.Element {
  const t = useConnectionTest()
  return <><Button onClick={() => void t.start()} disabled={t.state.running}>{testButtonLabel(t.state)}</Button><ConnectionTest test={t} /></>
}

const row = (stage: string): HTMLElement => document.querySelector(`[data-stage="${stage}"]`) as HTMLElement

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('ConnectionTest', () => {
  it('shows each stage live: spinner while running, check with detail and duration, cross with hint, dash when skipped; failure banner is an alert', async () => {
    const s = ndjsonServer()
    render(<Harness />)
    expect(document.querySelector('[data-connection-test]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: CONNECTION_TEXT.button.idle }))
    expect((await screen.findByRole('button', { name: CONNECTION_TEXT.button.running }) as HTMLButtonElement).disabled).toBe(true)
    expect(s.calls).toEqual([{ url: '/api/claude-provider/test', method: 'POST' }])
    await s.send({ stage: 'wrapper', state: 'skipped', detail: 'No wrapper in the launch command' })
    await s.send({ stage: 'cli', state: 'running' })
    expect(row('cli').dataset.state).toBe('running')
    expect(row('cli').querySelector('[data-icon="spinner"]')).toBeTruthy()
    expect(row('auth').dataset.state).toBe('waiting')
    expect(row('wrapper').querySelector('[data-icon="skipped"]')).toBeTruthy()
    await s.send({ stage: 'cli', state: 'ok', detail: 'claude 2.1.318', ms: 240 })
    await s.send({ stage: 'auth', state: 'running' })
    expect(row('cli').textContent).toContain('Claude CLI: claude 2.1.318 · 0.2 s')
    expect(row('cli').querySelector('[data-icon="ok"]')).toBeTruthy()
    expect(row('auth').querySelector('[data-icon="spinner"]')).toBeTruthy()
    expect(row('cli').querySelector('[data-icon="spinner"]')).toBeNull()
    await s.send({ stage: 'auth', state: 'failed', detail: 'Claude Code is not signed in.', hint: 'Run "claude auth login" on the server.', ms: 90 })
    await s.send({ stage: 'request', state: 'skipped', detail: 'Skipped: Sign-in failed' })
    await s.send({ result: 'failed', stage: 'auth', failed: 'auth_failed', summary: 'Failed at Sign-in: Claude Code is not signed in.', ms: 400, via: 'Claude Code login' })
    expect(row('auth').querySelector('[data-icon="failed"]')).toBeTruthy()
    expect(row('auth').textContent).toContain('Run "claude auth login" on the server.')
    expect(row('request').querySelector('[data-icon="skipped"]')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Failed at Sign-in: Claude Code is not signed in.')
    expect(screen.getByRole('button', { name: CONNECTION_TEXT.button.again })).toBeTruthy()
    expect(screen.queryByRole('button', { name: CONNECTION_TEXT.cancel })).toBeNull()
  })

  it('success: the request row names the model and the banner is a status line', async () => {
    const s = ndjsonServer()
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: CONNECTION_TEXT.button.idle }))
    await s.send({ stage: 'request', state: 'ok', detail: 'claude-haiku-4-5 answered in 1.2 s', ms: 1200 })
    await s.send({ result: 'ok', summary: 'Connection works — Claude answered in 1.2 s via envman', ms: 1500, via: 'envman', model: 'claude-haiku-4-5' })
    expect(row('request').textContent).toContain('Request: claude-haiku-4-5 answered in 1.2 s')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('status').some((n) => n.textContent?.includes('Connection works — Claude answered in 1.2 s via envman'))).toBe(true)
  })

  it('a check without the request: request row is neutral pending, the banner is "ready" (no success claim), the button still offers Test connection', async () => {
    const s = ndjsonServer()
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: CONNECTION_TEXT.button.idle }))
    await s.send({ stage: 'auth', state: 'ok', detail: 'Signed in', ms: 50 })
    await s.send({ stage: 'request', state: 'pending', detail: 'Not tested yet — press Test connection to send a test request' })
    await s.send({ result: 'ready', summary: 'Ready to test — the last check sends one small request', ms: 300, via: 'envman' })
    expect(row('request').dataset.state).toBe('pending')
    expect(row('request').querySelector('[data-icon="pending"]')).toBeTruthy()
    expect(row('request').querySelector('[data-icon="ok"], [data-icon="failed"]')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('status').some((n) => n.textContent?.includes('Ready to test — the last check sends one small request'))).toBe(true)
    expect(screen.getByRole('button', { name: CONNECTION_TEXT.button.idle })).toBeTruthy()
  })

  it('a failed install stage offers the commands to copy and the guide', async () => {
    const s = ndjsonServer()
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: CONNECTION_TEXT.button.idle }))
    const install = { installCommand: 'curl -fsSL https://claude.ai/install.sh | bash', npmCommand: 'npm install -g @anthropic-ai/claude-code', docsUrl: 'https://code.claude.com/docs/en/setup' }
    await s.send({ stage: 'cli', state: 'failed', detail: 'The claude CLI was not found on PATH.', install })
    fireEvent.click(screen.getByRole('button', { name: `${CONNECTION_TEXT.copy}: ${CONNECTION_TEXT.install}` }))
    fireEvent.click(screen.getByRole('button', { name: `${CONNECTION_TEXT.copy}: ${CONNECTION_TEXT.npm}` }))
    expect(writeText.mock.calls).toEqual([[install.installCommand], [install.npmCommand]])
    expect(await screen.findAllByText(CONNECTION_TEXT.copied)).toHaveLength(2)
    expect(screen.getByRole('link', { name: CONNECTION_TEXT.docs }).getAttribute('href')).toBe(install.docsUrl)
  })

  it('counts elapsed seconds while running; Cancel stops it and says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    ndjsonServer()
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: CONNECTION_TEXT.button.idle }))
    expect(await screen.findByText(CONNECTION_TEXT.testing(0))).toBeTruthy()
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(screen.getByText(CONNECTION_TEXT.testing(3))).toBeTruthy()
    vi.useRealTimers()
    fireEvent.click(screen.getByRole('button', { name: CONNECTION_TEXT.cancel }))
    expect(await screen.findByText(CONNECTION_TEXT.cancelled)).toBeTruthy()
    expect(screen.queryByText(/^Testing…/)).toBeNull()
    expect(screen.getByRole('button', { name: CONNECTION_TEXT.button.again })).toBeTruthy()
  })

  it('a test that cannot run at all (403) is an alert with the code', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'agent_cannot_manage_provider' }), { status: 403 })))
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: CONNECTION_TEXT.button.idle }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(CONNECTION_TEXT.couldNotRun('agent_cannot_manage_provider')))
  })
})
