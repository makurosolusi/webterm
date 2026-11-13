/** @vitest-environment jsdom */
// Editor node states and header (file-node audit): Preview only for Markdown, a loading bar, Retry on
// read failure, actions on the size refusal, Compare in the conflict bar, a workspace-relative
// breadcrumb, typed icon colours, and "Open as Text" / size facts from the viewer.
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps } from '@xyflow/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import { tooLargeSentinel } from '../shared/fsLimits'

const fake = vi.hoisted(() => {
  const state = { value: 'a', onChange: () => {}, save: () => {}, created: 0, diff: null as null | { original: string; modified: string } }
  const sub = () => ({ dispose: () => {} })
  const editor = {
    getValue: () => state.value,
    setValue: (v: string) => { state.value = v; state.onChange() },
    onDidChangeModelContent: (cb: () => void) => { state.onChange = cb },
    addAction: (d: { id: string; run: () => void }) => { if (d.id === 'webterm.editor.save') state.save = d.run; return { dispose: () => {} } },
    updateOptions: () => {},
    getModel: () => null,
    onDidChangeCursorSelection: sub, onDidChangeModelOptions: sub, onDidChangeModelLanguage: sub,
    dispose: () => {},
  }
  const side = { onDidChangeCursorPosition: sub, createDecorationsCollection: () => ({ set: () => {} }), addAction: sub, updateOptions: () => {} }
  const monaco = {
    Uri: { file: () => ({ with: () => 'uri' }), parse: (s: string) => s },
    KeyMod: { CtrlCmd: 1, Alt: 4 }, KeyCode: { KeyS: 2, KeyZ: 8 },
    editor: {
      getModel: () => null,
      createModel: (text: string) => ({ text, dispose: () => {} }),
      create: () => { state.created++; return editor },
      createDiffEditor: () => ({
        setModel: (m: { original: { text: string }; modified: { text: string } }) => { state.diff = { original: m.original.text, modified: m.modified.text } },
        getModifiedEditor: () => side, getOriginalEditor: () => side, updateOptions: () => {}, dispose: () => {},
      }),
      setTheme: () => {},
    },
  }
  return { state, monaco }
})
vi.mock('./lazyMonaco', () => ({ loadMonaco: () => Promise.resolve(fake.monaco) }))
vi.mock('./clipboard', () => ({ writeClipboard: vi.fn(() => Promise.resolve(true)) }))
vi.mock('./fsClient', () => ({
  capabilities: () => Promise.resolve({ mutate: false, viewers: true, watch: false, git: false, quickOpen: false, upload: false, listMax: 10 }),
  rawUrl: (p: string) => p,
  stat: () => Promise.resolve({ ok: false, code: 'ENOENT', error: 'x' }),
  readMeta: () => Promise.reject(new Error('unused')),
  writeChecked: () => Promise.reject(new Error('unused')),
}))
// The viewer is the other worker's; here only the props EditorNode hands it matter.
const viewer = vi.hoisted(() => ({ props: null as null | { onOpenAsText?: () => void; onMeta?: (m: { width?: number; height?: number; bytes?: number }) => void } }))
vi.mock('./viewers/ViewerHost', () => ({ ViewerHost: (p: typeof viewer.props) => { viewer.props = p; return <div data-testid="viewer" /> } }))

import EditorNode from './EditorNode'

// test-only: jsdom has no ResizeObserver.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
afterEach(() => { cleanup(); fake.state.value = 'a'; fake.state.created = 0; fake.state.diff = null; viewer.props = null })

type Meta = { content: string; version: string; encoding: 'utf8' }
const META: Meta = { content: 'a', version: 'v1', encoding: 'utf8' }

function mount(path: string, opts: { readMeta?: () => Promise<Meta>; writeChecked?: () => Promise<unknown>; nodes?: Node[]; edges?: Edge[] } = {}) {
  const readMeta = vi.fn(opts.readMeta ?? (() => Promise.resolve(META)))
  const writeChecked = opts.writeChecked ?? (() => Promise.resolve({ ok: true, version: 'v2' }))
  // A real flow, so `updateNodeData` (Open as Text) reaches the node's props as in the app.
  const nodeTypes = {
    editor: (p: NodeProps) => <EditorNode {...(p as ComponentProps<typeof EditorNode>)} readMeta={readMeta} writeChecked={writeChecked as never} />,
    files: () => null,
  }
  const node: Node = { id: 'n1', type: 'editor', position: { x: 0, y: 0 }, width: 600, height: 400, data: { filePath: path } }
  const r = render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}>
        <ReactFlow defaultNodes={[node, ...(opts.nodes ?? [])]} defaultEdges={opts.edges ?? []} nodeTypes={nodeTypes} />
      </div>
    </ReactFlowProvider>,
  )
  return { ...r, readMeta }
}
const ready = () => waitFor(() => expect(fake.state.created).toBeGreaterThan(0))
const header = () => within(document.querySelector<HTMLElement>('.editor-node .node-header')!)

