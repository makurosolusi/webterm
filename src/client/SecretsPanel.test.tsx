/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    await screen.findByText(/^No secrets yet\./)
    expect(screen.getByText('Agents ask before using a secret, unless you allow it here.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/secret\.run|secret:<|scope|capability/)
  })

  it('"Allow for agents in <workspace>" makes a forever rule for that workspace only, says so, and tells the rule list', async () => {
    const { writes } = server([{ name: 'NPM_TOKEN', lastUsedAt: null }])
    let changed = 0
    const on = (): void => { changed += 1 }
    window.addEventListener(RULES_CHANGED_EVENT, on)
    render(<SecretsPanel workspace={{ id: 'w1', name: 'Shop' }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Allow for agents in Shop' }))
    expect((await screen.findAllByText('NPM_TOKEN: allowed for agents in Shop. Revoke it under Rules.')).length).toBeGreaterThan(0)
    window.removeEventListener(RULES_CHANGED_EVENT, on)
    // No expiresAt = forever; workspaceId = only the agents on that board.
    expect(writes).toEqual([{ method: 'POST', url: '/api/policy/grants', body: { subject: 'node:*', capability: 'secret.run', scope: 'secret:NPM_TOKEN:*', workspaceId: 'w1', effect: 'allow' } }])
    expect(changed).toBe(1)
  })

  it('locks Allow with the reason when no workspace is open, and writes nothing', async () => {
    const { writes } = server([{ name: 'NPM_TOKEN', lastUsedAt: null }])
    render(<SecretsPanel />)
    const button = await screen.findByRole('button', { name: 'Allow agents to use this' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText('Open a workspace first: the rule is for the agents in it.')).toBeTruthy()
    fireEvent.click(button)
    expect(writes).toEqual([])
  })

  it('lists names with a masked value and last use, plus the usage log; never a value', async () => {
    server([{ name: 'NPM_TOKEN', lastUsedAt: AT }, { name: 'GH_KEY', lastUsedAt: null }],
      [{ seq: 7, ts: AT, name: 'NPM_TOKEN', principal: 'node:a1', commandHash: 'abcdef0123456789', exitCode: 0 },
        { seq: 8, ts: AT, name: 'NPM_TOKEN', principal: 'central', commandHash: 'ffff', exitCode: 2 }])
    render(<SecretsPanel />)
    const row = (await screen.findByText('NPM_TOKEN', { selector: 'li code' })).closest('li') as HTMLElement
    expect(row.querySelector('.st-mask')?.textContent).toBe('••••••••')
    expect(within(row).getByText('Value hidden')).toBeTruthy()
    expect(row.textContent).toContain('Last used')
    expect((document.querySelector('li[data-secret="GH_KEY"]') as HTMLElement).textContent).toContain('Never used')
    const log = screen.getByRole('table', { name: 'Secret usage' })
    expect([...log.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['When', 'Secret', 'Used by', 'Command fingerprint', 'Result'])
    const [first, second] = [...log.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))
    expect(first!.slice(1)).toEqual(['NPM_TOKEN', 'Agent a1', 'abcdef012345', 'OK'])
    expect(second!.slice(1)).toEqual(['NPM_TOKEN', 'Central', 'ffff', 'Failed (exit 2)'])
  })

  it('Copy copies the name (what commands refer to), never a value', async () => {
    server([{ name: 'NPM_TOKEN', lastUsedAt: null }])
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<SecretsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy name NPM_TOKEN' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('NPM_TOKEN'))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('empty state: Add secret opens the form; the value box is a password with Show/Hide; Save clears it and closes the form', async () => {
    const { writes } = server([])
    render(<SecretsPanel />)
    expect(await screen.findByText(/^No secrets yet\./)).toBeTruthy()
    expect(screen.queryByLabelText('Value')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add secret' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'npm_token' } })
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('NPM_TOKEN')
    const value = screen.getByLabelText('Value') as HTMLInputElement
    expect(value.type).toBe('password')
    fireEvent.change(value, { target: { value: VALUE } })
    fireEvent.click(screen.getByRole('button', { name: 'Show value' }))
    expect(value.type).toBe('text')
    fireEvent.click(screen.getByRole('button', { name: 'Hide value' }))
    expect(value.type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('button', { name: 'Saving…' }).getAttribute('aria-busy')).toBe('true')
    await waitFor(() => expect(document.querySelector('li[data-secret="NPM_TOKEN"]')).toBeTruthy())
    expect((await screen.findByText('Saved NPM_TOKEN.')).closest('[data-action-result]')?.getAttribute('data-action-result')).toBe('ok')
    expect(writes[0]).toEqual({ method: 'PUT', url: '/api/secrets/NPM_TOKEN', body: { value: VALUE } })
    expect(screen.queryByLabelText('Value')).toBeNull()
    expect(document.body.textContent).not.toContain(VALUE)
  })

  it('Delete asks in the app dialog first: Cancel keeps it, Delete removes it and says so', async () => {
    const { writes } = server([{ name: 'NPM_TOKEN', lastUsedAt: null }])
    const confirm = vi.spyOn(window, 'confirm')
    render(<SecretsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete NPM_TOKEN' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Delete NPM_TOKEN?')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(writes).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Delete NPM_TOKEN' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByText(/^No secrets yet\./)).toBeTruthy())
    expect(writes).toEqual([{ method: 'DELETE', url: '/api/secrets/NPM_TOKEN' }])
    expect(await screen.findByText('Deleted NPM_TOKEN.')).toBeTruthy()
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('a failed load shows the reason with Retry, which loads again', async () => {
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async () => (fail ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ secrets: [], usage: [] })))))
    render(<SecretsPanel />)
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load the secrets.')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(/^No secrets yet\./)).toBeTruthy()
  })

  it('says so when the usage log is off and keeps Save disabled for a bad name, with the reason', async () => {
    server([], null)
    render(<SecretsPanel />)
    expect(await screen.findByText('The usage log is unavailable while the activity log is off.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add secret' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '9BAD' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: VALUE } })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/a capital letter first/)).toBeTruthy() // the disabled Save says why
  })
})
