/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../shared/workspace'
import { buildContext, type TimelineEvent } from './Timeline.model'
import { checkpointTarget, checkpointText, rewindLabel, RewindControl } from './Timeline.checkpoint'

const ev = (kind: string, patch: Partial<TimelineEvent> = {}): TimelineEvent => ({ // test-only
  seq: 1, ts: 0, kind, source: 'test', actor: 'test', subject: null, workspaceId: 'w1', nodeId: null,
  trust: 'trusted', dedupeKey: null, payload: null, prevHash: '', hash: '', ...patch,
})
const WS: Workspace[] = [{ id: 'w1', name: 'Repo', cwd: '/repo', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0, nodes: [] }]
const ctx = buildContext(WS)

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('checkpoint lines', () => {
  it('words checkpoint events and exposes the rewind target', () => {
    const created = ev('checkpoint.created', { payload: { seq: 3, reason: 'prompt' } })
    expect(checkpointText(created)).toBe('Checkpoint #3 before agent prompt')
    expect(checkpointTarget(created)).toEqual({ workspaceId: 'w1', seq: 3 })
    expect(checkpointText(ev('checkpoint.rewound', { payload: { seq: 3, undoSeq: 4 } }))).toBe('Rewound files to checkpoint #3 (undo: #4)')
    expect(checkpointTarget(ev('hook.Stop'))).toBeNull()
    expect(checkpointText(ev('hook.Stop'))).toBeNull()
  })

  it('labels what cannot be rewound', () => {
    expect(rewindLabel(ev('checkpoint.unavailable', { payload: { why: 'not_git' } }), ctx)).toBe('Not rewindable: not a git repo')
    expect(rewindLabel(ev('hook.PostToolUse', { payload: { toolName: 'WebFetch' } }), ctx)).toBe('Not rewindable: network side effect')
    expect(rewindLabel(ev('hook.PostToolUse', { payload: { toolName: 'mcp__webterm__send' } }), ctx)).toBe('Not rewindable: network side effect')
    expect(rewindLabel(ev('fs.change', { workspaceId: null, payload: { dir: '/elsewhere' } }), ctx)).toBe('Not rewindable: outside any workspace')
    expect(rewindLabel(ev('fs.change', { payload: { dir: '/repo/src' } }), ctx)).toBeNull()
    expect(rewindLabel(ev('hook.PostToolUse', { payload: { toolName: 'Bash' } }), ctx)).toBeNull()
  })
})

describe('RewindControl', () => {
  it('previews the diff, confirms, then reports the undo checkpoint', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
      const body = url.includes('/preview')
        ? { files: [{ status: 'M', path: 'a.txt' }, { status: 'D', path: 'made-by-bash.txt' }], patch: '-shell edit\n+one\n', truncated: false }
        : { written: 1, deleted: 1, undoSeq: 4 }
      return { ok: true, status: 200, json: async () => body }
    }))
    render(<RewindControl workspaceId="w1" seq={3} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rewind' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rewind to checkpoint #3' })
    expect(dialog.textContent).toContain('revert a.txt')
    expect(dialog.textContent).toContain('delete made-by-bash.txt')
    expect(dialog.textContent).toContain('not restored')
    fireEvent.click(screen.getByRole('button', { name: 'Rewind files' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Rewound: 1 restored, 1 deleted. Undo with checkpoint #4.'))
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/checkpoints/preview?workspace=w1&seq=3', 'POST /api/checkpoints/rewind'])
    expect(JSON.parse(calls[1]!.body!)).toEqual({ workspace: 'w1', seq: 3 })
  })

  it('cancel sends nothing', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ files: [], patch: '', truncated: false }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<RewindControl workspaceId="w1" seq={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rewind' }))
    await screen.findByRole('dialog')
    expect(screen.getByRole('button', { name: 'Rewind files' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Rewind' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
