/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PolicyRules, type PolicyGrant } from './PolicyRules'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const NOW = 1_700_000_000_000 // test-only
const grant = (over: Partial<PolicyGrant>): PolicyGrant => ({
  id: 'g1', subject: 'node:*', capability: 'browser.*', scope: '*', effect: 'allow', expiresAt: null,
  origin: 'human-ui', createdBy: 'human-ui', createdAt: NOW, ...over,
})

/** Fake `/api/policy/grants`: in-memory list, records every write. */
function server(initial: PolicyGrant[]) {
  let grants = [...initial]
  const writes: { method: string; url: string; body?: Record<string, unknown> }[] = []
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') return new Response(JSON.stringify({ grants }))
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    writes.push({ method, url, ...(body ? { body } : {}) })
    if (method === 'POST') {
      if (body?.capability === 'bad[') return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      grants = [...grants, grant({ id: 'g2', ...(body as Partial<PolicyGrant>), expiresAt: (body?.expiresAt as number | undefined) ?? null })]
      return new Response(JSON.stringify({ grant: grants.at(-1) }), { status: 201 })
    }
    grants = grants.filter((g) => !url.endsWith(`/${g.id}`))
    return new Response(JSON.stringify({ ok: true }))
  })
  vi.stubGlobal('fetch', f)
  return { writes }
}

describe('Policy rules (Settings › Control)', () => {
  it('lists rules with effect and expiry, and revokes one', async () => {
    const { writes } = server([grant({}), grant({ id: 'g9', effect: 'deny', capability: 'node.close', expiresAt: NOW + 3_600_000, origin: 'telegram' })])
    render(<PolicyRules now={() => NOW} />)
    expect(await screen.findByText('node.close')).toBeTruthy()
    expect(screen.getByText(/Permanent/)).toBeTruthy()
    expect(screen.getByText(/until /)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[1]!)
    await waitFor(() => expect(screen.queryByText('node.close')).toBeNull())
    expect(writes).toEqual([{ method: 'DELETE', url: '/api/policy/grants/g9' }])
  })

  it('creates an expiring rule by default and a permanent one only when "Forever" is chosen', async () => {
    const { writes } = server([])
    render(<PolicyRules now={() => NOW} />)
    expect(await screen.findByText('No rules yet.')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: /Capability/ }), { target: { value: 'browser.*' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.body).toEqual({ subject: 'node:*', capability: 'browser.*', scope: '*', effect: 'allow', expiresAt: NOW + 3_600_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Forever' }))
    fireEvent.click(screen.getByRole('button', { name: 'deny' }))
    expect(screen.getByRole('button', { name: 'Forever' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]!.body).toEqual({ subject: 'node:*', capability: 'browser.*', scope: '*', effect: 'deny' })
  })

  it('shows the server reason when a rule is refused, and the ledger-off state', async () => {
    server([])
    render(<PolicyRules now={() => NOW} />)
    await screen.findByText('No rules yet.')
    fireEvent.change(screen.getByRole('textbox', { name: /Capability/ }), { target: { value: 'bad[' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    expect((await screen.findByRole('alert')).textContent).toContain('invalid_grant')
    cleanup()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'ledger_off' }), { status: 503 })))
    render(<PolicyRules />)
    expect(await screen.findByText(/ledger is off/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add rule' })).toBeNull()
  })
})
