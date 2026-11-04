/** @vitest-environment jsdom */
// Diff node DOM: file list with status, secret files never get an editor, a wired agent supplies
// the root and receives the notes batch. API, Monaco and the socket are faked.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, useNodesState, type Edge, type Node } from '@xyflow/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const api = vi.hoisted(() => ({ fetchDiffList: vi.fn(), fetchFileDiff: vi.fn(), undoHunk: vi.fn() }))
vi.mock('./DiffNode.api', () => api)
const ws = vi.hoisted(() => ({ send: vi.fn(), getStatus: vi.fn(() => undefined), subscribeStatus: vi.fn(() => () => {}) }))
vi.mock('./ws', () => ws)
const monaco = vi.hoisted(() => {
  const ed = { createDecorationsCollection: () => ({ set: () => {} }), onDidChangeCursorPosition: () => ({ dispose: () => {} }) }
  return {
    created: 0,
    m: {
      Uri: { parse: (s: string) => s },
      editor: {
        createModel: () => ({ dispose: () => {} }),
        createDiffEditor: () => { monaco.created++; return { setModel: () => {}, getModifiedEditor: () => ed, dispose: () => {} } },
      },
    },
  }
})
vi.mock('./lazyMonaco', () => ({ loadMonaco: () => Promise.resolve(monaco.m) }))

import DiffNode from './DiffNode'

// test-only: jsdom has no ResizeObserver; React Flow renders unmeasured nodes, which is all this needs.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
afterEach(() => { cleanup(); vi.clearAllMocks(); monaco.created = 0 })

const LIST = {
  root: '/repo', total: 3, nextOffset: null,
  files: [
    { path: '.env', status: 'modified', binary: false, sensitive: true },
    { path: 'a.ts', status: 'modified', binary: false, sensitive: false },
    { path: 'new.png', status: 'added', binary: true, sensitive: false },
  ],
}
const A_TS = { ...LIST.files[1], original: 'x\n', modified: 'y\n', truncated: false, undoable: true, hunks: [{ id: 'h1', header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] }

const nodeTypes = { diff: DiffNode, agent: () => null }
let latest: Node[] = []

/** A controlled canvas like App's: `updateNodeData` round-trips through `onNodesChange`. */
function Canvas({ init, edges }: { init: Node[]; edges: Edge[] }) {
  const [nodes, , onNodesChange] = useNodesState(init)
  latest = nodes
  return <div style={{ width: 800, height: 600 }}><ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} nodeTypes={nodeTypes} /></div>
}

function mount(data: Record<string, unknown>, extra: { nodes?: Node[]; edges?: Edge[] } = {}) {
  const self: Node = { id: 'd1', type: 'diff', position: { x: 0, y: 0 }, data, width: 600, height: 400 }
  return render(<ReactFlowProvider><Canvas init={[self, ...(extra.nodes ?? [])]} edges={extra.edges ?? []} /></ReactFlowProvider>)
}

describe('DiffNode', () => {
  it('renders the changed files with their status', async () => {
    api.fetchDiffList.mockResolvedValue(LIST)
    const { container } = mount({ cwd: '/repo' })
    await waitFor(() => expect(container.querySelectorAll('.diff-node__file')).toHaveLength(3))
    expect(api.fetchDiffList).toHaveBeenCalledWith('/repo', 0)
    expect([...container.querySelectorAll('.diff-node__status')].map((e) => e.textContent)).toEqual(['M', 'M', 'A'])
    expect(screen.getByLabelText('Secret file, contents hidden')).toBeTruthy()
  })

  it('never opens an editor for a sensitive file', async () => {
    api.fetchDiffList.mockResolvedValue(LIST)
    api.fetchFileDiff.mockResolvedValue({ ...LIST.files[0], original: '', modified: '', truncated: false, hunks: [], undoable: false })
    mount({ cwd: '/repo' })
    fireEvent.click(await screen.findByText('.env'))
    await screen.findByText(/Contents hidden/)
    expect(monaco.created).toBe(0)
  })

  it('uses the wired agent cwd and sends the notes to it as one message', async () => {
    api.fetchDiffList.mockResolvedValue(LIST)
    api.fetchFileDiff.mockResolvedValue(A_TS)
    mount({}, {
      nodes: [{ id: 'ag', type: 'agent', position: { x: 0, y: 0 }, data: { agentId: 'claude', cwd: '/repo' } }],
      edges: [{ id: 'e', source: 'ag', target: 'd1' }],
    })
    await waitFor(() => expect(api.fetchDiffList).toHaveBeenCalledWith('/repo', 0))
    fireEvent.click(await screen.findByText('a.ts'))
    await waitFor(() => expect(monaco.created).toBe(1))
    expect(screen.getByText('@@ -1 +1 @@')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Note on line 1'), { target: { value: 'why y?' } })
    fireEvent.click(screen.getByText('Add note'))
    const saved = () => (latest.find((n) => n.id === 'd1')?.data as { diffNotes?: { path: string; line: number; body: string }[] }).diffNotes
    await waitFor(() => expect(saved()).toEqual([expect.objectContaining({ path: 'a.ts', line: 1, body: 'why y?' })]))
    fireEvent.click(await screen.findByText('Send to agent (1)'))
    await waitFor(() => expect(ws.send).toHaveBeenCalledTimes(2))
    const [paste, enter] = ws.send.mock.calls.map((c) => (c as unknown as [{ id: string; data: string }])[0])
    expect(paste.id).toBe('ag')
    expect(paste.data).toContain('File: a.ts\nLine: 1\nUser comment: "why y?"')
    expect(enter).toEqual({ t: 'input', id: 'ag', data: '\r' })
    await screen.findByText('Sent 1 note to the agent.')
    expect(saved()).toEqual([])
  })

  it('refreshes when the wired agent ends its turn', async () => {
    api.fetchDiffList.mockResolvedValue(LIST)
    let onStatus: (id: string, st: string | undefined) => void = () => {}
    ws.subscribeStatus.mockImplementation(((cb: typeof onStatus) => { onStatus = cb; return () => {} }) as never)
    mount({}, {
      nodes: [{ id: 'ag', type: 'agent', position: { x: 0, y: 0 }, data: { agentId: 'claude', cwd: '/repo' } }],
      edges: [{ id: 'e', source: 'ag', target: 'd1' }],
    })
    await waitFor(() => expect(api.fetchDiffList).toHaveBeenCalledTimes(1))
    onStatus('ag', 'working')
    onStatus('other', 'waiting')
    expect(api.fetchDiffList).toHaveBeenCalledTimes(1)
    onStatus('ag', 'waiting')
    await waitFor(() => expect(api.fetchDiffList).toHaveBeenCalledTimes(2))
  })

  it('asks before undoing a hunk, and calls the API only when confirmed', async () => {
    api.fetchDiffList.mockResolvedValue(LIST)
    api.fetchFileDiff.mockResolvedValue(A_TS)
    api.undoHunk.mockResolvedValue(undefined)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    mount({ cwd: '/repo' })
    fireEvent.click(await screen.findByText('a.ts'))
    fireEvent.click(await screen.findByText('Undo'))
    expect(api.undoHunk).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Undo'))
    await waitFor(() => expect(api.undoHunk).toHaveBeenCalledWith('/repo', 'a.ts', 'h1'))
    expect(confirm).toHaveBeenCalledTimes(2)
  })
})
