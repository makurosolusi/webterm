/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listCommands } from '../commandRegistry'
import BakeoffHost, { BakeoffDialog } from './BakeoffHost'
import type { BakeoffView, CandidateView } from './bakeoff.client'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// test-only fixtures
const cand = (idx: number, extra: Partial<CandidateView> = {}): CandidateView => ({
  id: `b1-${idx}`, idx, nodeId: `bakeoff-b1-${idx}`, path: `/wt/p-${idx}`, branch: `bakeoff-b1-${idx}`, status: 'done', exitCode: 0, error: null,
  costMicros: 150_000 + idx * 100_000, durationMs: 65_000, verified: true, startedAt: 1, finishedAt: 2,
  verdict: { status: 'done', reason: 'verified', summary: 'ok', filesChanged: 2, files: ['a.ts', 'b.ts'], diffStat: ` a.ts | 3 ++-\n`, tests: { passed: 4, failed: 0 }, typecheck: true },
  ...extra,
})
const bakeoff = (extra: Partial<BakeoffView> = {}): BakeoffView => ({
  id: 'b1', workspaceId: 'ws', repo: '/r', baseBranch: 'main', baseSha: 'abc', prompt: 'Fix the flaky test', status: 'ready',
  winnerId: null, inboxItemId: 'i1', createdAt: 1, updatedAt: 1,
  candidates: [cand(1), cand(2, { status: 'failed', verified: false, error: 'agent timed out', verdict: null })], ...extra,
})

type Call = { url: string; method: string; body: unknown }
function stubApi(answer: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const c = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const a = answer(c)
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 })
  }))
  return calls
}

describe('Bake-off dialog', () => {
  it('shows a comparison card per candidate: verifier result, diff stat, cost, duration, errors', async () => {
    stubApi(() => ({ body: { bakeoffs: [bakeoff()] } }))
    render(<BakeoffDialog repo="/r" onClose={() => {}} />)
    expect(await screen.findByText(/2 files · tests 4\/4 · typecheck ok · \$0\.25 · 1m 5s/)).toBeTruthy()
    expect(screen.getByText('Verified')).toBeTruthy()
    expect(screen.getByText(/a\.ts \| 3 \+\+-/)).toBeTruthy()
    expect(screen.getByText('agent timed out')).toBeTruthy()
    expect(screen.getAllByText('Pick as winner')).toHaveLength(2)
  })

  it('starts a fan-out with the workspace repo, prompt and count', async () => {
    const calls = stubApi((c) => (c.method === 'POST' ? { status: 201, body: bakeoff({ status: 'running' }) } : { body: { bakeoffs: [] } }))
    render(<BakeoffDialog repo="/r" workspaceId="ws" onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Add dark mode' } })
    fireEvent.change(screen.getByLabelText('Agents'), { target: { value: '3' } })
    fireEvent.click(screen.getByText('Start bake-off'))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeTruthy())
    expect(calls.find((c) => c.method === 'POST')).toEqual({ url: '/api/bakeoff', method: 'POST', body: { repo: '/r', prompt: 'Add dark mode', count: 3, workspaceId: 'ws' } })
  })

  it('pick sends the candidate; cleanup removes nothing until the confirm button', async () => {
    let state = bakeoff()
    const calls = stubApi((c) => {
      if (c.url.endsWith('/pick')) { state = bakeoff({ status: 'picked', winnerId: 'b1-1' }); return { body: state } }
      if (c.url.endsWith('/cleanup')) {
        const b = c.body as { confirm?: boolean }
        return b.confirm ? { body: { needsConfirm: false, removed: ['b1-2'] } } : { status: 409, body: { error: 'needs_confirm', remove: [state.candidates[1]] } }
      }
      return { body: { bakeoffs: [state] } }
    })
    render(<BakeoffDialog repo="/r" onClose={() => {}} />)
    fireEvent.click((await screen.findAllByText('Pick as winner'))[0]!)
    await screen.findByText('Merge winner into main')
    expect(calls.find((c) => c.url.endsWith('/pick'))?.body).toEqual({ candidateId: 'b1-1' })
    fireEvent.click(screen.getByText('Clean up worktrees…'))
    expect(await screen.findByText(/Remove 1 worktree and their branches/)).toBeTruthy()
    expect(calls.filter((c) => c.url.endsWith('/cleanup')).map((c) => c.body)).toEqual([{}])
    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/cleanup')).map((c) => c.body)).toEqual([{}, { confirm: true }]))
  })
})

describe('Bake-off host', () => {
  it('registers the ⌘K command, which opens the dialog', async () => {
    stubApi(() => ({ body: { bakeoffs: [] } }))
    render(<BakeoffHost repo="/r" />)
    const cmd = listCommands().find((c) => c.id === 'bakeoff.open')
    expect(cmd?.label).toBe('Bake-off: Compare Agents on One Prompt…')
    expect(screen.queryByTestId('bakeoff-dialog')).toBeNull()
    act(() => cmd!.run!())
    expect(await screen.findByTestId('bakeoff-dialog')).toBeTruthy()
  })
})
