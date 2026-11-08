/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PolicyRules, type PolicyGrant } from './PolicyRules'
import { prefillRule, secretRule } from './policyPresets'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const NOW = 1_700_000_000_000 // test-only
const grant = (over: Partial<PolicyGrant>): PolicyGrant => ({
  id: 'g1', subject: 'node:*', capability: 'browser.*', scope: '*', effect: 'allow', expiresAt: null,
  origin: 'human-ui', createdBy: 'human-ui', createdAt: NOW, ...over,
})

/** Fake `/api/policy/grants`: in-memory list, records every write. */
function server(initial: PolicyGrant[]) {
  let grants = [...initial]
  let next = 2
  const writes: { method: string; url: string; body?: Record<string, unknown> }[] = []
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') return new Response(JSON.stringify({ grants }))
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    writes.push({ method, url, ...(body ? { body } : {}) })
    if (method === 'POST') {
      if (body?.capability === 'bad[') return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      grants = [...grants, grant({ id: `g${next++}`, ...(body as Partial<PolicyGrant>), expiresAt: (body?.expiresAt as number | undefined) ?? null })]
      return new Response(JSON.stringify({ grant: grants.at(-1) }), { status: 201 })
    }
    grants = grants.filter((g) => !url.endsWith(`/${g.id}`))
    return new Response(JSON.stringify({ ok: true }))
  })
  vi.stubGlobal('fetch', f)
  return { writes }
}

const combo = (name: string) => screen.getByRole('combobox', { name }) as HTMLInputElement
const type = (name: string, value: string) => fireEvent.change(combo(name), { target: { value } })

describe('Policy rules (Settings › Rules & approvals)', () => {
  it('reads each rule in plain words, with no raw patterns or origin', async () => {
    server([grant({}), grant({ id: 'g9', subject: 'node:a1', effect: 'deny', capability: 'node.close', expiresAt: NOW + 3_600_000, origin: 'telegram' }),
      grant({ id: 'g7', subject: 'central', capability: 'secret.run', scope: 'secret:NPM_TOKEN:npm publish*' })])
    render(<PolicyRules now={() => NOW} />)
    await waitFor(() => expect(document.querySelector('li[data-grant="g9"]')).toBeTruthy())
    const rows = [...document.querySelectorAll('li[data-grant]')].map((li) => li.textContent ?? '')
    expect(rows[0]).toContain('Any agent → Any browser action (anywhere)')
    expect(rows[0]).toContain('Forever')
    expect(rows[1]).toContain('Agent a1 → Close a node (anywhere)')
    expect(rows[1]).toContain('until ')
    expect(rows[2]).toContain('Central → Use a secret (NPM_TOKEN, starting with npm publish)')
    for (const r of rows) {
      expect(r).not.toMatch(/node:|\*|telegram|human-ui/)
    }
  })

  it('changes a rule effect with the segmented control (new rule first, then the old one revoked)', async () => {
    const { writes } = server([grant({ id: 'g9', capability: 'node.close', expiresAt: NOW + 3_600_000 })])
    render(<PolicyRules now={() => NOW} />)
    const group = await screen.findByRole('radiogroup', { name: /Effect for Any agent → Close a node/ })
    expect(within(group).getByRole('radio', { name: 'Allow' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(group).getByRole('radio', { name: 'Deny' }))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[0]).toEqual({ method: 'POST', url: '/api/policy/grants', body: { subject: 'node:*', capability: 'node.close', scope: '*', effect: 'deny', expiresAt: NOW + 3_600_000 } })
    expect(writes[1]).toEqual({ method: 'DELETE', url: '/api/policy/grants/g9' })
    await waitFor(() => expect(within(screen.getByRole('radiogroup', { name: /Effect for Any agent → Close a node/ })).getByRole('radio', { name: 'Deny' }).getAttribute('aria-checked')).toBe('true'))
  })

  it('revokes a rule', async () => {
    const { writes } = server([grant({}), grant({ id: 'g9', capability: 'node.close' })])
    render(<PolicyRules now={() => NOW} />)
    await waitFor(() => expect(document.querySelector('li[data-grant="g9"]')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[1]!)
    await waitFor(() => expect(document.querySelector('li[data-grant="g9"]')).toBeNull())
    expect(writes).toEqual([{ method: 'DELETE', url: '/api/policy/grants/g9' }])
  })

  it('adds a rule with a Who select, What/Where comboboxes and segmented Effect / How long; no plain text boxes', async () => {
    const { writes } = server([])
    render(<PolicyRules now={() => NOW} />)
    expect(await screen.findByText('No rules yet.')).toBeTruthy()
    const row = screen.getByTestId('policy-add-rule')
    expect(row.querySelectorAll('input:not([role="combobox"])')).toHaveLength(0)
    expect((within(row).getByLabelText('Who') as HTMLSelectElement).tagName).toBe('SELECT')
    type('What', 'browser.*')
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.body).toEqual({ subject: 'node:*', capability: 'browser.*', scope: '*', effect: 'allow', expiresAt: NOW + 3_600_000 })

    fireEvent.change(within(row).getByLabelText('Who'), { target: { value: 'central' } })
    type('Where', 'npm test*')
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'How long' })).getByRole('radio', { name: 'Forever' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Effect' })).getByRole('radio', { name: 'Deny' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]!.body).toEqual({ subject: 'central', capability: 'browser.*', scope: 'npm test*', effect: 'deny' })
  })

  it('offers the shared presets in What and Where', async () => {
    server([])
    render(<PolicyRules now={() => NOW} />)
    await screen.findByText('No rules yet.')
    fireEvent.click(within(combo('What').closest('.st-combo') as HTMLElement).getByRole('button', { name: 'Show suggestions' }))
    fireEvent.click(screen.getByRole('option', { name: /Use a secret/ }))
    expect(combo('What').value).toBe('secret.run')
  })

  it('takes a pre-fill from another panel (Secrets: allow an agent to use one)', async () => {
    const { writes } = server([])
    render(<PolicyRules now={() => NOW} />)
    await screen.findByText('No rules yet.')
    act(() => prefillRule(secretRule('NPM_TOKEN')))
    expect(combo('What').value).toBe('secret.run')
    expect(combo('Where').value).toBe('secret:NPM_TOKEN:*')
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.body).toMatchObject({ subject: 'node:*', capability: 'secret.run', scope: 'secret:NPM_TOKEN:*', effect: 'allow' })
  })

  it('shows the server reason when a rule is refused, and the ledger-off state', async () => {
    server([])
    render(<PolicyRules now={() => NOW} />)
    await screen.findByText('No rules yet.')
    type('What', 'bad[')
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    expect((await screen.findByRole('alert')).textContent).toContain('invalid_grant')
    cleanup()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'ledger_off' }), { status: 503 })))
    render(<PolicyRules />)
    expect(await screen.findByText(/ledger is off/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add rule' })).toBeNull()
  })
})
