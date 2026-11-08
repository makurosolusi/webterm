/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POLICY_CLASSIFIER_PATH, POLICY_SIMULATE_PATH, PolicySimulator, type SimReport } from './PolicySimulator'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const REPORT: SimReport = { // test-only
  total: 5, truncated: false, changed: 3, neverAutoHeld: 1,
  before: { allow: 1, ask: 2, deny: 2, classifier: 0 }, after: { allow: 4, ask: 1, deny: 0, classifier: 0 },
  examples: [{ seq: 7, ts: 1, principal: 'node:a1', capability: 'claude.tool:Bash', resource: 'npm test', before: 'ask', after: 'allow', reason: 'proposed rules: allow' }],
}

function server() {
  let sw = { central: false, permissions: false }
  const writes: { method: string; url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined
    if (method !== 'GET') writes.push({ method, url, body })
    if (url === POLICY_CLASSIFIER_PATH && method === 'PUT') { sw = body as typeof sw; return new Response(JSON.stringify(sw)) }
    if (url === POLICY_CLASSIFIER_PATH) return new Response(JSON.stringify(sw))
    if (url === POLICY_SIMULATE_PATH) return new Response(JSON.stringify(REPORT))
    return new Response('{}', { status: 404 })
  }))
  return { writes }
}

describe('Policy simulator (Settings › Control)', () => {
  it('shows both auto-approval switches OFF by default, in plain words, and flips one through PUT', async () => {
    const { writes } = server()
    render(<PolicySimulator />)
    const central = await screen.findByRole('switch', { name: 'Let a small model approve low-risk actions for Central' })
    await waitFor(() => expect((central as HTMLButtonElement).disabled).toBe(false))
    expect(central.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Let a small model approve low-risk Claude Code prompts' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(document.body.textContent).not.toMatch(/never-auto|classifier/i)
    fireEvent.click(central)
    await waitFor(() => expect(central.getAttribute('aria-checked')).toBe('true'))
    expect(writes).toEqual([{ method: 'PUT', url: POLICY_CLASSIFIER_PATH, body: { central: true, permissions: false } }])
  })

  it('keeps the rule try-out collapsed until opened', async () => {
    server()
    render(<PolicySimulator />)
    const details = screen.getByTestId('policy-simulator-try') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')!.textContent).toBe('Try a rule on the last 7 days')
    fireEvent.click(details.querySelector('summary')!)
    expect(details.open).toBe(true)
  })

  it('posts the proposed rule and renders before/after counts and examples', async () => {
    const { writes } = server()
    render(<PolicySimulator />)
    fireEvent.change(screen.getByRole('combobox', { name: 'What' }), { target: { value: 'claude.tool:Bash' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Where' }), { target: { value: 'npm test*' } })
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }))
    expect(await screen.findByText('5 decisions replayed, 3 would change.')).toBeTruthy()
    expect(screen.getByText('1 would still ask you: those actions always ask.')).toBeTruthy()
    const allowRow = document.querySelector('tr[data-effect="allow"]')!
    expect(allowRow.textContent).toBe('Allowed14')
    expect(screen.getByText('Agent a1 → Run commands (npm test): Asked you → Allowed')).toBeTruthy()
    expect(writes.at(-1)).toEqual({ method: 'POST', url: POLICY_SIMULATE_PATH, body: { add: [{ subject: 'node:*', capability: 'claude.tool:Bash', scope: 'npm test*', effect: 'allow' }], classifier: false } })
  })
})
