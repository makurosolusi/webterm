/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POLICY_CLASSIFIER_PATH, POLICY_SIMULATE_PATH, PolicySimulator, type SimReport } from './PolicySimulator'
import { RulesSection } from './RulesSection'

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

describe('Policy simulator (Settings › Rules & secrets › Advanced)', () => {
  it('has no auto-approval switches any more (the approval level in Settings › Claude owns them) and never writes them', async () => {
    const { writes } = server()
    render(<PolicySimulator />)
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }))
    await screen.findByText('5 decisions replayed, 3 would change.')
    // The only switch left is the try-out's own "Include the small model".
    expect(screen.getAllByRole('switch').map((x) => x.getAttribute('id'))).toEqual(['sim-classifier'])
    expect(writes.filter((w) => w.url === POLICY_CLASSIFIER_PATH)).toEqual([])
  })

  it('lives under the page\'s one Advanced collapsible (closed, no count), one row per choice', async () => {
    server()
    render(<RulesSection />)
    const details = screen.getByTestId('rules-advanced').querySelector('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')!.textContent).toBe('Advanced')
    const sim = within(details).getByTestId('policy-simulator')
    expect(within(sim).getByText('Try a rule on the last 7 days')).toBeTruthy()
    expect([...sim.querySelectorAll('.st-field .st-label')].map((l) => l.textContent)).toEqual(['Who', 'What', 'Where', 'Effect', 'Include the small model'])
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
