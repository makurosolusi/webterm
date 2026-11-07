/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listCommands } from '../commandRegistry'
import ReplayHost from './ReplayHost'
import { ReplayDialog } from './ReplayDialog'
import { pct, rangeFrom, type ReplayItem } from './replay.client'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// test-only fixtures
const T0 = 1_700_000_000_000
const NOW = () => T0 + 10_000
const item = (id: number, dt: number, lane: ReplayItem['lane'], text: string, extra: Partial<ReplayItem> = {}): ReplayItem =>
  ({ key: `event:${id}`, source: 'event', id, ts: T0 + dt, lane, nodeId: 'n1', text, ...extra })
const ITEMS = [
  item(1, 100, 'transcript', 'Prompt: fix it'),
  item(2, 300, 'tool', 'Tool call: Edit'),
  item(3, 600, 'file', 'Checkpoint #4 (prompt)', { checkpointSeq: 4 }),
  item(4, 900, 'cost', '$0.0015', { source: 'cost', key: 'cost:1', costMicros: 1500 }),
]

type Call = { url: string; method: string; body: unknown }
function stubApi() {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const c = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const u = new URL(url, 'http://x')
    let body: unknown = {}
    if (u.pathname === '/api/replay') {
      body = u.searchParams.get('cursor') ? { items: [], nextCursor: null } : { items: ITEMS, nextCursor: null }
    } else if (u.pathname === '/api/replay/state') {
      const t = Number(u.searchParams.get('t'))
      body = {
        t, costMicros: t >= T0 + 900 ? 1500 : 0, scrollback: t > T0 + 900 ? { asOf: t, text: '$ live tail' } : null,
        transcript: [{ ts: T0 + 100, nodeId: 'n1', text: 'user: fix it' }, ...(t >= T0 + 300 ? [{ ts: T0 + 300, nodeId: 'n1', text: 'assistant: editing' }] : [])],
        checkpoint: t >= T0 + 600 ? { seq: 4, ts: T0 + 600, reason: 'prompt', baseSeq: 3, files: [{ status: 'M', path: 'a.ts' }], patch: '-old\n+new', truncated: false } : null,
      }
    } else if (u.pathname === '/api/checkpoints/preview') {
      body = { files: [{ status: 'M', path: 'a.ts' }], patch: '-new\n+old', truncated: false }
    } else if (u.pathname === '/api/checkpoints/rewind') {
      body = { written: 1, deleted: 0, undoSeq: 5 }
    }
    return new Response(JSON.stringify(body), { status: 200 })
  }))
  return calls
}

describe('Session replay', () => {
  it('registers the ⌘K command', () => {
    render(<ReplayHost workspaceId="ws-1" nodes={[]} />)
    expect(listCommands().some((c) => c.id === 'replay.open' && c.label === 'Replay Session…')).toBe(true)
  })

  it('loads the scope and range, draws a tick per item on its lane, and starts at the end (live)', async () => {
    const calls = stubApi()
    render(<ReplayDialog workspaceId="ws-1" nodes={[{ id: 'n1', title: 'Claude' }]} onClose={() => {}} now={NOW} />)
    expect(await screen.findByTestId('replay-tick-event:3')).toBeTruthy()
    const first = new URL(calls[0]!.url, 'http://x')
    expect(first.pathname).toBe('/api/replay')
    expect(first.searchParams.get('workspace')).toBe('ws-1')
    expect(first.searchParams.get('from')).toBe(String(rangeFrom('day', NOW())))
    expect(screen.getByText('Transcript (1/1)')).toBeTruthy()
    // At the end the state is asked for "now", which is when live scrollback exists.
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/replay/state') && c.url.includes(`t=${NOW()}`))).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Claude' }))
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/replay?') && c.url.includes('node=n1'))).toBe(true))
    expect(await screen.findByTestId('replay-scrollback')).toBeTruthy()
  })

  it('scrubbing to t shows the state at that moment: transcript so far, checkpoint diff, counts', async () => {
    const calls = stubApi()
    render(<ReplayDialog workspaceId="ws-1" nodes={[]} onClose={() => {}} now={NOW} />)
    const slider = await screen.findByLabelText('Playhead')
    fireEvent.change(slider, { target: { value: String(T0 + 350) } })
    await waitFor(() => expect(screen.getByTestId('replay-transcript').textContent).toBe('user: fix it\nassistant: editing'))
    expect(screen.getByText('No checkpoint before this moment.')).toBeTruthy()
    expect(screen.getByTestId('replay-playhead').textContent).toContain('Tools & receipts: Tool call: Edit')
    expect(screen.getByText('Tools & receipts (1/1)')).toBeTruthy()
    expect(screen.getByText('File changes (0/1)')).toBeTruthy()
    expect(calls.some((c) => c.url.includes(`t=${T0 + 350}`))).toBe(true)

    fireEvent.click(screen.getByTestId('replay-tick-event:3'))
    expect((await screen.findByTestId('replay-diff')).textContent).toBe('-old\n+new')
    expect(screen.getByText('Checkpoint #4: changes since #3')).toBeTruthy()
  })

  it('"Rewind to here" delegates to the checkpoint API: preview, then POST rewind with that seq', async () => {
    const calls = stubApi()
    render(<ReplayDialog workspaceId="ws-1" nodes={[]} onClose={() => {}} now={NOW} />)
    fireEvent.click(await screen.findByTestId('replay-tick-event:3'))
    fireEvent.click(await screen.findByRole('button', { name: 'Rewind' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Rewind files' }))
    expect(await screen.findByText('Rewound: 1 restored, 0 deleted. Undo with checkpoint #5.')).toBeTruthy()
    expect(calls.some((c) => c.url === '/api/checkpoints/preview?workspace=ws-1&seq=4')).toBe(true)
    expect(calls.find((c) => c.method === 'POST')).toEqual({ url: '/api/checkpoints/rewind', method: 'POST', body: { workspace: 'ws-1', seq: 4 } })
    expect(calls.some((c) => c.url.startsWith('/api/replay') && c.method === 'POST')).toBe(false)
  })

  it('geometry and ranges', () => {
    expect(pct(150, 100, 200)).toBe(50)
    expect(pct(5, 5, 5)).toBe(0)
    expect(rangeFrom('all', NOW())).toBe(0)
    expect(rangeFrom('hour', NOW())).toBe(NOW() - 3_600_000)
  })
})
