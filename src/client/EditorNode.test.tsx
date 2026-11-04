/** @vitest-environment jsdom */
// Chrome editor node: ikon file, titik "dirty" (bukan teks ●), tema Monaco mengikuti data-theme.
// Monaco dipalsukan — yang diuji kabel React-nya, bukan Monaco.
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const fake = vi.hoisted(() => {
  const state = { value: 'a', onChange: () => {}, setTheme: vi.fn(), createdWith: null as unknown, save: () => {}, loadMonaco: vi.fn() }
  const editor = {
    getValue: () => state.value,
    setValue: (v: string) => { state.value = v; state.onChange() },
    onDidChangeModelContent: (cb: () => void) => { state.onChange = cb },
    addCommand: (_k: number, cb: () => void) => { state.save = cb },
    dispose: () => {},
  }
  const monaco = {
    Uri: { file: () => ({ with: () => 'uri' }) },
    KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 },
    editor: {
      getModel: () => null,
      createModel: () => ({ dispose: () => {} }),
      create: (_h: unknown, opts: unknown) => { state.createdWith = opts; return editor },
      setTheme: state.setTheme,
    },
  }
  return { state, monaco }
})
vi.mock('./lazyMonaco', () => ({ loadMonaco: () => { fake.state.loadMonaco(); return Promise.resolve(fake.monaco) } }))
const clip = vi.hoisted(() => ({ writeClipboard: vi.fn(() => Promise.resolve(true)) }))
vi.mock('./clipboard', () => clip)
// ViewerHost (non-teks) membaca capabilities + URL raw lewat fsClient.
vi.mock('./fsClient', () => ({
  capabilities: () => Promise.resolve({ mutate: false, viewers: true, watch: false, git: false, quickOpen: false, upload: false, listMax: 10 }),
  rawUrl: (p: string) => `/raw?path=${encodeURIComponent(p)}`,
  stat: () => Promise.resolve({ ok: false, code: 'ENOENT', error: 'x' }),
  readMeta: () => Promise.reject(new Error('tak dipakai')),
  writeChecked: () => Promise.reject(new Error('tak dipakai')),
}))

import EditorNode from './EditorNode'
import { lspHint, setLspHint } from './editorLsp.hints'

afterEach(() => {
  cleanup(); document.documentElement.removeAttribute('data-theme')
  fake.state.value = 'a'; fake.state.createdWith = null; fake.state.loadMonaco.mockClear(); clip.writeClipboard.mockClear()
})

type Meta = { content: string; version: string; encoding: 'utf8' | 'non-utf8' | 'binary' }
type WriteFn = (p: string, c: string, o?: { expectedVersion?: string; mustExist?: boolean }) => Promise<unknown>
const META: Meta = { content: 'a', version: 'v1', encoding: 'utf8' }

function mount(over: { path?: string; meta?: Meta; writeChecked?: WriteFn } = {}) {
  const readMeta = vi.fn(() => Promise.resolve(over.meta ?? META))
  const writeChecked = vi.fn(over.writeChecked ?? (() => Promise.resolve({ ok: true, version: 'v2' })))
  const props = {
    id: 'n1', data: { filePath: over.path ?? '/x/app.json' }, selected: false,
    readMeta, writeChecked,
  }
  const r = render(<ReactFlowProvider><EditorNode {...(props as unknown as ComponentProps<typeof EditorNode>)} /></ReactFlowProvider>)
  return { ...r, readMeta, writeChecked }
}

/** Ketik (ubah buffer) lalu tekan ⌘S. */
function typeAndSave(value = 'ab') {
  fake.state.value = value
  act(() => fake.state.onChange())
  act(() => fake.state.save())
}

