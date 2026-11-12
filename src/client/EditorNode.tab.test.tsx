/** @vitest-environment jsdom */
// Tab mode: the editor draws no header of its own; its actions (Preview, Word wrap, Save) sit in the
// tab strip for the active tab and in the tab's menu, and closing a dirty editor still asks to save.
import type { ComponentProps, ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, useReactFlow, type Node } from '@xyflow/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const fake = vi.hoisted(() => {
  const editors: Array<{ value: string; onChange: () => void }> = []
  const monaco = {
    Uri: { file: () => ({ with: () => 'uri' }) },
    KeyMod: { CtrlCmd: 1, Alt: 4 }, KeyCode: { KeyS: 2, KeyZ: 8 },
    editor: {
      getModel: () => null,
      createModel: () => ({ dispose: () => {} }),
      setTheme: () => {},
      create: () => {
        const st = { value: 'a', onChange: () => {} }
        editors.push(st)
        return {
          getValue: () => st.value,
          onDidChangeModelContent: (cb: () => void) => { st.onChange = cb },
          addAction: () => ({ dispose: () => {} }),
          updateOptions: () => {},
          dispose: () => {},
        }
      },
    },
  }
  return { monaco, editors }
})
vi.mock('./lazyMonaco', () => ({ loadMonaco: () => Promise.resolve(fake.monaco) }))
vi.mock('./fsClient', () => ({
  capabilities: () => Promise.resolve({ mutate: false, viewers: true, watch: false, git: false, quickOpen: false, upload: false, listMax: 10 }),
  rawUrl: (p: string) => `/raw?path=${encodeURIComponent(p)}`,
  stat: () => Promise.resolve({ ok: false, code: 'ENOENT', error: 'x' }),
  readMeta: () => Promise.reject(new Error('unused')),
  writeChecked: () => Promise.reject(new Error('unused')),
}))

import EditorNode from './EditorNode'
import { NodeHostContext } from './tabLayout.context'
import { setEditorActionsSlot, tabNodeMenuItems } from './tabLayout.nodeActions'
import { beforeNodeDelete, NodeCloseConfirmHost } from './nodeCloseConfirm'

// test-only: jsdom has no ResizeObserver.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
afterEach(() => { cleanup(); fake.editors.length = 0 })

const readMeta = () => Promise.resolve({ content: 'a', version: 'v1', encoding: 'utf8' as const })
const writeChecked = vi.fn(() => Promise.resolve({ ok: true as const, version: 'v2' }))
const Editor = (p: ComponentProps<typeof EditorNode>) => <EditorNode {...p} readMeta={readMeta} writeChecked={writeChecked} />
const NODE: Node = { id: 'e1', type: 'editor', position: { x: 0, y: 0 }, width: 600, height: 400, data: { filePath: '/x/note.md', name: 'Sloth' } }

/** The tab's × as App wires it: React Flow `deleteElements`, gated by `onBeforeDelete`. */
function TabClose() {
  const rf = useReactFlow()
  return <button type="button" aria-label="Close Sloth" onClick={() => void rf.deleteElements({ nodes: [{ id: 'e1' }] })}>×</button>
}

function mount(inTab: boolean, extra?: ReactNode) {
  return render(
    <ReactFlowProvider>
      <div ref={setEditorActionsSlot} data-slot="tab-editor-actions" />
      <NodeHostContext.Provider value={{ inTab, visible: true, maximized: false }}>
        <div style={{ width: 800, height: 600 }}>
          <ReactFlow defaultNodes={[NODE]} nodeTypes={{ editor: Editor }} onBeforeDelete={beforeNodeDelete} />
        </div>
      </NodeHostContext.Provider>
      {extra}
    </ReactFlowProvider>,
  )
}
const strip = () => within(document.querySelector<HTMLElement>('[data-slot="tab-editor-actions"]')!)

describe('EditorNode in tab mode', () => {
  it('renders no own header or close; Preview, Word wrap and Save move to the strip and the tab menu', async () => {
    mount(true)
    await waitFor(() => expect(fake.editors).toHaveLength(1))
    expect(document.querySelector('.node-header')).toBeNull()
    expect(document.querySelector('.editor-node .codicon-close')).toBeNull()
    const labels = strip().getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)
    expect(labels).toEqual(['Preview', 'Word wrap', 'Save'])
    expect(tabNodeMenuItems('e1').map((r) => (r.type === 'item' ? r.label : r.type))).toEqual(['Preview', 'Word wrap', 'Save'])
  })

  it('Save is disabled while clean, enabled once dirty, and saves from the strip', async () => {
    mount(true)
    await waitFor(() => expect(fake.editors).toHaveLength(1))
    const save = () => strip().getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save().disabled).toBe(true)
    expect(tabNodeMenuItems('e1').find((r) => r.type === 'item' && r.id === 'save')).toMatchObject({ disabled: true })
    fake.editors[0].value = 'changed'
    act(() => fake.editors[0].onChange())
    expect(save().disabled).toBe(false)
    await act(async () => { fireEvent.click(save()) })
    expect(writeChecked).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(save().disabled).toBe(true))
  })

  it("closing with unsaved changes still asks Save / Don't Save / Cancel through the tab ×", async () => {
    mount(true, <><TabClose /><NodeCloseConfirmHost /></>)
    await waitFor(() => expect(fake.editors).toHaveLength(1))
    fake.editors[0].value = 'changed'
    act(() => fake.editors[0].onChange())
    fireEvent.click(screen.getByRole('button', { name: 'Close Sloth' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: /^Save/ })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.querySelector('.editor-node')).not.toBeNull()
  })

  it('on the canvas keeps its own header with Save and Close, and publishes nothing to the strip', async () => {
    mount(false)
    await waitFor(() => expect(fake.editors).toHaveLength(1))
    expect(document.querySelector('.editor-node .node-header')).not.toBeNull()
    expect(document.querySelector('.editor-node .node-header .codicon-close')).not.toBeNull()
    expect(within(document.querySelector<HTMLElement>('.editor-node .node-header')!).getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(strip().queryAllByRole('button')).toHaveLength(0)
    expect(tabNodeMenuItems('e1')).toEqual([])
  })
})
