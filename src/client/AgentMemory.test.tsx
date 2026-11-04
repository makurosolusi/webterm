/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMemory, type ProceduralFact } from './AgentMemory'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const fact = (over: Partial<ProceduralFact>): ProceduralFact => ({
  id: 'f1', text: 'Always run tests with TMPDIR=/tmp/st', status: 'verified', origin: 'human-ui', updatedAt: 0, useCount: 0, ...over,
})

/** Fake `/api/awareness/procedural`: in-memory list, records every write. */
function server(initial: ProceduralFact[]) {
  let facts = [...initial]
  const writes: { method: string; url: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') return new Response(JSON.stringify({ facts }))
    const body = init?.body ? JSON.parse(String(init.body)) as { text: string } : undefined
    writes.push({ method, url, ...(body ? { body } : {}) })
    if (method === 'POST' && url.endsWith('/confirm')) facts = facts.map((f) => (url.includes(`/${f.id}/`) ? { ...f, status: 'verified' } : f))
    else if (method === 'POST') facts = [...facts, fact({ id: 'f9', text: body!.text })]
    else facts = facts.filter((f) => !url.endsWith(`/${f.id}`))
    return new Response(JSON.stringify({ ok: true }))
  }))
  return { writes }
}

describe('What agents remember (Settings › Control)', () => {
  it('confirms a suggestion, forgets a fact and adds a new one', async () => {
    const { writes } = server([fact({}), fact({ id: 's1', text: 'Push without asking', status: 'suggested', origin: 'browser' })])
    render(<AgentMemory />)
    expect(await screen.findByText('Push without asking')).toBeTruthy()
    expect(screen.getByText(/from browser/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Confirm' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull())
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' })[0]!)
    await waitFor(() => expect(screen.queryByText(/TMPDIR/)).toBeNull())
    fireEvent.change(screen.getByRole('textbox', { name: 'Remember' }), { target: { value: ' Reply in Indonesian ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remember' }))
    expect(await screen.findByText('Reply in Indonesian')).toBeTruthy()
    expect(writes).toEqual([
      { method: 'POST', url: '/api/awareness/procedural/s1/confirm' },
      { method: 'DELETE', url: '/api/awareness/procedural/f1' },
      { method: 'POST', url: '/api/awareness/procedural', body: { text: 'Reply in Indonesian' } },
    ])
  })

  it('shows a note when the ledger is off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'ledger_off' }), { status: 503 })))
    render(<AgentMemory />)
    expect(await screen.findByText(/unavailable while the ledger is off/)).toBeTruthy()
  })
})