describe('EditorNode chrome', () => {
  it('menampilkan ikon codicon per ekstensi, dirty dot saat berubah, dan tema VS Code', async () => {
    const { container } = mount()
    await waitFor(() => expect(fake.state.createdWith).not.toBeNull())
    expect(container.querySelector('.editor-node__icon')?.className).toContain('codicon-json')
    expect(fake.state.createdWith).toMatchObject({ theme: 'webterm-dark-modern', minimap: { enabled: false } })

    expect(screen.queryByRole('img', { name: 'Unsaved changes' })).toBeNull()
    fake.state.value = 'ab'
    act(() => fake.state.onChange())
    expect(screen.getByRole('img', { name: 'Unsaved changes' }).className).toContain('codicon-circle-filled')
    expect(container.querySelector('.editor-node__name')?.textContent).not.toContain('●')
  })

  it('menampilkan breadcrumb path dan tidak lagi memaksa border atas berwarna swatch', async () => {
    const { container } = mount()
    await waitFor(() => expect(fake.state.createdWith).not.toBeNull())
    const crumbs = container.querySelector('nav.editor-node__crumbs, .editor-node__crumbs')
    expect(crumbs?.getAttribute('aria-label')).toBe('File path')
    expect(crumbs?.textContent).toContain('x')
    expect(crumbs?.textContent).toContain('app.json')
    expect(container.querySelector('.term-node')?.className).not.toContain('border-top-color')
  })

  it('mengganti tema Monaco saat data-theme berubah', async () => {
    mount()
    await waitFor(() => expect(fake.state.createdWith).not.toBeNull())
    document.documentElement.setAttribute('data-theme', 'light')
    await waitFor(() => expect(fake.state.setTheme).toHaveBeenCalledWith('webterm-light-modern'))
  })
})

describe('EditorNode language server hint', () => {
  const HINT = { message: 'TypeScript language server not found for this workspace.', command: 'npm install -D typescript-language-server typescript' }
  afterEach(() => setLspHint('typescript', null))

  it('shows the install command for a .ts file when no server exists, copies it, and dismisses', async () => {
    setLspHint('typescript', HINT)
    const { container } = mount({ path: '/x/a.ts' })
    await waitFor(() => expect(fake.state.createdWith).not.toBeNull())
    expect(screen.getByRole('status').textContent).toContain(HINT.command)
    fireEvent.click(screen.getByText('Copy command'))
    expect(clip.writeClipboard).toHaveBeenCalledWith(HINT.command)
    const dismiss = container.querySelector('.editor-node__lsp-hint vscode-toolbar-button')
    expect(dismiss).not.toBeNull()
    fireEvent.click(dismiss!)
    expect(screen.queryByText('Copy command')).toBeNull()
    expect(lspHint('typescript')).toBeNull()
  })

  it('shows nothing for a language the hint is not about', async () => {
    setLspHint('typescript', HINT)
    mount()
    await waitFor(() => expect(fake.state.createdWith).not.toBeNull())
    expect(screen.queryByText('Copy command')).toBeNull()
  })
})

