/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../shared/workspace'
import { TimelinePanel } from './Timeline.panel'
import type { TimelineEvent } from './Timeline.model'

/** Visible tooltip of `el` (focus opens it); the label is the tooltip, not a native `title`. */
const tipOf = (el: Element): string | null => {
  fireEvent.keyDown(document, { key: 'Tab' }) // keyboard navigation: focus alone does not open a tooltip
  fireEvent.focus(el)
  const text = document.querySelector('[role="tooltip"]')?.textContent ?? null
  fireEvent.blur(el)
  return text
}

// test-only fakes: a controllable EventSource and an in-memory /api/events + /api/central server.
class FakeES {
  static all: FakeES[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  private handlers = new Map<string, (m: MessageEvent) => void>()
  constructor(readonly url: string) { FakeES.all.push(this) }
  addEventListener(type: string, h: (m: MessageEvent) => void): void { this.handlers.set(type, h) }
  close(): void { this.closed = true }
  emit(e: TimelineEvent): void { this.handlers.get('sense')?.({ data: JSON.stringify(e) } as MessageEvent) }
  static last(): FakeES { return FakeES.all[FakeES.all.length - 1]! }
}

let seq = 0
const ev = (kind: string, patch: Partial<TimelineEvent> = {}): TimelineEvent => ({
  seq: ++seq, ts: Date.UTC(2026, 10, 4, 10, 0, seq), kind, source: 'test', actor: 'test', subject: null, workspaceId: null,
  nodeId: null, trust: 'trusted', dedupeKey: null, payload: null, prevHash: '', hash: '', ...patch,
})
const WS: Workspace[] = [{
  id: 'w1', name: 'Webterm', cwd: '/repo/webterm', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0,
  nodes: [{ id: 'n1', kind: 'terminal', x: 0, y: 0, title: 'brisk-otter' }, { id: 'b1', kind: 'browser', x: 0, y: 0, title: 'makuro-browser' }],
}, {
  id: 'w2', name: 'Docs', cwd: '/repo/docs', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0,
  nodes: [{ id: 'n2', kind: 'terminal', x: 0, y: 0, title: 'calm-heron' }],
}]

interface Server { history: TimelineEvent[]; more: boolean; head: unknown; control: unknown; calls: string[] }
let server: Server

beforeEach(() => {
  seq = 0
  FakeES.all = []
  server = {
    history: [], more: false, calls: [],
    head: { head: { seq: 1 }, anchorStatus: 'match', startStatus: 'match', verify: { ok: true } },
    control: { ceiling: 'act_envelope', global: { level: 'act_gated' }, projects: [{ scope: 'project:w1', level: 'observe' }] },
  }
  vi.stubGlobal('EventSource', FakeES)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    server.calls.push(url)
    const u = new URL(url, 'http://localhost')
    let body: unknown = {}
    if (u.pathname === '/api/events/history') {
      const before = Number(u.searchParams.get('beforeSeq') ?? Infinity)
      const below = server.history.filter((e) => e.seq < before)
      body = { events: below.slice(-2), more: below.length > 2 }
    } else if (u.pathname === '/api/events/head') body = server.head
    else if (u.pathname === '/api/central/control') body = server.control
    return { ok: true, status: 200, json: async () => body }
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const groupLabels = (): string[] => [...document.querySelectorAll('.timeline-group__label')].map((n) => n.textContent ?? '')
const lineTexts = (): string[] => [...document.querySelectorAll('.timeline-text')].map((n) => n.textContent ?? '')

async function mount(onFocusNode = vi.fn()) {
  render(<TimelinePanel workspaces={WS} onFocusNode={onFocusNode} />)
  await waitFor(() => expect(FakeES.all).toHaveLength(1))
  act(() => FakeES.last().onopen?.())
  return onFocusNode
}

describe('TimelinePanel', () => {
  it('renders history grouped by task, with readable lines and a level badge', async () => {
    server.history = [
      ev('hook.UserPromptSubmit', { nodeId: 'n1', workspaceId: 'w1', payload: { preview: 'fix it' } }),
      ev('hook.Stop', { nodeId: 'n1', workspaceId: 'w1' }),
    ]
    await mount()
    await waitFor(() => expect(groupLabels()).toEqual(['brisk-otter: fix it']))
    expect(lineTexts()).toEqual(['brisk-otter received a prompt', 'brisk-otter finished a turn'])
    await waitFor(() => expect(document.querySelector('.timeline-level')?.textContent).toBe('L1'))
  })

  it('appends live events and resumes from the last seq after a reconnect', async () => {
    server.history = [ev('hook.Stop', { nodeId: 'n1' })]
    await mount()
    await waitFor(() => expect(lineTexts()).toEqual(['brisk-otter finished a turn']))
    expect(FakeES.last().url).toBe('/api/events/stream?afterSeq=1')
    act(() => FakeES.last().emit(ev('edge.change', { workspaceId: 'w1', payload: { changes: [{ nodeId: 'n1', added: ['b1'], removed: [], renamed: [] }] } })))
    await waitFor(() => expect(lineTexts()).toContain('Cable: brisk-otter ↔ makuro-browser connected'))

    vi.useFakeTimers()
    try {
      act(() => FakeES.last().onerror?.())
      expect(FakeES.all[0]!.closed).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    } finally { vi.useRealTimers() }
    expect(FakeES.all).toHaveLength(2)
    expect(FakeES.last().url).toBe('/api/events/stream?afterSeq=2')
    // A replayed duplicate is not shown twice.
    act(() => FakeES.last().emit({ ...ev('hook.Stop', { nodeId: 'n1' }), seq: 1 }))
    expect(lineTexts().filter((t) => t === 'brisk-otter finished a turn')).toHaveLength(1)
  })

  it('filters by workspace, kind and agent', async () => {
    server.history = [ev('hook.Stop', { nodeId: 'n1' }), ev('pty.exit', { nodeId: 'n2', payload: { code: 0, reason: 'self' } })]
    await mount()
    await waitFor(() => expect(lineTexts()).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Filter by workspace'), { target: { value: 'w2' } })
    expect(lineTexts()).toEqual(['calm-heron exited (code 0)'])
    fireEvent.change(screen.getByLabelText('Filter by workspace'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Filter by kind'), { target: { value: 'hook' } })
    expect(lineTexts()).toEqual(['brisk-otter finished a turn'])
    fireEvent.change(screen.getByLabelText('Filter by kind'), { target: { value: 'all' } })
    fireEvent.change(screen.getByLabelText('Filter by agent'), { target: { value: 'n2' } })
    expect(lineTexts()).toEqual(['calm-heron exited (code 0)'])
  })

  it('clicking a line or a group header focuses the node', async () => {
    server.history = [ev('hook.Stop', { nodeId: 'n2' })]
    const onFocus = await mount()
    await waitFor(() => expect(lineTexts()).toHaveLength(1))
    fireEvent.click(screen.getByText('calm-heron finished a turn'))
    expect(onFocus).toHaveBeenLastCalledWith('n2')
    fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'node' } })
    expect(tipOf(screen.getByRole('button', { name: 'calm-heron' }))).toBe('Focus this node on the canvas')
    fireEvent.click(screen.getByRole('button', { name: 'calm-heron' }))
    expect(onFocus).toHaveBeenCalledTimes(2)
  })

  it('shows a warning when the anchor diverged, green when verified', async () => {
    server.head = { head: { seq: 3 }, anchorStatus: 'rewritten', startStatus: 'match', verify: { ok: true } }
    await mount()
    await waitFor(() => expect(screen.getByRole('status').getAttribute('data-state')).toBe('warning'))
    expect(screen.getByRole('status').textContent).toBe('Chain warning')
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Chain warning: Anchor diverged: rewritten')
    cleanup()
    server.head = { head: { seq: 3 }, anchorStatus: 'match', startStatus: 'match', verify: { ok: true } }
    await mount()
    await waitFor(() => expect(screen.getByRole('status').getAttribute('data-state')).toBe('ok'))
  })

  it('loads older history pages with beforeSeq', async () => {
    server.history = [ev('hook.Stop', { nodeId: 'n1' }), ev('hook.Stop', { nodeId: 'n2' }), ev('pty.exit', { nodeId: 'n1', payload: { reason: 'closed' } })]
    await mount()
    await waitFor(() => expect(lineTexts()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }))
    await waitFor(() => expect(lineTexts()).toContain('brisk-otter finished a turn'))
    expect(server.calls).toContain('/api/events/history?limit=100&beforeSeq=2')
    expect(screen.queryByRole('button', { name: 'Load older activity' })).toBeNull()
  })

  it('checkpoint lines get a Rewind button; non-git workspaces get a "not rewindable" label', async () => {
    server.history = [
      ev('checkpoint.created', { nodeId: 'n1', workspaceId: 'w1', payload: { seq: 2, reason: 'prompt', rewindable: true } }),
      ev('checkpoint.unavailable', { workspaceId: 'w2', payload: { why: 'not_git', rewindable: false } }),
    ]
    await mount()
    await waitFor(() => expect(lineTexts()).toEqual(expect.arrayContaining(['Checkpoint #2 before agent prompt', 'No checkpoint: workspace folder is not a git repository'])))
    expect(screen.getAllByRole('button', { name: 'Rewind' })).toHaveLength(1)
    expect(screen.getByText('Not rewindable: not a git repo')).toBeTruthy()
  })
})
