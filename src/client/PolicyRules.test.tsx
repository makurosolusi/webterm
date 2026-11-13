/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PolicyRules, type PolicyGrant } from './PolicyRules'
import { PolicyRuleForm } from './PolicyRuleForm'
import { RECENT_ASKS_PATH, type RecentAsk } from './policyRules.api'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const NOW = 1_700_000_000_000 // test-only
const grant = (over: Partial<PolicyGrant>): PolicyGrant => ({
  id: 'g1', subject: 'node:*', capability: 'browser.*', scope: '*', effect: 'allow', expiresAt: null,
  origin: 'human-ui', createdBy: 'human-ui', createdAt: NOW, ...over,
})

/** Fake `/api/policy/grants` (+ recent asks): in-memory list, records every write. */
function server(initial: PolicyGrant[], asks: RecentAsk[] = []) {
  let grants = [...initial]
  let next = 2
  const writes: { method: string; url: string; body?: Record<string, unknown> }[] = []
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url === RECENT_ASKS_PATH) return new Response(JSON.stringify({ items: asks }))
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

describe('Policy rules (Settings › Rules & secrets)', () => {
  it('reads each rule in plain words, with no raw patterns or origin', async () => {
    server([grant({}), grant({ id: 'g9', subject: 'node:a1', effect: 'deny', capability: 'node.close', expiresAt: NOW + 3_600_000, origin: 'telegram' }),
      grant({ id: 'g7', subject: 'central', capability: 'secret.run', scope: 'secret:NPM_TOKEN:npm publish*' })])
    render(<PolicyRules />)
    await waitFor(() => expect(document.querySelector('li[data-grant="g9"]')).toBeTruthy())
    const rows = [...document.querySelectorAll('li[data-grant]')].map((li) => li.textContent ?? '')
    expect(rows[0]).toContain('Any agent → Any browser action (anywhere)')
    expect(rows[0]).toContain('Forever')
    expect(rows[1]).toContain('Agent a1 → Close a node (anywhere)')
    expect(rows[1]).toContain('Until ')
    expect(rows[2]).toContain('Central → Use a secret (NPM_TOKEN, starting with npm publish)')
    for (const r of rows) {
      expect(r).not.toMatch(/node:|\*|telegram|human-ui/)
    }
    // The stored patterns stay one hover away.
    expect(screen.getByText(/Agent a1 → Close a node/).getAttribute('title')).toBe('node:a1 · node.close · *')
  })

  it('reads an unknown Claude Code tool in words', async () => {
    server([grant({ capability: 'claude.tool:Read' })])
    render(<PolicyRules />)
    expect((await screen.findByText(/Use the Read tool/)).getAttribute('title')).toBe('node:* · claude.tool:Read · *')
  })

  it('changes a rule effect with the segmented control (new rule first, then the old one revoked)', async () => {
    const { writes } = server([grant({ id: 'g9', capability: 'node.close', expiresAt: NOW + 3_600_000 })])
    render(<PolicyRules />)
    const group = await screen.findByRole('radiogroup', { name: /Effect for Any agent → Close a node/ })
    expect(within(group).getByRole('radio', { name: 'Allow' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(group).getByRole('radio', { name: 'Deny' }))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[0]).toEqual({ method: 'POST', url: '/api/policy/grants', body: { subject: 'node:*', capability: 'node.close', scope: '*', effect: 'deny', expiresAt: NOW + 3_600_000 } })
    expect(writes[1]).toEqual({ method: 'DELETE', url: '/api/policy/grants/g9' })
    await waitFor(() => expect(within(screen.getByRole('radiogroup', { name: /Effect for Any agent → Close a node/ })).getByRole('radio', { name: 'Deny' }).getAttribute('aria-checked')).toBe('true'))
  })

  it('names the workspace a rule is limited to, and keeps that limit when the effect changes', async () => {
    const { writes } = server([grant({ id: 'g5', capability: 'secret.run', scope: 'secret:NPM_TOKEN:*', workspaceId: 'w1' }),
      grant({ id: 'g6', capability: 'secret.run', scope: 'secret:GH:*', workspaceId: 'gone' })])
    render(<PolicyRules workspaceNames={new Map([['w1', 'Shop']])} />)
    const group = await screen.findByRole('radiogroup', { name: /Effect for Any agent in Shop → Use a secret \(NPM_TOKEN, any command\)/ })
    // A workspace no longer open reads in words, never as its id.
    expect(document.querySelector('li[data-grant="g6"]')?.textContent).toContain('Any agent in a removed workspace →')
    expect(document.querySelector('li[data-grant="g6"]')?.textContent).not.toContain('gone')
    fireEvent.click(within(group).getByRole('radio', { name: 'Deny' }))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[0]?.body).toEqual({ subject: 'node:*', capability: 'secret.run', scope: 'secret:NPM_TOKEN:*', effect: 'deny', workspaceId: 'w1' })
  })

  it('revokes a rule', async () => {
    const { writes } = server([grant({}), grant({ id: 'g9', capability: 'node.close' })])
    render(<PolicyRules />)
    await waitFor(() => expect(document.querySelector('li[data-grant="g9"]')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[1]!)
    await waitFor(() => expect(document.querySelector('li[data-grant="g9"]')).toBeNull())
    expect(writes).toEqual([{ method: 'DELETE', url: '/api/policy/grants/g9' }])
  })

  it('offers recent approval prompts as one-click rules, hides covered ones, and adds the rule in place', async () => {
    const asks: RecentAsk[] = [
      { tool: 'Bash', label: 'Bash(npm test)', pattern: 'npm test', node: 'brisk-otter', createdAt: NOW },
      { tool: 'Bash', label: 'Bash(git push)', pattern: 'git push', node: 'brisk-otter', createdAt: NOW },
      { tool: 'Edit', label: 'Edit(src/a.ts)', pattern: 'src/a.ts', node: 'calm-fox', createdAt: NOW },
    ]
    const { writes } = server([grant({ id: 'g5', capability: 'claude.tool:Edit', scope: 'src/a.ts' })], asks)
    render(<PolicyRules />)
    const quick = await screen.findByTestId('policy-quick-rules')
    expect([...quick.querySelectorAll('li[data-ask]')].map((li) => li.getAttribute('data-ask'))).toEqual(['Bash:npm test', 'Bash:git push'])
    const row = quick.querySelector('li[data-ask="Bash:git push"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Always block' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toEqual({ method: 'POST', url: '/api/policy/grants', body: { subject: 'node:*', capability: 'claude.tool:Bash', scope: 'git push', effect: 'deny' } })
    expect(await within(row).findByText('Now always blocked')).toBeTruthy()
    // The list picked the new rule up without a reload.
    await waitFor(() => expect(document.querySelectorAll('li[data-grant]')).toHaveLength(2))
  })

  it('shows the activity-log-off state without Retry (nothing to retry), in plain words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'ledger_off' }), { status: 503 })))
    render(<PolicyRules />)
    expect(await screen.findByText('Rules are unavailable while the activity log is off.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByTestId('policy-quick-rules')).toBeNull()
  })

  it('a failed load says so in the card with Retry, which loads again', async () => {
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === RECENT_ASKS_PATH) return new Response(JSON.stringify({ items: [] }))
      return fail ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ grants: [grant({})] }))
    }))
    render(<PolicyRules />)
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load the rules.')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(document.querySelector('li[data-grant="g1"]')).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('an empty list says what that means and offers Add a rule, which goes to the form', async () => {
    server([])
    render(<><PolicyRules /><PolicyRuleForm /></>)
    expect(await screen.findByText('No rules yet. Agents ask you before each action until you add one.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule' }))
    expect(document.activeElement).toBe(combo('What'))
  })

  it('the list is a card titled Rules with one row per rule (label left, controls right)', async () => {
    server([grant({}), grant({ id: 'g2', capability: 'node.close' })])
    render(<PolicyRules />)
    const list = await screen.findByRole('list', { name: 'Rules' })
    expect(list.closest('[data-slot="settings-group"]')?.querySelector('h3')?.textContent).toBe('Rules')
    await waitFor(() => expect(list.querySelectorAll('li.st-field')).toHaveLength(2))
    for (const li of list.querySelectorAll('li')) expect(li.querySelector('.st-control [role="radiogroup"]')).toBeTruthy()
  })
})

