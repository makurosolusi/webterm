/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineEvent } from './Timeline.model'
import { TimelinePanel } from './Timeline.panel'
import { resetUndone } from './Timeline.auto'

// test-only: a fixed feed instead of the live stream.
let events: TimelineEvent[] = []
vi.mock('./Timeline.stream', () => ({
  useTimelineFeed: () => ({ events, epoch: 0, connection: 'open', error: null, more: false, loadingOlder: false, loadOlder: async () => undefined }),
}))
vi.mock('./Timeline.status', async (orig) => ({
  ...(await orig<typeof import('./Timeline.status')>()),
  useTimelineStatus: () => ({ control: null, integrity: { state: 'unknown' } }),
}))

const ev = (seq: number, kind: string, payload: unknown, nodeId: string | null = null): TimelineEvent => ({ // test-only
  seq, ts: 1000 + seq, kind, source: kind.startsWith('auto.') ? 'auto' : 'hook', actor: 'test', subject: null, workspaceId: null, nodeId,
  trust: 'trusted', dedupeKey: null, payload, prevHash: '', hash: '',
})
const UNDO = { label: 'Reopen task', method: 'POST', path: '/api/work/t1/reopen', body: { id: 't1' } }

const panel = () => render(<TimelinePanel workspaces={[]} onFocusNode={() => undefined} />)

beforeEach(() => {
  resetUndone()
  events = [ev(1, 'hook.Stop', null, 'n1'), ev(2, 'auto.task_done', { text: 'Marked task done', undo: UNDO })]
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('automatic actions in the Activity panel', () => {
  it('the Automatic filter keeps only auto.* lines, tagged Automatic', () => {
    panel()
    expect(screen.getByText('Marked task done')).not.toBeNull()
    expect(screen.getByText('Automatic', { selector: '.timeline-auto-tag' })).not.toBeNull()
    fireEvent.change(screen.getByLabelText('Filter by kind'), { target: { value: 'auto' } })
    expect(screen.getByText('Marked task done')).not.toBeNull()
    expect(screen.queryByText(/finished a turn/)).toBeNull()
  })

  it('Undo POSTs the request, then the line shows Undone and the button is gone (kept across remount)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    panel()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen task' }))
    expect(screen.getByRole('button', { name: /Undoing/ })).not.toBeNull()
    await waitFor(() => expect(screen.getByText('Undone')).not.toBeNull())
    expect(screen.queryByRole('button', { name: 'Reopen task' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/work/t1/reopen', expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: 't1' }) }))
    cleanup()
    panel()
    expect(screen.getByText('Undone')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Reopen task' })).toBeNull()
  })

  it('a failed Undo shows the server reason and Retry runs it again', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'task already closed by user' }), { status: 409 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    panel()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen task' }))
    expect(await screen.findByText('Reopen task failed: task already closed by user', { selector: '[role=alert] > span' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Reopen task' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('Undone')).not.toBeNull())
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
