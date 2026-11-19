/** @vitest-environment jsdom */
// Secret masking in the editor node (docs/decisions/secret-masking.md). Monaco is faked with a real
// text model so the tests can read exactly what the editor would show: the model text.
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import { DEFAULT_SETTINGS } from '../shared/settings'

const fake = vi.hoisted(() => {
  const s = {
    value: '', readOnly: false, listeners: [] as Array<() => void>, save: () => {},
    mouse: null as null | ((e: unknown) => void), decorations: [] as Array<{ range: { startColumn: number } }>,
  }
  const lines = () => s.value.split('\n')
  const model = {
    getValue: () => s.value,
    setValue: (v: string) => { s.value = v; s.listeners.forEach((f) => f()) },
    getOffsetAt: (p: { lineNumber: number; column: number }) => lines().slice(0, p.lineNumber - 1).reduce((n, l) => n + l.length + 1, 0) + p.column - 1,
    getPositionAt: (o: number) => {
      let rest = o
      for (const [i, l] of lines().entries()) { if (rest <= l.length) return { lineNumber: i + 1, column: rest + 1 }; rest -= l.length + 1 }
      return { lineNumber: 1, column: 1 }
    },
    getValueLengthInRange: () => 0, getOptions: () => ({ insertSpaces: true, tabSize: 2 }), getLanguageId: () => 'plaintext', getEOL: () => '\n', pushEOL: () => {},
    dispose: () => {},
  }
  const editor = {
    getValue: () => s.value,
    setValue: (v: string) => model.setValue(v),
    getModel: () => model,
    onDidChangeModelContent: (cb: () => void) => { s.listeners.push(cb) },
    addAction: (d: { id: string; run: () => void }) => { if (d.id === 'webterm.editor.save') s.save = d.run; return { dispose: () => {} } },
    updateOptions: (o: { readOnly?: boolean }) => { if (o.readOnly !== undefined) s.readOnly = o.readOnly },
    saveViewState: () => ({}), restoreViewState: () => {},
    createDecorationsCollection: (d: Array<{ range: { startColumn: number } }>) => { s.decorations = d; return { clear: () => { s.decorations = [] } } },
    onMouseDown: (cb: (e: unknown) => void) => { s.mouse = cb; return { dispose: () => { s.mouse = null } } },
    onDidChangeCursorSelection: () => ({ dispose: () => {} }), onDidChangeModelOptions: () => ({ dispose: () => {} }), onDidChangeModelLanguage: () => ({ dispose: () => {} }),
    getPosition: () => ({ lineNumber: 1, column: 1 }), getSelections: () => [],
    dispose: () => {},
  }
  const monaco = {
    Uri: { file: () => ({ with: () => 'uri' }) },
    KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 },
    editor: {
      getModel: () => null,
      createModel: (v: string) => { s.value = v; return model },
      create: (_h: unknown, o: { readOnly?: boolean }) => { s.readOnly = !!o.readOnly; return editor },
      setTheme: () => {},
    },
    languages: { getLanguages: () => [] },
  }
  return { s, monaco }
})
vi.mock('./lazyMonaco', () => ({ loadMonaco: () => Promise.resolve(fake.monaco) }))
vi.mock('./fsClient', () => ({
  capabilities: () => Promise.resolve({ mutate: false, viewers: true, watch: false, git: false, quickOpen: false, upload: false, listMax: 10 }),
  rawUrl: (p: string) => p,
  stat: () => Promise.resolve({ ok: false, code: 'ENOENT', error: 'x' }),
  readMeta: () => Promise.reject(new Error('unused')),
  writeChecked: () => Promise.reject(new Error('unused')),
}))

import EditorNode from './EditorNode'
import { SettingsProvider } from './useSettings'

const SECRET = 'abcdef1234567890zzzz'
const ENV = `API_KEY=${SECRET}\nNAME=webterm\n`
const BULLETS = /^API_KEY=•{20}\nNAME=•{7}\n$/

afterEach(() => { cleanup(); fake.s.value = ''; fake.s.listeners = []; vi.useRealTimers() })

function mount(over: { path?: string; content?: string; settings?: Partial<typeof DEFAULT_SETTINGS>; preview?: boolean } = {}) {
  const readMeta = vi.fn(() => Promise.resolve({ content: over.content ?? ENV, version: 'v1', encoding: 'utf8' as const }))
  const writeChecked = vi.fn(() => Promise.resolve({ ok: true as const, version: 'v2' }))
  const props = { id: 'n1', data: { filePath: over.path ?? '/x/.env' }, selected: false, readMeta, writeChecked, openMarkdownPreview: over.preview }
  const { container, rerender } = render(
    <SettingsProvider value={{ ...DEFAULT_SETTINGS, ...over.settings }}>
      <ReactFlowProvider><EditorNode {...(props as unknown as ComponentProps<typeof EditorNode>)} /></ReactFlowProvider>
    </SettingsProvider>,
  )
  const again = (settings: Partial<typeof DEFAULT_SETTINGS>) => rerender(
    <SettingsProvider value={{ ...DEFAULT_SETTINGS, ...settings }}>
      <ReactFlowProvider><EditorNode {...(props as unknown as ComponentProps<typeof EditorNode>)} /></ReactFlowProvider>
    </SettingsProvider>,
  )
  return { readMeta, writeChecked, container, again }
}
const ready = () => waitFor(() => expect(fake.s.value).not.toBe(''))
const type = (v: string) => act(() => { fake.s.value = v; fake.s.listeners.forEach((f) => f()) })

