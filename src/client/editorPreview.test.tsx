/** @vitest-environment jsdom */
// Editor preview (VS Code): judul miring + "Keep open", editan pertama / double-click judul mem-pin,
// `openSeq` baru memuat ulang file yang diganti, dan flag-nya ikut persist. Monaco dipalsukan; React
// Flow hanya `useReactFlow` yang diganti spy supaya `updateNodeData` bisa diamati.
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const fake = vi.hoisted(() => {
  const state = { value: 'a', onChange: () => {}, created: 0 }
  const editor = {
    getValue: () => state.value,
    setValue: (v: string) => { state.value = v; state.onChange() },
    onDidChangeModelContent: (cb: () => void) => { state.onChange = cb },
    addAction: () => ({ dispose: () => {} }),
    dispose: () => {},
  }
  const monaco = {
    Uri: { file: () => ({ with: () => 'uri' }) },
    KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 },
    editor: { getModel: () => null, createModel: () => ({ dispose: () => {} }), create: () => { state.created++; return editor }, setTheme: () => {} },
  }
  return { state, monaco }
})
vi.mock('./lazyMonaco', () => ({ loadMonaco: () => Promise.resolve(fake.monaco) }))
vi.mock('./fsClient', () => ({
  stat: () => Promise.resolve({ ok: false, code: 'ENOENT', error: 'x' }),
  readMeta: () => Promise.reject(new Error('unused')),
  writeChecked: () => Promise.reject(new Error('unused')),
}))
const rf = vi.hoisted(() => ({ updateNodeData: vi.fn(), deleteElements: vi.fn() }))
vi.mock('@xyflow/react', async (orig) => ({ ...(await orig<typeof import('@xyflow/react')>()), useReactFlow: () => rf }))

import EditorNode from './EditorNode'
import { toFlow, toWsNode } from './store'
import { normalizeWorkspace } from '../shared/workspace.schema'

afterEach(() => { cleanup(); fake.state.value = 'a'; fake.state.created = 0; rf.updateNodeData.mockClear() })

const META = { content: 'a', version: 'v1', encoding: 'utf8' as const }

function mount(data: Record<string, unknown>) {
  const readMeta = vi.fn(() => Promise.resolve(META))
  const el = (d: Record<string, unknown>) => {
    const props = { id: 'n1', data: { filePath: '/x/a.json', ...d }, selected: false, readMeta, writeChecked: vi.fn() }
    return <ReactFlowProvider><EditorNode {...(props as unknown as ComponentProps<typeof EditorNode>)} /></ReactFlowProvider>
  }
  const r = render(el(data))
  return { ...r, readMeta, rerenderWith: (d: Record<string, unknown>) => r.rerender(el(d)) }
}

const keepOpen = (c: HTMLElement) => c.querySelector('vscode-toolbar-button[data-title="Keep open"]')
const title = (c: HTMLElement) => c.querySelector('.editor-node__name') as HTMLElement

describe('preview editor', () => {
  it('preview: italic title + Keep open; pinned: neither', async () => {
    const { container, rerenderWith } = mount({ preview: true })
    await waitFor(() => expect(fake.state.created).toBe(1))
    expect(title(container).className).toContain('editor-node__name--preview')
    expect(keepOpen(container)).not.toBeNull()
    rerenderWith({})
    expect(title(container).className).not.toContain('editor-node__name--preview')
    expect(keepOpen(container)).toBeNull()
  })

  it('the first edit pins the editor', async () => {
    mount({ preview: true })
    await waitFor(() => expect(fake.state.created).toBe(1))
    expect(rf.updateNodeData).not.toHaveBeenCalled()
    fake.state.value = 'ab'
    act(() => fake.state.onChange())
    expect(rf.updateNodeData).toHaveBeenCalledWith('n1', { preview: undefined })
  })

  it('double-clicking the title pins it; a pinned editor is left alone', async () => {
    const { container, rerenderWith } = mount({ preview: true })
    fireEvent.doubleClick(title(container))
    expect(rf.updateNodeData).toHaveBeenCalledWith('n1', { preview: undefined })
    rf.updateNodeData.mockClear()
    rerenderWith({})
    fireEvent.doubleClick(title(container))
    expect(rf.updateNodeData).not.toHaveBeenCalled()
  })

  it('a new openSeq reloads the swapped file; a rename (path only) does not', async () => {
    const { readMeta, rerenderWith } = mount({ preview: true })
    await waitFor(() => expect(readMeta).toHaveBeenCalledTimes(1))
    rerenderWith({ preview: true, filePath: '/x/b.json' })
    await act(async () => {})
    expect(readMeta).toHaveBeenCalledTimes(1)
    rerenderWith({ preview: true, filePath: '/x/c.json', openSeq: 1 })
    await waitFor(() => expect(readMeta).toHaveBeenLastCalledWith('/x/c.json'))
    expect(readMeta).toHaveBeenCalledTimes(2)
  })
})

describe('preview flag persistence', () => {
  it('round-trips true; anything else is pinned (absent)', () => {
    const node = { id: 'e', kind: 'editor' as const, x: 0, y: 0, filePath: '/x/a.ts', preview: true }
    expect(toWsNode(toFlow(node)).preview).toBe(true)
    expect(toWsNode(toFlow({ ...node, preview: undefined })).preview).toBeUndefined()
    const junk = toFlow(node)
    junk.data = { ...junk.data, preview: 'yes' }
    expect(toWsNode(junk).preview).toBeUndefined()
  })

  it('the server schema keeps preview:true and drops junk', () => {
    const ed = (preview: unknown) => ({ id: 'e', kind: 'editor', x: 0, y: 0, filePath: '/x/a.ts', preview })
    const norm = (preview: unknown) => normalizeWorkspace({ name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [ed(preview)] }).board.nodes[0]
    expect(norm(true).preview).toBe(true)
    expect('preview' in norm('yes')).toBe(false)
  })
})