describe('EditorNode simpan aman', () => {
  it('⌘S saat buffer bersih tidak memanggil write', async () => {
    const { writeChecked } = mount()
    await waitFor(() => expect(fake.state.createdWith).not.toBeNull())
    act(() => fake.state.save())
    expect(writeChecked).not.toHaveBeenCalled()
  })

  it('simpan mengirim expectedVersion+mustExist, lalu memakai version baru', async () => {
    const { writeChecked } = mount()
    await waitFor(() => expect(fake.state.createdWith).not.toBeNull())
    typeAndSave('ab')
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Unsaved changes' })).toBeNull())
    expect(writeChecked).toHaveBeenLastCalledWith('/x/app.json', 'ab', { expectedVersion: 'v1', mustExist: true })
    typeAndSave('abc')
    await waitFor(() => expect(writeChecked).toHaveBeenCalledTimes(2))
    expect(writeChecked).toHaveBeenLastCalledWith('/x/app.json', 'abc', { expectedVersion: 'v2', mustExist: true })
  })

  it('EVERSION -> bar Reload/Overwrite, buffer tak hilang; Overwrite memakai versi current', async () => {
    const w = vi.fn<WriteFn>()
      .mockResolvedValueOnce({ ok: false, code: 'EVERSION', error: 'changed', current: 'v9' })
      .mockResolvedValue({ ok: true, version: 'v10' })
    const { writeChecked } = mount({ writeChecked: w })
    await waitFor(() => expect(fake.state.createdWith).not.toBeNull())
    typeAndSave('mine')
    expect(await screen.findByText(/changed on disk/)).toBeTruthy()
    expect(screen.getByText('Reload')).toBeTruthy()
    expect(fake.state.value).toBe('mine')
    expect(screen.getByRole('img', { name: 'Unsaved changes' })).toBeTruthy()
    fireEvent.click(screen.getByText('Overwrite'))
    await waitFor(() => expect(screen.queryByText(/changed on disk/)).toBeNull())
    expect(writeChecked).toHaveBeenLastCalledWith('/x/app.json', 'mine', { expectedVersion: 'v9', mustExist: true })
  })

  it('EVERSION lalu Reload mengganti buffer dengan isi disk', async () => {
    const w = vi.fn<WriteFn>().mockResolvedValue({ ok: false, code: 'EVERSION', error: 'changed', current: 'v9' })
    const { readMeta } = mount({ writeChecked: w })
    await waitFor(() => expect(fake.state.createdWith).not.toBeNull())
    typeAndSave('mine')
    await screen.findByText('Reload')
    readMeta.mockResolvedValueOnce({ content: 'disk', version: 'v9', encoding: 'utf8' })
    fireEvent.click(screen.getByText('Reload'))
    await waitFor(() => expect(screen.queryByText(/changed on disk/)).toBeNull())
    expect(fake.state.value).toBe('disk')
    expect(screen.queryByRole('img', { name: 'Unsaved changes' })).toBeNull()
  })

  it('ENOENT -> bar "terhapus" tanpa Reload; tidak dibuat ulang sendiri, Recreate eksplisit', async () => {
    const w = vi.fn<WriteFn>()
      .mockResolvedValueOnce({ ok: false, code: 'ENOENT', error: 'gone' })
      .mockResolvedValue({ ok: true, version: 'v3' })
    const { writeChecked } = mount({ writeChecked: w })
    await waitFor(() => expect(fake.state.createdWith).not.toBeNull())
    typeAndSave('mine')
    expect(await screen.findByText(/was deleted on disk/)).toBeTruthy()
    expect(screen.queryByText('Reload')).toBeNull()
    expect(writeChecked).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Recreate'))
    await waitFor(() => expect(screen.queryByText(/was deleted on disk/)).toBeNull())
    expect(writeChecked).toHaveBeenLastCalledWith('/x/app.json', 'mine', {})
  })

  it('galat lain (mis. EACCES) tampil sebagai save-error dengan pesan server', async () => {
    mount({ writeChecked: () => Promise.resolve({ ok: false, code: 'EACCES', error: 'read-only fs' }) })
    await waitFor(() => expect(fake.state.createdWith).not.toBeNull())
    typeAndSave('x')
    expect((await screen.findByRole('alert')).textContent).toContain('read-only fs')
  })
})

describe('EditorNode biner & non-UTF-8', () => {
  it('encoding binary: Monaco tidak dimuat, tanpa Save, placeholder + Copy Path', async () => {
    mount({ meta: { content: '', version: 'v1', encoding: 'binary' } })
    expect(await screen.findByText(/Binary file/)).toBeTruthy()
    expect(fake.state.loadMonaco).not.toHaveBeenCalled()
    expect(screen.queryByText('Save')).toBeNull()
    fireEvent.click(screen.getByText('Copy Path'))
    expect(clip.writeClipboard).toHaveBeenCalledWith('/x/app.json')
  })

  it('non-utf8: editor read-only + banner, tanpa Save', async () => {
    mount({ meta: { content: 'caf?', version: 'v1', encoding: 'non-utf8' } })
    await waitFor(() => expect(fake.state.createdWith).toMatchObject({ readOnly: true }))
    expect(screen.getByText(/Bukan UTF-8/)).toBeTruthy()
    expect(screen.queryByText('Save')).toBeNull()
  })

  it('utf8 biasa: editor tidak read-only dan ada Save', async () => {
    mount()
    await waitFor(() => expect(fake.state.createdWith).toMatchObject({ readOnly: false }))
    expect(screen.getByText('Save')).toBeTruthy()
  })

  it('audio lewat ViewerHost, zip jadi placeholder; file tidak dibaca dan Monaco tidak dimuat', async () => {
    const audio = mount({ path: '/x/song.mp3' })
    await waitFor(() => expect(audio.container.querySelector('audio')).not.toBeNull())
    expect(audio.readMeta).not.toHaveBeenCalled()
    cleanup()
    const zip = mount({ path: '/x/a.zip' })
    await waitFor(() => expect(zip.container.querySelector('.viewer-placeholder')).not.toBeNull())
    expect(zip.readMeta).not.toHaveBeenCalled()
    expect(fake.state.loadMonaco).not.toHaveBeenCalled()
  })
})
