/** @vitest-environment jsdom */
// Word wrap and "Fit width to content" on a real editor node in a controlled canvas: the choice is
// stored on the node, Alt+Z belongs to the editor it is pressed in, and fitting resizes the node.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, useNodesState, useStoreApi, type Node, type NodeProps } from '@xyflow/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import './commandRegistry.defaults' // registers Toggle Word Wrap (Alt+Z), as App does

const ALT_Z = 512 | 56
const fake = vi.hoisted(() => {
  type Ed = { path: string; wrap: string[]; keys: Map<number, () => void> }
  const editors: Ed[] = []
  let nextPath = ''
  const lines = ['x'.repeat(100)]
  const monaco = {
    Uri: { file: (p: string) => { nextPath = p; return { with: () => p } } },
    KeyMod: { CtrlCmd: 2048, Alt: 512 }, KeyCode: { KeyS: 49, KeyZ: 56 },
    editor: {
      EditorOption: { fontInfo: 50 },
      getModel: () => null,
      createModel: () => ({ dispose: () => {} }),
      setTheme: () => {},
      create: () => {
        const st: Ed = { path: nextPath, wrap: [], keys: new Map() }
        editors.push(st)
        return {
          getValue: () => 'a',
          onDidChangeModelContent: () => {},
          addAction: (d: { keybindings?: number[]; run: () => void }) => {
            for (const k of d.keybindings ?? []) st.keys.set(k, d.run)
            return { dispose: () => { for (const k of d.keybindings ?? []) st.keys.delete(k) } }
          },
          updateOptions: (o: { wordWrap: string }) => st.wrap.push(o.wordWrap),
          getOption: () => ({ typicalHalfwidthCharacterWidth: 8 }),
          getModel: () => ({ getOptions: () => ({ tabSize: 4 }), getLineContent: (l: number) => lines[l - 1] }),
          getVisibleRanges: () => [{ startLineNumber: 1, endLineNumber: 1 }],
          getLayoutInfo: () => ({ width: 398, contentLeft: 50, minimap: { minimapWidth: 0 }, verticalScrollbarWidth: 14 }),
          dispose: () => {},
        }
      },
    },
  }
  return { monaco, editors, of: (path: string) => editors.filter((e) => e.path === path).at(-1)! }
})
vi.mock('./lazyMonaco', () => ({ loadMonaco: () => Promise.resolve(fake.monaco) }))
vi.mock('./clipboard', () => ({ writeClipboard: vi.fn() }))
vi.mock('./fsClient', () => ({
  capabilities: () => Promise.resolve({ mutate: false, viewers: true, watch: false, git: false, quickOpen: false, upload: false, listMax: 10 }),
  rawUrl: (p: string) => p,
  stat: () => Promise.resolve({ ok: false, code: 'ENOENT', error: 'x' }),
  readMeta: () => Promise.resolve({ content: 'a', version: 'v1', encoding: 'utf8' }),
  writeChecked: () => Promise.resolve({ ok: true, version: 'v2' }),
}))

import EditorNode from './EditorNode'
import { exitNodeResize, setNodeResizeLocked, toggleNodeResize } from './nodeResize/nodeResize.store'

// test-only: jsdom has no ResizeObserver; the canvas width is set on the store below instead.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
afterEach(() => { cleanup(); fake.editors.length = 0; setNodeResizeLocked(false); exitNodeResize() })

const nodeTypes = { editor: (p: NodeProps) => <EditorNode {...p} /> }
let latest: Node[] = []
let flowStore: ReturnType<typeof useStoreApi> | null = null

function Canvas({ init }: { init: Node[] }) {
  const [nodes, , onNodesChange] = useNodesState(init)
  latest = nodes
  flowStore = useStoreApi()
  return <div style={{ width: 4000, height: 800 }}><ReactFlow nodes={nodes} onNodesChange={onNodesChange} nodeTypes={nodeTypes} /></div>
}

const ed = (id: string, filePath: string, extra: Record<string, unknown> = {}): Node =>
  ({ id, type: 'editor', position: { x: id === 'b' ? 900 : 0, y: 0 }, data: { filePath, ...extra }, width: 400, height: 300 })
