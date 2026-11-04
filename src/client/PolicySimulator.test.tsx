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
  it('shows both classifier switches OFF by default and flips one through PUT', async () => {
    const { writes } = server()
    render(<PolicySimulator />)
    const central = await screen.findByRole('checkbox', { name: /Central's gated actions/ })
    await waitFor(() => expect(central.getAttribute('data-disabled')).toBeNull())
    expect(central.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('checkbox', { name: /permission prompts/ }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(central)
    await waitFor(() => expect(central.getAttribute('aria-checked')).toBe('true'))
    expect(writes).toEqual([{ method: 'PUT', url: POLICY_CLASSIFIER_PATH, body: { central: true, permissions: false } }])
  })

  it('posts the proposed rule and renders before/after counts and examples', async () => {
    const { writes } = server()
    render(<PolicySimulator />)
    fireEvent.change(screen.getByLabelText(/Capability/), { target: { value: 'claude.tool:Bash' } })
    fireEvent.change(screen.getByLabelText(/Scope/), { target: { value: 'npm test*' } })
    fireEvent.click(screen.getByRole('button', { name: 'Simulate' }))
    expect(await screen.findByText('5 decisions replayed, 3 would change.')).toBeTruthy()
    expect(screen.getByText(/1 asks stay with you/)).toBeTruthy()
    const allowRow = document.querySelector('tr[data-effect="allow"]')!
    expect(allowRow.textContent).toBe('Allowed14')
    expect(screen.getByText(/claude.tool:Bash \(npm test\): Asked you → Allowed/)).toBeTruthy()
    expect(writes.at(-1)).toEqual({ method: 'POST', url: POLICY_SIMULATE_PATH, body: { add: [{ subject: 'node:*', capability: 'claude.tool:Bash', scope: 'npm test*', effect: 'allow' }], classifier: false } })
  })
})
