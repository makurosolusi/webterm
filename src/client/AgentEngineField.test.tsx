/** @vitest-environment jsdom */
// Engine row: no picker; status from the real (token-free) Central launch test, and "Check again" that
// re-detects, re-tests, shows it is busy, stamps the time on every result, and reports failure + Retry.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentEngineField } from './AgentEngineField'
import type { CapabilitiesLoad } from './useCapabilities'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const READY = { // test-only
  ok: true, profile: { id: 'default', name: 'Default' }, warnings: [],
  steps: [{ stage: 'claude', ok: true, message: 'claude 2.1.3 (Claude Code)' }, { stage: 'auth', ok: true, message: 'Signed in (claude.ai)' }],
}
const MISSING = { // test-only
  ok: false, profile: { id: 'm', name: 'Malik' }, failed: 'claude_not_found', warnings: [],
  steps: [{ stage: 'claude', ok: false, message: 'The claude CLI was not found on PATH.', hint: 'Afterwards open a new terminal.',
    install: { installCommand: 'curl -fsSL https://claude.ai/install.sh | bash', npmCommand: 'npm install -g @anthropic-ai/claude-code', docsUrl: 'https://code.claude.com/docs/en/setup' } }],
}
const launchFetch = (...bodies: unknown[]) => {
  const f = vi.fn(async () => new Response(JSON.stringify(bodies.length > 1 ? bodies.shift() : bodies[0]), { status: 200 }))
  vi.stubGlobal('fetch', f)
  return f
}
const OK_LOAD = { ok: true, data: {} } as unknown as CapabilitiesLoad // test-only
const setup = (redetect = vi.fn(async (): Promise<CapabilitiesLoad> => OK_LOAD)) => {
  render(<AgentEngineField redetect={redetect} />)
  return redetect
}
const TIME = /· checked \d{1,2}[:.]\d{2}[:.]\d{2}/

describe('AgentEngineField', () => {
  it('has no engine picker and checks once on mount with the launch test, without re-detecting', async () => {
    const f = launchFetch(READY)
    const redetect = setup()
    const line = await screen.findByText(/Runs on Claude/)
    expect(line.closest('p')?.textContent).toMatch(/^Runs on Claude · 2\.1\.3 \(Claude Code\) · checked /)
    expect(line.closest('p')?.textContent).toMatch(TIME)
    expect(screen.getByText('Engine')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ central: true })
    expect(redetect).not.toHaveBeenCalled()
    expect(document.querySelector('[data-slot="vscode-notification"]')).toBeNull()
  })

  it('Claude missing: says why, shows the install commands and the launch profile link, no toast on the automatic check', async () => {
    launchFetch(MISSING)
    const opened = vi.fn()
    window.addEventListener('webterm:open-settings', opened)
    setup()
    expect((await screen.findByRole('alert')).textContent).toContain('Claude cannot start: The claude CLI was not found on PATH.')
    expect(screen.getByText('Launch profile: Malik')).toBeTruthy()
    expect(screen.getByText('Afterwards open a new terminal.')).toBeTruthy()
    expect(screen.getByText('curl -fsSL https://claude.ai/install.sh | bash')).toBeTruthy()
    expect(document.querySelector('[data-slot="vscode-notification"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit launch profile' }))
    expect((opened.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ section: 'central' })
    window.removeEventListener('webterm:open-settings', opened)
  })

  it('Check again: busy while checking, re-detects then re-tests, and a same answer still gets a new result', async () => {
    const f = launchFetch(READY)
    const redetect = setup()
    await screen.findByText(/Runs on Claude/)
    const firstSeq = document.querySelector('[data-action-result]')?.getAttribute('data-seq')
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    const busy = screen.getByRole('button', { name: 'Checking…' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(busy.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(busy) // ignored while running
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy())
    expect(redetect).toHaveBeenCalledTimes(1)
    expect(f).toHaveBeenCalledTimes(2)
    const seq = document.querySelector('[data-action-result]')?.getAttribute('data-seq')
    expect(Number(seq)).toBe(Number(firstSeq) + 1)
    expect(screen.getByRole('status').textContent).toMatch(TIME)
  })

  it('a failed re-detect names the cause and offers Retry in a toast', async () => {
    const f = launchFetch(READY)
    const redetect = vi.fn(async (): Promise<CapabilitiesLoad> => ({ ok: false, error: 'Could not load capabilities.' }))
    setup(redetect)
    await screen.findByText(/Runs on Claude/)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    const alert = await screen.findByText('Could not check Claude: Could not load capabilities.', { selector: 'p > span' })
    expect(alert.closest('p')?.getAttribute('role')).toBe('alert')
    expect(f).toHaveBeenCalledTimes(1) // the launch test does not run on stale data
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(redetect).toHaveBeenCalledTimes(2))
  })
})