const mount = (nodes: Node[]) => render(<ReactFlowProvider><Canvas init={nodes} /></ReactFlowProvider>)
const nodeEl = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement
const wrapBtn = (id: string) => nodeEl(id).querySelector('vscode-toolbar-button[data-title^="Toggle word wrap"]') as HTMLElement
const dataOf = (id: string) => latest.find((n) => n.id === id)?.data as { wordWrap?: boolean }
const ready = (...paths: string[]) => waitFor(() => paths.forEach((p) => expect(fake.of(p)?.wrap.length).toBeGreaterThan(0)))
const openMenu = (id: string) => { flowStore!.setState({ width: 4000 }); fireEvent.contextMenu(nodeEl(id).querySelector('.node-header')!) }
const fitRow = () => screen.getByRole('menuitem', { name: /Fit width to content/ })

describe('EditorNode word wrap', () => {
  it('defaults by file type: on for Markdown, off for code', async () => {
    mount([ed('a', '/r/README.md'), ed('b', '/r/app.ts')])
    await ready('/r/README.md', '/r/app.ts')
    expect(fake.of('/r/README.md').wrap.at(-1)).toBe('on')
    expect(fake.of('/r/app.ts').wrap.at(-1)).toBe('off')
    expect(wrapBtn('a').getAttribute('data-title')).toMatch(/^Toggle word wrap \((⌥Z|Alt\+Z)\)$/)
  })

  it('the toggle flips the Monaco option live and stores the choice on the node', async () => {
    mount([ed('a', '/r/app.ts')])
    await ready('/r/app.ts')
    fireEvent.click(wrapBtn('a'))
    await waitFor(() => expect(fake.of('/r/app.ts').wrap.at(-1)).toBe('on'))
    expect(dataOf('a').wordWrap).toBe(true)
    expect(fake.editors).toHaveLength(1) // no remount
  })

  it('a stored choice wins over the default after a remount', async () => {
    mount([ed('a', '/r/README.md', { wordWrap: false })])
    await ready('/r/README.md')
    expect(fake.of('/r/README.md').wrap).toEqual(['off'])
  })

  it('Alt+Z toggles only the editor it is pressed in', async () => {
    mount([ed('a', '/r/one.ts'), ed('b', '/r/two.ts')])
    await ready('/r/one.ts', '/r/two.ts')
    act(() => fake.of('/r/one.ts').keys.get(ALT_Z)!())
    await waitFor(() => expect(dataOf('a').wordWrap).toBe(true))
    expect(dataOf('b').wordWrap).toBeUndefined()
    expect(fake.of('/r/two.ts').wrap.at(-1)).toBe('off')
  })
})

describe('EditorNode fit width', () => {
  const FITTED = 2 + 50 + 100 * 8 + 14 + 16

  it('is disabled with the reason while word wrap is on', async () => {
    mount([ed('a', '/r/README.md')])
    await ready('/r/README.md')
    openMenu('a')
    expect(fitRow().getAttribute('aria-disabled')).toBe('true')
    expect(fitRow().getAttribute('title')).toBe('Word wrap is on')
  })

  it('resizes the node to the longest visible line, height unchanged', async () => {
    mount([ed('a', '/r/app.ts')])
    await ready('/r/app.ts')
    openMenu('a')
    fireEvent.click(fitRow())
    await waitFor(() => expect(latest[0].width).toBe(FITTED))
    expect(latest[0].height).toBe(300)
  })

  it('does not resize while the view is locked', async () => {
    mount([ed('a', '/r/app.ts')])
    await ready('/r/app.ts')
    act(() => setNodeResizeLocked(true))
    openMenu('a')
    expect(fitRow().getAttribute('title')).toBe('The view is locked')
    fireEvent.click(fitRow())
    expect(latest[0].width).toBe(400)
  })

  it('double-clicking the right edge in resize mode fits the width', async () => {
    mount([ed('a', '/r/app.ts')])
    await ready('/r/app.ts')
    act(() => { flowStore!.setState({ width: 4000 }); toggleNodeResize('a') })
    fireEvent.doubleClick(nodeEl('a').querySelector('.react-flow__resize-control.line.right')!)
    await waitFor(() => expect(latest[0].width).toBe(FITTED))
  })
})
