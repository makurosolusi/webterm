/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    if (method === 'PUT') secrets = [...secrets.filter((s) => s.name !== name), { name, lastUsedAt: null }]
    else secrets = secrets.filter((s) => s.name !== name)
    return new Response(JSON.stringify({ ok: true, name }))
  }))
  return { writes }
}

describe('Secrets (Settings › Control)', () => {
  it('lists names with last use and the usage log, never a value', async () => {
    server([{ name: 'NPM_TOKEN', lastUsedAt: AT }, { name: 'GH_KEY', lastUsedAt: null }],
      [{ seq: 7, ts: AT, name: 'NPM_TOKEN', principal: 'node:a1', commandHash: 'abcdef0123456789', exitCode: 0 }])
    render(<SecretsPanel />)
    expect(await screen.findByText('NPM_TOKEN', { selector: 'code.flex-1' })).toBeTruthy()
    expect(screen.getByText('never used')).toBeTruthy()
    expect(screen.getByText(/last used/)).toBeTruthy()
    const log = screen.getByRole('list', { name: 'Usage log' })
    expect(log.textContent).toContain('node:a1')
    expect(log.textContent).toContain('abcdef012345')
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
