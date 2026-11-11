/** @vitest-environment jsdom */
// Cmd+S belongs to the focused editor node (ui-210-1). The fake Monaco models the standalone keybinding
// service: `addCommand` adds a global binding (the last one registered wins for every editor) and
// `addAction` adds a binding scoped to its editor id. A key press runs the last matching binding.
import type { ComponentProps } from 'react'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import './commandRegistry.defaults' // registers Toggle Word Wrap (Alt+Z), as App does

const fake = vi.hoisted(() => {
  type Binding = { kb: number; scope: string | null; run: () => void }
  const bindings: Binding[] = []
  const editors: Array<{ id: string; value: string; onChange: () => void }> = []
  const remove = (b: Binding) => ({ dispose: () => { const i = bindings.indexOf(b); if (i >= 0) bindings.splice(i, 1) } })
  const monaco = {
    Uri: { file: () => ({ with: () => 'uri' }) },
    KeyMod: { CtrlCmd: 1, Alt: 4 }, KeyCode: { KeyS: 2, KeyZ: 8 },
    editor: {
      getModel: () => null,
      createModel: () => ({ dispose: () => {} }),
      setTheme: () => {},
      create: () => {
        const st = { id: `e${editors.length + 1}`, value: 'a', onChange: () => {} }
        editors.push(st)
        const editor = {
          getValue: () => st.value,
          onDidChangeModelContent: (cb: () => void) => { st.onChange = cb },
          addCommand: (kb: number, run: () => void) => { bindings.push({ kb, scope: null, run }) },
          addAction: (d: { keybindings?: number[]; run: (e: unknown) => void }) => {
            const added = (d.keybindings ?? []).map((kb) => ({ kb, scope: st.id, run: () => d.run(editor) }))
            bindings.push(...added)
            return { dispose: () => added.forEach((b) => remove(b).dispose()) }
          },
          updateOptions: () => {},
          dispose: () => {},
        }
        return editor
      },
    },
  }
  /** A key press inside editor `id`: the last binding visible there wins, as in Monaco's resolver. */
  const press = (id: string, kb: number) => bindings.filter((b) => b.kb === kb && (b.scope === null || b.scope === id)).at(-1)?.run()
  return { monaco, bindings, editors, press }
})
vi.mock('./lazyMonaco', () => ({ loadMonaco: () => Promise.resolve(fake.monaco) }))
vi.mock('./clipboard', () => ({ writeClipboard: vi.fn() }))
vi.mock('./fsClient', () => ({
  capabilities: () => Promise.resolve({ mutate: false, viewers: true, watch: false, git: false, quickOpen: false, upload: false, listMax: 10 }),
  rawUrl: (p: string) => `/raw?path=${encodeURIComponent(p)}`,
  stat: () => Promise.resolve({ ok: false, code: 'ENOENT', error: 'x' }),
  readMeta: () => Promise.reject(new Error('unused')),
  writeChecked: () => Promise.reject(new Error('unused')),
}))

import EditorNode from './EditorNode'

const CMD_S = 1 | 2

afterEach(() => { cleanup(); fake.bindings.length = 0; fake.editors.length = 0 })

function node(id: string, filePath: string) {
  const readMeta = vi.fn(() => Promise.resolve({ content: 'a', version: 'v1', encoding: 'utf8' as const }))
  const writeChecked = vi.fn(() => Promise.resolve({ ok: true, version: 'v2' }))
  const props = { id, data: { filePath }, selected: false, readMeta, writeChecked }
  return { el: <EditorNode key={id} {...(props as unknown as ComponentProps<typeof EditorNode>)} />, writeChecked }
}

describe('EditorNode Cmd+S per editor', () => {
  it('saves only the file of the editor the key was pressed in', async () => {
    const a = node('n1', '/x/a.ts')
    const b = node('n2', '/x/b.ts')
    render(<ReactFlowProvider>{a.el}{b.el}</ReactFlowProvider>)
    await waitFor(() => expect(fake.editors).toHaveLength(2))
    for (const e of fake.editors) { e.value = 'changed'; act(() => e.onChange()) }

    await act(async () => { fake.press('e1', CMD_S) })
    expect(a.writeChecked).toHaveBeenCalledTimes(1)
    expect(a.writeChecked.mock.calls[0]).toContain('/x/a.ts')
    expect(b.writeChecked).not.toHaveBeenCalled()

    await act(async () => { fake.press('e2', CMD_S) })
    expect(b.writeChecked).toHaveBeenCalledTimes(1)
    expect(b.writeChecked.mock.calls[0]).toContain('/x/b.ts')
    expect(a.writeChecked).toHaveBeenCalledTimes(1)
  })

  it('removes its keybinding when the node unmounts', async () => {
    const { unmount } = render(<ReactFlowProvider>{node('n1', '/x/a.ts').el}</ReactFlowProvider>)
    await waitFor(() => expect(fake.bindings).toHaveLength(2)) // save + word wrap
    unmount()
    expect(fake.bindings).toHaveLength(0)
  })
})

/** Every client source file (tests excluded). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

describe('Monaco keybinding policy', () => {
  it('no client code uses the global, undisposable editor.addCommand', () => {
    const offenders = sources(join(__dirname)).filter((p) => /\.addCommand\(/.test(readFileSync(p, 'utf8')))
    expect(offenders).toEqual([])
  })
})