describe('editor secret masking', () => {
  it('opens a .env masked: display text only, read-only, with a count in the status bar', async () => {
    mount()
    await ready()
    expect(fake.s.value).toMatch(BULLETS)
    expect(fake.s.value).not.toContain(SECRET)
    expect(fake.s.readOnly).toBe(true)
    expect(await screen.findByText('2 secrets masked')).toBeTruthy()
  })

  it('blocks save while masked and never marks the buffer dirty', async () => {
    const { writeChecked } = mount()
    await ready()
    act(() => fake.s.save())
    expect(writeChecked).not.toHaveBeenCalled()
    expect(screen.queryByRole('img', { name: 'Unsaved changes' })).toBeNull()
  })

  it('Reveal all shows the real text but stays read-only; Hide masks it again', async () => {
    mount()
    await ready()
    fireEvent.click(await screen.findByText('Reveal all'))
    await waitFor(() => expect(fake.s.value).toBe(ENV))
    expect(fake.s.readOnly).toBe(true)
    fireEvent.click(screen.getByText('Hide'))
    await waitFor(() => expect(fake.s.value).toMatch(BULLETS))
  })

  it('clicking one masked value reveals only that value', async () => {
    mount()
    await ready()
    await waitFor(() => expect(fake.s.mouse).not.toBeNull())
    expect(fake.s.decorations).toHaveLength(2)
    act(() => fake.s.mouse?.({ target: { position: { lineNumber: 1, column: 10 } } }))
    await waitFor(() => expect(fake.s.value).toBe(`API_KEY=${SECRET}\nNAME=•••••••\n`))
  })

  it('Edit shows the real text editable, and save writes the real (not masked) text', async () => {
    const { writeChecked } = mount()
    await ready()
    fireEvent.click(await screen.findByText('Edit'))
    await waitFor(() => expect(fake.s.value).toBe(ENV))
    expect(fake.s.readOnly).toBe(false)
    expect(screen.getByText('Secrets visible — editing.')).toBeTruthy()
    type(`${ENV}EXTRA=1\n`)
    act(() => fake.s.save())
    await waitFor(() => expect(writeChecked).toHaveBeenCalledTimes(1))
    expect(writeChecked).toHaveBeenCalledWith('/x/.env', `${ENV}EXTRA=1\n`, expect.anything())
    // Saved and nothing revealed anymore is not the case yet: the secrets stay shown until they hide.
    expect(fake.s.value).toContain(SECRET)
  })

  it('auto-hide never drops unsaved edits: it waits for the save, then masks again', async () => {
    const { writeChecked } = mount()
    await ready()
    fireEvent.click(await screen.findByText('Edit'))
    await waitFor(() => expect(fake.s.readOnly).toBe(false))
    type(`${ENV}EXTRA=1\n`)
    act(() => { window.dispatchEvent(new Event('blur')) })
    expect(await screen.findByText(/Unsaved changes: secrets stay visible/)).toBeTruthy()
    expect(fake.s.value).toBe(`${ENV}EXTRA=1\n`)
    expect(fake.s.readOnly).toBe(false)
    act(() => fake.s.save())
    await waitFor(() => expect(writeChecked).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(fake.s.readOnly).toBe(true))
    expect(fake.s.value).not.toContain(SECRET)
    expect(fake.s.value).toMatch(/^API_KEY=•{20}\nNAME=•{7}\nEXTRA=/)
    expect(await screen.findByText('Secrets hidden again.')).toBeTruthy()
  })

  it('a clean Edit session hides again on blur with a notice', async () => {
    mount()
    await ready()
    fireEvent.click(await screen.findByText('Edit'))
    await waitFor(() => expect(fake.s.readOnly).toBe(false))
    act(() => { window.dispatchEvent(new Event('blur')) })
    await waitFor(() => expect(fake.s.value).toMatch(BULLETS))
    expect(await screen.findByText('Secrets hidden again.')).toBeTruthy()
  })

  it('maskSecrets OFF keeps the old behaviour: real text, editable, no mask items', async () => {
    const { writeChecked } = mount({ settings: { maskSecrets: false } })
    await ready()
    expect(fake.s.value).toBe(ENV)
    expect(fake.s.readOnly).toBe(false)
    expect(screen.queryByText('Reveal all')).toBeNull()
    type(`${ENV}X=1\n`)
    act(() => fake.s.save())
    await waitFor(() => expect(writeChecked).toHaveBeenCalledTimes(1))
  })

  it('a file with no secrets is untouched even with masking on', async () => {
    mount({ path: '/x/app.json', content: '{"a":1}' })
    await ready()
    expect(fake.s.value).toBe('{"a":1}')
    expect(fake.s.readOnly).toBe(false)
  })

  it('the markdown preview renders the masked text, not the secret', async () => {
    const token = 'sk-abcdefghijklmnopqrstuvwxyz123456'
    const { container } = mount({ path: '/x/notes.md', content: `# Notes\n\nkey ${token}\n`, preview: true })
    await ready()
    await waitFor(() => expect(container.querySelector('.editor-node__md')).not.toBeNull())
    await waitFor(() => expect(container.querySelector('.editor-node__md')?.textContent).toContain('•'))
    expect(container.textContent).not.toContain(token)
    expect(fake.s.value).not.toContain(token)
  })

  it('toggling the setting live releases and re-takes the buffer', async () => {
    const { again } = mount()
    await ready()
    expect(fake.s.value).toMatch(BULLETS)
    again({ maskSecrets: false })
    await waitFor(() => expect(fake.s.value).toBe(ENV))
    expect(fake.s.readOnly).toBe(false)
    again({ maskSecrets: true })
    await waitFor(() => expect(fake.s.value).toMatch(BULLETS))
    expect(fake.s.readOnly).toBe(true)
  })
})
