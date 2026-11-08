/** @vitest-environment jsdom */
// useEditorFile: the preview source follows toggle, reload and (debounced) edits; the unsaved-changes
// registry gets an awaitable save. Monaco is faked — what is tested is the hook's wiring.
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const state = { value: '', onChange: () => {} }
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
    editor: { getModel: () => null, createModel: (content: string) => { state.value = content; return { dispose: () => {} } }, create: () => editor, setTheme: () => {} },
  }
  return { state, monaco }
})
vi.mock('./lazyMonaco', () => ({ loadMonaco: () => Promise.resolve(fake.monaco) }))

import { PREVIEW_DEBOUNCE_MS, useEditorFile, type WriteChecked } from './useEditorFile'
import { isEditorDirty, saveEditor } from './editorDirty'
import type { ReadMeta } from '../shared/fsContract'

afterEach(() => { fake.state.value = ''; fake.state.onChange = () => {} })

const meta = (content: string, version = 'v1') => ({ content, version, encoding: 'utf8' }) as ReadMeta

function mount(over: { openMarkdownPreview?: boolean; writeChecked?: WriteChecked; id?: string } = {}) {
  const readMeta = vi.fn((_p: string) => Promise.resolve(meta('# One')))
  const writeChecked = vi.fn(over.writeChecked ?? (() => Promise.resolve({ ok: true, version: 'v2' } as never)))
  const hostRef = { current: document.createElement('div') }
  const r = renderHook(() => useEditorFile({
    id: over.id ?? 'n1', filePath: '/repo/a.md', fileName: 'a.md', ext: 'md', enabled: true,
    openMarkdownPreview: over.openMarkdownPreview ?? true, hostRef, readMeta, writeChecked, setLoadError: () => {},
  }))
  return { ...r, readMeta, writeChecked }
}

const type = (v: string) => act(() => { fake.state.value = v; fake.state.onChange() })

describe('useEditorFile preview source', () => {
  it('opens a .md in preview with the file content', async () => {
    const { result } = mount()
    await waitFor(() => expect(result.current.preview).toBe(true))
    expect(result.current.previewSource).toBe('# One')
  })

  it('edits while the preview is visible land after the debounce, not per keystroke', async () => {
    const { result } = mount()
    await waitFor(() => expect(result.current.preview).toBe(true))
    type('# Two')
    expect(result.current.previewSource).toBe('# One')
    await new Promise((r) => setTimeout(r, PREVIEW_DEBOUNCE_MS / 2))
    expect(result.current.previewSource).toBe('# One')
    await waitFor(() => expect(result.current.previewSource).toBe('# Two'))
  })

  it('while hidden, edits do not re-render; toggling in picks up the buffer', async () => {
    const { result } = mount({ openMarkdownPreview: false })
    await waitFor(() => expect(fake.state.value).toBe('# One'))
    type('# Edited')
    await new Promise((r) => setTimeout(r, PREVIEW_DEBOUNCE_MS + 50))
    expect(result.current.previewSource).toBe('')
    act(() => result.current.togglePreview())
    expect(result.current.preview).toBe(true)
    expect(result.current.previewSource).toBe('# Edited')
  })

  it('reload (external change) refreshes the visible preview', async () => {
    const { result, readMeta } = mount()
    await waitFor(() => expect(result.current.preview).toBe(true))
    readMeta.mockResolvedValueOnce(meta('# From disk', 'v9'))
    await act(() => result.current.reload())
    expect(result.current.previewSource).toBe('# From disk')
  })
})

describe('useEditorFile unsaved-changes registry', () => {
  it('registers dirty with a save that resolves true only after the write lands', async () => {
    let finish: (v: unknown) => void = () => {}
    const { result, unmount } = mount({ id: 'reg1', writeChecked: () => new Promise((r) => { finish = r }) as never })
    await waitFor(() => expect(result.current.preview).toBe(true))
    expect(isEditorDirty('reg1')).toBe(false)
    type('# Changed')
    expect(isEditorDirty('reg1')).toBe(true)
    let settled: boolean | undefined
    const p = saveEditor('reg1').then((ok) => { settled = ok })
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBeUndefined()
    await act(async () => { finish({ ok: true, version: 'v2' }); await p })
    expect(settled).toBe(true)
    expect(isEditorDirty('reg1')).toBe(false)
    type('# Again')
    expect(isEditorDirty('reg1')).toBe(true)
    unmount()
    expect(isEditorDirty('reg1')).toBe(false)
  })

  it('a refused write (version conflict) resolves false and stays dirty', async () => {
    const { result } = mount({ id: 'reg2', writeChecked: () => Promise.resolve({ ok: false, code: 'EVERSION', error: 'x' } as never) })
    await waitFor(() => expect(result.current.preview).toBe(true))
    type('# Changed')
    let ok: boolean | undefined
    await act(async () => { ok = await saveEditor('reg2') })
    expect(ok).toBe(false)
    expect(isEditorDirty('reg2')).toBe(true)
    expect(result.current.conflict).toEqual({ kind: 'version', current: undefined })
  })
})