describe('Add a rule (Settings › Rules & secrets)', () => {
  it('adds a rule with a Who select, What/Where comboboxes and segmented Effect / How long, one row each; no plain text boxes', async () => {
    const { writes } = server([])
    render(<PolicyRuleForm now={() => NOW} />)
    const row = screen.getByTestId('policy-add-rule')
    expect(row.querySelectorAll('input:not([role="combobox"])')).toHaveLength(0)
    expect([...row.querySelectorAll('.st-field .st-label')].map((l) => l.textContent)).toEqual(['Who', 'What', 'Where', 'Effect', 'How long'])
    expect((within(row).getByLabelText('Who') as HTMLSelectElement).tagName).toBe('SELECT')
    // Nothing to cover yet: Add says why it is off.
    expect((screen.getByRole('button', { name: 'Add rule' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Pick what the rule covers first.')).toBeTruthy()
    type('What', 'browser.*')
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.body).toEqual({ subject: 'node:*', capability: 'browser.*', scope: '*', effect: 'allow', expiresAt: NOW + 3_600_000 })
    expect(await screen.findByText('Rule added')).toBeTruthy()

    fireEvent.change(within(row).getByLabelText('Who'), { target: { value: 'central' } })
    type('Where', 'npm test*')
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'How long' })).getByRole('radio', { name: 'Forever' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Effect' })).getByRole('radio', { name: 'Deny' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]!.body).toEqual({ subject: 'central', capability: 'browser.*', scope: 'npm test*', effect: 'deny' })
  })

  it('offers the shared presets in What and Where', () => {
    server([])
    render(<PolicyRuleForm />)
    fireEvent.click(within(combo('What').closest('.st-combo') as HTMLElement).getByRole('button', { name: 'Show suggestions' }))
    fireEvent.click(screen.getByRole('option', { name: /Use a secret/ }))
    // At rest the box reads the plain words of the stored pattern; the pattern itself shows while editing.
    expect(combo('What').value).toBe('Use a secret')
    fireEvent.focus(combo('What'))
    expect(combo('What').value).toBe('secret.run')
  })

  it('shows the server reason when a rule is refused', async () => {
    server([])
    render(<PolicyRuleForm />)
    type('What', 'bad[')
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    expect((await screen.findAllByRole('alert'))[0]!.textContent).toContain('invalid_grant')
  })
})