describe('Markdown preview toggle', () => {
  it('is not offered for a YAML file', async () => {
    mount('/x/compose.yml')
    await ready()
    expect(header().queryByRole('button', { name: 'Preview' })).toBeNull()
    expect(header().getByRole('button', { name: 'Word wrap' })).toBeTruthy()
  })

  it('is offered for Markdown and opens the preview', async () => {
    const { container } = mount('/x/README.md')
    await ready()
    const btn = header().getByRole('button', { name: 'Preview' })
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(btn)
    expect(container.querySelector('.editor-node__md')).not.toBeNull()
    expect(header().getByRole('button', { name: 'Edit' }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('load states', () => {
  it('shows a progress bar until the file is open', async () => {
    let resolve!: (m: Meta) => void
    const { container } = mount('/x/a.ts', { readMeta: () => new Promise((r) => { resolve = r }) })
    expect(container.querySelector('vscode-progress-bar')).not.toBeNull()
    await act(async () => resolve(META))
    await ready()
    expect(container.querySelector('vscode-progress-bar')).toBeNull()
  })

  it('a failed read offers Retry, which reads again and opens the editor', async () => {
    let calls = 0
    const { readMeta } = mount('/x/a.ts', { readMeta: () => (++calls === 1 ? Promise.reject(new Error('EACCES')) : Promise.resolve(META)) })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t open a.ts: EACCES')
    expect(within(alert).getByText('Copy Path')).toBeTruthy()
    fireEvent.click(within(alert).getByText('Retry'))
    await ready()
    expect(readMeta).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a file over the size cap is refused with Retry and Copy Path, never an empty editor', async () => {
    mount('/x/big.log', { readMeta: () => Promise.resolve({ ...META, content: tooLargeSentinel(20 * 1024 * 1024) }) })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('File too large to open here (20.0 MB).')
    expect(within(alert).getByText('Retry')).toBeTruthy()
    expect(within(alert).getByText('Copy Path')).toBeTruthy()
    expect(fake.state.created).toBe(0)
  })
})

describe('conflict Compare', () => {
  it('opens the disk version against the buffer, and closes when the conflict is resolved', async () => {
    let reads = 0
    const { container } = mount('/x/app.json', {
      readMeta: () => Promise.resolve(++reads === 1 ? META : { content: 'disk', version: 'v9', encoding: 'utf8' }),
      writeChecked: () => Promise.resolve({ ok: false, code: 'EVERSION', error: 'changed', current: 'v9' }),
    })
    await ready()
    fake.state.value = 'mine'
    act(() => fake.state.onChange())
    act(() => fake.state.save())
    fireEvent.click(await screen.findByText('Compare'))
    expect(await screen.findByRole('region', { name: 'Compare app.json' })).toBeTruthy()
    await waitFor(() => expect(fake.state.diff).toEqual({ original: 'disk', modified: 'mine' }))
    fireEvent.click(screen.getByText('Reload'))
    await waitFor(() => expect(container.querySelector('.editor-node__compare')).toBeNull())
  })
})

describe('title and breadcrumb', () => {
  it('title truncates in an inner label span and the icon carries the type colour', async () => {
    const { container } = mount('/x/app.ts')
    await ready()
    expect(container.querySelector('.editor-node__name .editor-node__label')?.textContent).toBe('app.ts')
    expect(container.querySelector('.editor-node__name .editor-node__icon')?.className).toContain('files-icon--blue')
  })

  it('is relative to the Files node that opened the file, with folder segments that show it', async () => {
    const files: Node = { id: 'f1', type: 'files', position: { x: 0, y: 0 }, data: { dirPath: '/w/proj' } }
    const { container } = mount('/w/proj/src/app.ts', { nodes: [files], edges: [{ id: 'e', source: 'f1', target: 'n1', data: { kind: 'file' } }] })
    await ready()
    const crumbs = container.querySelector<HTMLElement>('.editor-node__crumbs')!
    expect(crumbs.textContent).toBe('srcapp.ts')
    expect(within(crumbs).getByRole('button', { name: /src/ })).toBeTruthy()
  })

  it('without a Files node shows the absolute path, folding older segments into "…"', async () => {
    const { container } = mount('/a/b/c/d/e/app.ts')
    await ready()
    const crumbs = container.querySelector<HTMLElement>('.editor-node__crumbs')!
    expect(within(crumbs).getByRole('button', { name: 'Show hidden path segments' })).toBeTruthy()
    expect(crumbs.textContent).toContain('app.ts')
    expect(crumbs.textContent).not.toContain('b')
  })
})

describe('viewer side', () => {
  it('"Open as Text" reopens an SVG in the editor; "Reopen as Preview" goes back', async () => {
    const { readMeta, container } = mount('/x/logo.svg')
    await waitFor(() => expect(viewer.props).not.toBeNull())
    expect(readMeta).not.toHaveBeenCalled()
    act(() => viewer.props!.onOpenAsText!())
    await ready()
    expect(readMeta).toHaveBeenCalledWith('/x/logo.svg')
    fireEvent.contextMenu(container.querySelector('.node-header')!)
    expect(screen.getByRole('menuitem', { name: 'Reopen as Preview' })).toBeTruthy()
  })

  it('shows the size the viewer reports in the status bar', async () => {
    mount('/x/shot.png')
    await waitFor(() => expect(viewer.props).not.toBeNull())
    act(() => viewer.props!.onMeta!({ width: 1920, height: 1080, bytes: 3 * 1024 * 1024 }))
    expect(screen.getByRole('contentinfo', { name: 'Editor status' }).textContent).toBe('1920×10803.0 MB')
  })
})
