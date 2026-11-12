/** @vitest-environment jsdom */
// Diff node DOM: file list with status, secret files never get an editor, a wired agent supplies
// the root and receives the notes batch through the outbox. API, Monaco, fetch and the socket are faked.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, useNodesState, type Edge, type Node } from '@xyflow/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const api = vi.hoisted(() => ({ fetchDiffList: vi.fn(), fetchFileDiff: vi.fn(), undoHunk: vi.fn() }))
vi.mock('./DiffNode.api', () => api)
const ws = vi.hoisted(() => ({ send: vi.fn(), getStatus: vi.fn(() => undefined), subscribeStatus: vi.fn(() => () => {}) }))
vi.mock('./ws', () => ws)
const monaco = vi.hoisted(() => {
  const ed = { createDecorationsCollection: () => ({ set: () => {} }), onDidChangeCursorPosition: () => ({ dispose: () => {} }), addAction: () => ({ dispose: () => {} }) }
  return {
    created: 0,
    wrap: [] as string[],
    m: {
      Uri: { parse: (s: string) => s },
      KeyMod: { Alt: 512 }, KeyCode: { KeyZ: 56 },
      editor: {
        createModel: () => ({ dispose: () => {} }),
        createDiffEditor: () => { monaco.created++; return { setModel: () => {}, getModifiedEditor: () => ed, getOriginalEditor: () => ed, updateOptions: (o: { wordWrap: string }) => monaco.wrap.push(o.wordWrap), dispose: () => {} } },
      },
    },
  }
})
vi.mock('./lazyMonaco', () => ({ loadMonaco: () => Promise.resolve(monaco.m) }))

import DiffNode from './DiffNode'
import { NodeHostContext } from './tabLayout.context'
import { setEditorActionsSlot, tabNodeMenuItems } from './tabLayout.nodeActions'

// test-only: jsdom has no ResizeObserver; React Flow renders unmeasured nodes, which is all this needs.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); ws.getStatus.mockReturnValue(undefined); monaco.created = 0; monaco.wrap.length = 0 })

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

function mount(data: Record<string, unknown>, extra: { nodes?: Node[]; edges?: Edge[]; inTab?: boolean } = {}) {
  const self: Node = { id: 'd1', type: 'diff', position: { x: 0, y: 0 }, data, width: 600, height: 400 }
  return render(
    <ReactFlowProvider>
      <div ref={setEditorActionsSlot} data-slot="tab-editor-actions" />
      <NodeHostContext.Provider value={{ inTab: !!extra.inTab, visible: true, maximized: false }}>
        <Canvas init={[self, ...(extra.nodes ?? [])]} edges={extra.edges ?? []} />
      </NodeHostContext.Provider>
    </ReactFlowProvider>,
  )
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

  it('uses the wired agent cwd and queues the notes in the outbox as one message, even while it works', async () => {
    api.fetchDiffList.mockResolvedValue(LIST)
    api.fetchFileDiff.mockResolvedValue(A_TS)
    ws.getStatus.mockReturnValue('working' as never) // busy agent: queued, not refused
    const posts: Array<{ url: string; body: { to: string; body: string; operationId: string } }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ message: { id: 'm1', status: 'queued' }, deduped: false }), { status: 202 })
    }))
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
    await screen.findByText(/Queued 1 note for the agent/)
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toMatch(/^\/api\/outbox/)
    expect(posts[0].body.to).toBe('ag')
    expect(posts[0].body.body).toContain('File: a.ts\nLine: 1\nUser comment: "why y?"')
    expect(ws.send).not.toHaveBeenCalled() // nothing typed from the client any more
    expect(saved()).toEqual([])
  })

  it('word wrap: off for code by default, toggled live and stored on the node', async () => {
    api.fetchDiffList.mockResolvedValue(LIST)
    api.fetchFileDiff.mockResolvedValue(A_TS)
    const { container } = mount({ cwd: '/repo' })
    fireEvent.click(await screen.findByText('a.ts'))
    await waitFor(() => expect(monaco.wrap).toEqual(['off']))
    fireEvent.click(container.querySelector('vscode-toolbar-button[data-title^="Toggle word wrap"]')!)
    await waitFor(() => expect(monaco.wrap.at(-1)).toBe('on'))
    expect((latest.find((n) => n.id === 'd1')?.data as { wordWrap?: boolean }).wordWrap).toBe(true)
    expect(monaco.created).toBe(1)
  })

  it('keeps the notes and shows the reason when the outbox refuses', async () => {
    api.fetchDiffList.mockResolvedValue(LIST)
    api.fetchFileDiff.mockResolvedValue(A_TS)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad_target', message: 'node not found' }), { status: 404 })))
    mount({ diffNotes: [{ id: 'n1', path: 'a.ts', line: 1, body: 'x' }] }, {
      nodes: [{ id: 'ag', type: 'agent', position: { x: 0, y: 0 }, data: { agentId: 'claude', cwd: '/repo' } }],
      edges: [{ id: 'e', source: 'ag', target: 'd1' }],
    })
    fireEvent.click(await screen.findByText('Send to agent (1)'))
    expect(screen.getByText('Sending…').getAttribute('aria-busy')).toBe('true')
    await screen.findByText('Send review notes to ag: node not found', { selector: '[data-action-result="failed"] span' })
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect((latest.find((n) => n.id === 'd1')?.data as { diffNotes: unknown[] }).diffNotes).toHaveLength(1)
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

describe('DiffNode in tab mode', () => {
  const strip = () => within(document.querySelector<HTMLElement>('[data-slot="tab-editor-actions"]')!)
  it('renders no own header; Send to agent and Refresh sit in the strip and the tab menu', async () => {
    api.fetchDiffList.mockResolvedValue(LIST)
    const { container } = mount({ cwd: '/repo' }, { inTab: true })
    await waitFor(() => expect(container.querySelectorAll('.diff-node__file')).toHaveLength(3))
    expect(container.querySelector('.diff-node .node-header')).toBeNull()
    expect(container.querySelector('.diff-node .codicon-close')).toBeNull()
    expect(strip().getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Send to agent (0)', 'Refresh'])
    expect(tabNodeMenuItems('d1').map((r) => (r.type === 'item' ? r.label : r.type))).toEqual(['Send to agent (0)', 'Refresh'])
    fireEvent.click(strip().getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(api.fetchDiffList).toHaveBeenCalledTimes(2))
    // No agent wired: the click's refusal shows as the node message, as from the header.
    fireEvent.click(strip().getByRole('button', { name: 'Send to agent (0)' }))
    expect(container.querySelector('.diff-node__msg')?.textContent).toBeTruthy()
  })

  it('keeps its own header on the canvas and publishes nothing', async () => {
    api.fetchDiffList.mockResolvedValue(LIST)
    const { container } = mount({ cwd: '/repo' })
    await waitFor(() => expect(container.querySelectorAll('.diff-node__file')).toHaveLength(3))
    expect(container.querySelector('.diff-node .node-header .codicon-close')).not.toBeNull()
    expect(strip().queryAllByRole('button')).toHaveLength(0)
    expect(tabNodeMenuItems('d1')).toEqual([])
  })
})
