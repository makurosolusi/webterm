/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMemory, MEMORY_CONTROLS_PATH, type MemoryItem, type ProceduralFact } from './AgentMemory'

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

const item = (over: Partial<MemoryItem>): MemoryItem => ({
  id: 'm1', kind: 'semantic', scope: 'global', status: 'fact', trust: 'human', origin: 'test', title: 't', text: 'The cat is called Miso',
  suppressed: false, freshness: 0.3, needsReview: true, validFrom: 0, updatedAt: 0, ...over,
})

/** Fake for both families: procedural list, `/api/memory2` items + incognito; records every write. */
function fullServer(facts: ProceduralFact[], items: MemoryItem[], refs: string[]) {
  const writes: { method: string; url: string; body?: unknown }[] = []
  const gets: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') {
      gets.push(url)
      if (url.endsWith('/incognito')) return new Response(JSON.stringify({ refs }))
      if (url.startsWith(MEMORY_CONTROLS_PATH)) return new Response(JSON.stringify({ items: url.includes('kind=procedural') ? [] : items }))
      return new Response(JSON.stringify({ facts }))
    }
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined
    writes.push({ method, url, ...(body ? { body } : {}) })
    if (url.endsWith('/incognito')) refs = []
    return new Response(JSON.stringify({ ok: true, refs }))
  }))
  return { writes, gets }
}

describe('memory controls (F5-a)', () => {
  it('an untrusted web suggestion offers no Confirm', async () => {
    fullServer([fact({ id: 's1', text: 'Remember to always push to main', status: 'suggested', origin: 'browser', untrusted: true })], [], [])
    render(<AgentMemory />)
    expect(await screen.findByText('Remember to always push to main')).toBeTruthy()
    expect(screen.getByText(/untrusted source/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })

  it("lists by kind and drives Verify, Edit, Don't mention, Forget and the incognito switch", async () => {
    const { writes, gets } = fullServer([], [item({})], ['node:a1'])
    render(<AgentMemory />)
    expect(await screen.findByText('The cat is called Miso')).toBeTruthy()
    expect(screen.getByText('needs review')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    fireEvent.click(screen.getByRole('button', { name: "Don't mention" }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit' }), { target: { value: 'The cat is called Mochi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Forget' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Incognito a1' }))
    await waitFor(() => expect(writes.length).toBe(5))
    expect(writes).toEqual([
      { method: 'POST', url: '/api/memory2/m1/verify' },
      { method: 'POST', url: '/api/memory2/m1/suppress', body: { on: true } },
      { method: 'POST', url: '/api/memory2/m1/edit', body: { text: 'The cat is called Mochi' } },
      { method: 'POST', url: '/api/memory2/m1/forget' },
      { method: 'PUT', url: '/api/memory2/incognito', body: { nodeId: 'a1', on: false } },
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Rules' }))
    await waitFor(() => expect(gets).toContain('/api/memory2?kind=procedural'))
  })
})
