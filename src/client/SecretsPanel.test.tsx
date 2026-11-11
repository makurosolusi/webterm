/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RULES_CHANGED_EVENT } from './policyRules.api'
import { SecretsPanel, type SecretEntry, type SecretUse } from './SecretsPanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const VALUE = 'test-only-secret-value' // test-only
const AT = 1_700_000_000_000 // test-only

/** Fake `/api/secrets`: names in memory, records every write. */
function server(initial: SecretEntry[], usage: SecretUse[] | null = []) {
  let secrets = [...initial]
  const writes: { method: string; url: string; body?: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') return new Response(JSON.stringify({ secrets, usage }))
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    writes.push({ method, url, ...(body ? { body } : {}) })
    const name = decodeURIComponent(url.split('/').pop() ?? '')
    if (url === '/api/policy/grants') return new Response(JSON.stringify({ grant: { id: 'g1', ...body } }), { status: 201 })
    if (method === 'PUT') secrets = [...secrets.filter((s) => s.name !== name), { name, lastUsedAt: null }]
    else secrets = secrets.filter((s) => s.name !== name)
    return new Response(JSON.stringify({ ok: true, name }))
  }))
  return { writes }
}

describe('Secrets (Settings › Rules & secrets)', () => {
  it('opens with the plain intro, no policy jargon', async () => {
    server([])
    render(<SecretsPanel />)
    await screen.findByText('No secrets yet.')
    expect(screen.getByText('Agents ask before using a secret, unless you allow it here.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/secret\.run|secret:<|scope|capability/)
  })

  it('"Allow agents to use this" makes the rule right there, says so, and tells the rule list', async () => {
    const { writes } = server([{ name: 'NPM_TOKEN', lastUsedAt: null }])
    let changed = 0
    const on = (): void => { changed += 1 }
    window.addEventListener(RULES_CHANGED_EVENT, on)
    render(<SecretsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Allow agents to use this' }))
    expect((await screen.findAllByText('Agents may now use NPM_TOKEN. Revoke it under Rules.')).length).toBeGreaterThan(0)
    window.removeEventListener(RULES_CHANGED_EVENT, on)
    expect(writes).toEqual([{ method: 'POST', url: '/api/policy/grants', body: { subject: 'node:*', capability: 'secret.run', scope: 'secret:NPM_TOKEN:*', effect: 'allow' } }])
    expect(changed).toBe(1)
  })

  it('lists names with last use and the usage log, never a value', async () => {
    server([{ name: 'NPM_TOKEN', lastUsedAt: AT }, { name: 'GH_KEY', lastUsedAt: null }],
      [{ seq: 7, ts: AT, name: 'NPM_TOKEN', principal: 'node:a1', commandHash: 'abcdef0123456789', exitCode: 0 },
        { seq: 8, ts: AT, name: 'NPM_TOKEN', principal: 'central', commandHash: 'ffff', exitCode: 2 }])
    render(<SecretsPanel />)
    expect(await screen.findByText('NPM_TOKEN', { selector: 'code.flex-1' })).toBeTruthy()
    expect(screen.getByText('never used')).toBeTruthy()
    expect(screen.getByText(/last used/)).toBeTruthy()
    const log = screen.getByRole('table', { name: 'Usage log' })
    expect([...log.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['When', 'Secret', 'Used by', 'Command', 'Result'])
    const [first, second] = [...log.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))
    expect(first!.slice(1)).toEqual(['NPM_TOKEN', 'Agent a1', 'abcdef012345', 'OK'])
    expect(second!.slice(1)).toEqual(['NPM_TOKEN', 'Central', 'ffff', 'Failed (exit 2)'])
  })

  it('adds a secret, clears the value field, and deletes one', async () => {
    const { writes } = server([])
    render(<SecretsPanel />)
    expect(await screen.findByText('No secrets yet.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Name (e.g. NPM_TOKEN)'), { target: { value: 'npm_token' } })
    const value = screen.getByLabelText('Value') as HTMLInputElement
    expect(value.type).toBe('password')
    fireEvent.change(value, { target: { value: VALUE } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText('NPM_TOKEN')).toBeTruthy())
    expect(writes[0]).toEqual({ method: 'PUT', url: '/api/secrets/NPM_TOKEN', body: { value: VALUE } })
    expect(value.value).toBe('')
    expect(document.body.textContent).not.toContain(VALUE)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByText('No secrets yet.')).toBeTruthy())
    expect(writes[1]).toEqual({ method: 'DELETE', url: '/api/secrets/NPM_TOKEN' })
  })

  it('says so when the usage log is off and keeps Save disabled for a bad name', async () => {
    server([], null)
    render(<SecretsPanel />)
    expect(await screen.findByText(/unavailable while the ledger is off/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Name (e.g. NPM_TOKEN)'), { target: { value: '9BAD' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: VALUE } })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
