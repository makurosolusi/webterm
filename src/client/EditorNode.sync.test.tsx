/** @vitest-environment jsdom */
// WS-FM-02 fase 2: node editor ikut event bus fs (rename/delete/tulis remote) dan memasang ViewerHost.
// Monaco dipalsukan (yang diuji kabel React-nya); fsClient dipalsukan di batas modul.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlow } from '@xyflow/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installCanvasDom } from './canvasHarness'
import './vscode/test-setup'

const fake = vi.hoisted(() => {
  const state = { value: 'a', onChange: () => {}, loadMonaco: vi.fn(), created: 0 }
  const editor = {
    getValue: () => state.value,
    setValue: (v: string) => { state.value = v; state.onChange() },
    onDidChangeModelContent: (cb: () => void) => { state.onChange = cb },
    addAction: () => ({ dispose: () => {} }),
    updateOptions: () => {},
    getModel: () => null,
    onDidChangeCursorSelection: () => ({ dispose: () => {} }), onDidChangeModelOptions: () => ({ dispose: () => {} }), onDidChangeModelLanguage: () => ({ dispose: () => {} }),
    dispose: () => {},
  }
  const monaco = {
    Uri: { file: () => ({ with: () => 'uri' }) },
    KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 },
    editor: {
      getModel: () => null,
      createModel: () => ({ dispose: () => {} }),
      create: () => { state.created++; return editor },
      setTheme: vi.fn(),
    },
  }
  return { state, monaco }
})
vi.mock('./lazyMonaco', () => ({ loadMonaco: () => { fake.state.loadMonaco(); return Promise.resolve(fake.monaco) } }))
vi.mock('./clipboard', () => ({ writeClipboard: vi.fn() }))
const fsc = vi.hoisted(() => ({ statVersion: 'v1', statFail: null as null | string }))
vi.mock('./fsClient', () => ({
  capabilities: () => Promise.resolve({ mutate: true, viewers: true, watch: true, git: false, quickOpen: false, upload: false, listMax: 10 }),
  rawUrl: (p: string) => `/api/fs/raw?path=${encodeURIComponent(p)}&token=t`,
  stat: () => Promise.resolve(fsc.statFail
    ? { ok: false, code: fsc.statFail, error: 'x' }
    : { ok: true, version: fsc.statVersion, meta: { name: 'x', dir: false, ignored: false } }),
  readMeta: () => Promise.reject(new Error('default readMeta tak boleh dipakai')),
  writeChecked: () => Promise.reject(new Error('default writeChecked tak boleh dipakai')),
}))

import EditorNode from './EditorNode'
import { emitFsEvent } from './fsEvents'
import { openEditorFor } from './fileOpen'
import type { Node, NodeProps, ReactFlowInstance } from '@xyflow/react'

let rfRef: ReactFlowInstance | null = null
beforeAll(installCanvasDom)

afterEach(() => {
  cleanup(); rfRef = null
  fake.state.value = 'a'; fake.state.created = 0; fake.state.loadMonaco.mockClear()
  fsc.statVersion = 'v1'; fsc.statFail = null
})

type Meta = { content: string; version: string; encoding: 'utf8' }
/** Canvas React Flow sungguhan (mode tak-terkontrol): `updateNodeData` benar-benar mengubah props node. */
function mountNode(path: string, readMeta: unknown, writeChecked: unknown) {
  const nodeTypes = { editor: (p: NodeProps) => <EditorNode {...p} readMeta={readMeta as never} writeChecked={writeChecked as never} /> }
  const nodes: Node[] = [{ id: 'n1', type: 'editor', position: { x: 0, y: 0 }, data: { filePath: path }, width: 600, height: 400 }]
  return render(
    <div style={{ width: 900, height: 700 }}>
      <ReactFlow defaultNodes={nodes} nodeTypes={nodeTypes} onInit={(rf) => { rfRef = rf }} />
    </div>
  )
}

function mount(path = '/x/app.json', metas: Meta[] = [{ content: 'a', version: 'v1', encoding: 'utf8' }]) {
  let i = 0
  const readMeta = vi.fn(() => Promise.resolve(metas[Math.min(i++, metas.length - 1)]))
  const writeChecked = vi.fn(() => Promise.resolve({ ok: true, version: 'v2' }))
  return { ...mountNode(path, readMeta, writeChecked), readMeta, writeChecked }
}
const ready = () => waitFor(() => expect(fake.state.created).toBe(1))
const typed = (v: string) => { fake.state.value = v; act(() => fake.state.onChange()) }
const filePathOf = () => (rfRef!.getNode('n1')!.data as { filePath: string }).filePath

describe('renamed', () => {
  it('mengganti filePath node + judul, buffer dirty tidak hilang, dan openEditorFor memakai path BARU', async () => {
    const { container, readMeta } = mount('/x/old.json')
    await ready()
    typed('edit')
    act(() => emitFsEvent({ kind: 'renamed', path: '/x/new.json', from: '/x/old.json', origin: 'local' }))
    await waitFor(() => expect(container.querySelector('.node-header .node-title')?.textContent).toContain('new.json'))
    expect(filePathOf()).toBe('/x/new.json')
    expect(openEditorFor(rfRef!.getNodes(), '/x/new.json')).toBe('n1')
    expect(openEditorFor(rfRef!.getNodes(), '/x/old.json')).toBeNull()
    expect(fake.state.value).toBe('edit')
    expect(fake.state.created).toBe(1) // editor tidak dipasang ulang
    expect(readMeta).toHaveBeenCalledTimes(1)
  })

  it('rename folder induk memindahkan file di dalamnya; rename lain diabaikan', async () => {
    mount('/w/dir/sub/a.ts')
    await ready()
    act(() => emitFsEvent({ kind: 'renamed', path: '/w/other', from: '/w/oth', origin: 'local' }))
    expect(filePathOf()).toBe('/w/dir/sub/a.ts')
    act(() => emitFsEvent({ kind: 'renamed', path: '/w/moved', from: '/w/dir', origin: 'local' }))
    await waitFor(() => expect(filePathOf()).toBe('/w/moved/sub/a.ts'))
  })

  it('a title that was the old file name follows the rename; a custom title stays', async () => {
    const { container } = mount('/x/old.json')
    await ready()
    const title = () => container.querySelector('.node-header .node-title')?.textContent
    act(() => rfRef!.updateNodeData('n1', { title: 'old.json' })) // how Quick Open opens a file
    act(() => emitFsEvent({ kind: 'renamed', path: '/x/new.json', from: '/x/old.json', origin: 'local' }))
    await waitFor(() => expect(title()).toBe('new.json'))
    act(() => rfRef!.updateNodeData('n1', { title: 'Config' }))
    act(() => emitFsEvent({ kind: 'renamed', path: '/x/newer.json', from: '/x/new.json', origin: 'local' }))
    await waitFor(() => expect(filePathOf()).toBe('/x/newer.json'))
    expect(title()).toBe('Config')
  })

  it('simpan sesudah rename menulis ke path baru', async () => {
    const { writeChecked } = mount('/x/old.json')
    await ready()
    act(() => emitFsEvent({ kind: 'renamed', path: '/x/new.json', from: '/x/old.json', origin: 'local' }))
    await waitFor(() => expect(filePathOf()).toBe('/x/new.json'))
    typed('z')
    fake.state.onChange()
    fireEvent.contextMenu(document.querySelector('.editor-node .node-header')!)
    act(() => screen.getByRole('menuitem', { name: /^Save/ }).click())
    await waitFor(() => expect(writeChecked).toHaveBeenCalled())
    expect((writeChecked.mock.calls as unknown[][])[0][0]).toBe('/x/new.json')
  })
})

describe('deleted', () => {
  it('menampilkan bar "terhapus" tanpa Reload dan buffer tetap', async () => {
    mount()
    await ready()
    typed('keep me')
    act(() => emitFsEvent({ kind: 'deleted', path: '/x/app.json', origin: 'remote' }))
    expect((await screen.findByRole('alert')).textContent).toContain('was deleted')
    expect(screen.queryByText('Reload')).toBeNull()
    expect(fake.state.value).toBe('keep me')
  })

  it('folder induk terhapus juga menandai file; path lain tidak', async () => {
    mount('/w/dir/a.ts')
    await ready()
    act(() => emitFsEvent({ kind: 'deleted', path: '/w/dir2', origin: 'local' }))
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => emitFsEvent({ kind: 'deleted', path: '/w/dir', origin: 'local' }))
    expect((await screen.findByRole('alert')).textContent).toContain('was deleted')
  })
})

describe('written remote', () => {
  it('buffer bersih: auto-reload isi disk, tanpa bar', async () => {
    const { readMeta } = mount('/x/app.json', [
      { content: 'a', version: 'v1', encoding: 'utf8' },
      { content: 'DISK', version: 'v2', encoding: 'utf8' }
    ])
    await ready()
    act(() => emitFsEvent({ kind: 'written', path: '/x/app.json', origin: 'remote' }))
    await waitFor(() => expect(fake.state.value).toBe('DISK'))
    expect(readMeta).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('buffer dirty: bar konflik dan buffer pengguna tidak tersentuh, tanpa baca ulang', async () => {
    const { readMeta } = mount()
    await ready()
    typed('mine')
    act(() => emitFsEvent({ kind: 'written', path: '/x/app.json', origin: 'remote' }))
    expect((await screen.findByRole('alert')).textContent).toContain('changed on disk')
    expect(fake.state.value).toBe('mine')
    expect(readMeta).toHaveBeenCalledTimes(1)
  })

  it('pengguna mengetik selagi reload berjalan: jadi konflik, bukan menimpa ketikan', async () => {
    let release: (m: Meta) => void = () => {}
    const slow = new Promise<Meta>((r) => { release = r })
    const readMeta = vi.fn()
      .mockResolvedValueOnce({ content: 'a', version: 'v1', encoding: 'utf8' })
      .mockReturnValueOnce(slow)
    mountNode('/x/a.json', readMeta, vi.fn())
    await ready()
    act(() => emitFsEvent({ kind: 'written', path: '/x/a.json', origin: 'remote' }))
    typed('typed meanwhile')
    release({ content: 'DISK', version: 'v2', encoding: 'utf8' })
    expect((await screen.findByRole('alert')).textContent).toContain('changed on disk')
    expect(fake.state.value).toBe('typed meanwhile')
  })

  it('written local atau path lain diabaikan', async () => {
    const { readMeta } = mount()
    await ready()
    act(() => emitFsEvent({ kind: 'written', path: '/x/app.json', origin: 'local' }))
    act(() => emitFsEvent({ kind: 'written', path: '/x/other.json', origin: 'remote' }))
    await new Promise((r) => setTimeout(r, 30))
    expect(readMeta).toHaveBeenCalledTimes(1)
  })
})

describe('dirty (direktori) -> stat', () => {
  const dirty = () => act(() => emitFsEvent({ kind: 'dirty', path: '/x', origin: 'remote' }))

  it('versi disk beda -> auto-reload; versi sama (gema simpan sendiri) -> tidak ada apa-apa', async () => {
    const { readMeta } = mount('/x/app.json', [
      { content: 'a', version: 'v1', encoding: 'utf8' },
      { content: 'DISK', version: 'v9', encoding: 'utf8' }
    ])
    await ready()
    fsc.statVersion = 'v1'
    dirty()
    await new Promise((r) => setTimeout(r, 450))
    expect(readMeta).toHaveBeenCalledTimes(1)
    fsc.statVersion = 'v9'
    dirty(); dirty() // debounce: satu stat
    await waitFor(() => expect(fake.state.value).toBe('DISK'), { timeout: 2000 })
    expect(readMeta).toHaveBeenCalledTimes(2)
  })

  it('versi beda + dirty -> konflik; stat ENOENT -> bar terhapus', async () => {
    mount()
    await ready()
    typed('mine')
    fsc.statVersion = 'v7'
    dirty()
    expect((await screen.findByRole('alert', undefined, { timeout: 2000 })).textContent).toContain('changed on disk')
    fsc.statFail = 'ENOENT'
    dirty()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('was deleted'), { timeout: 2000 })
    expect(fake.state.value).toBe('mine')
  })

  it('direktori lain tidak memicu stat', async () => {
    const { readMeta } = mount()
    await ready()
    fsc.statVersion = 'v7'
    act(() => emitFsEvent({ kind: 'dirty', path: '/elsewhere', origin: 'remote' }))
    await new Promise((r) => setTimeout(r, 450))
    expect(readMeta).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('ViewerHost untuk non-teks', () => {
  it('gambar: <img> dari URL raw, tanpa readMeta/Monaco/readBinary', async () => {
    const { container, readMeta } = mount('/x/pic.png')
    const img = await waitFor(() => {
      const el = container.querySelector('img')
      expect(el).not.toBeNull()
      return el!
    })
    expect(img.getAttribute('src')).toBe('/api/fs/raw?path=%2Fx%2Fpic.png&token=t')
    expect(readMeta).not.toHaveBeenCalled()
    expect(fake.state.loadMonaco).not.toHaveBeenCalled()
  })

  it('audio dan video memakai elemen native; pdf memakai iframe', async () => {
    for (const [file, sel] of [['s.mp3', 'audio'], ['m.mp4', 'video'], ['d.pdf', 'iframe']] as const) {
      const { container, unmount } = mount(`/x/${file}`)
      await waitFor(() => expect(container.querySelector(sel)).not.toBeNull())
      unmount()
    }
    expect(fake.state.loadMonaco).not.toHaveBeenCalled()
  })

  it('stat mendeteksi perubahan -> URL viewer ikut versi baru; hapus -> notice', async () => {
    const { container } = mount('/x/pic.png')
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    await act(async () => { await Promise.resolve() }) // baseline stat awal ('v1')
    fsc.statVersion = 'v2'
    act(() => emitFsEvent({ kind: 'dirty', path: '/x', origin: 'remote' }))
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toContain('&v=v2'), { timeout: 2000 })
    act(() => emitFsEvent({ kind: 'deleted', path: '/x/pic.png', origin: 'local' }))
    expect(await screen.findByText(/was deleted on disk/)).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })

  it('rename gambar mengganti path viewer', async () => {
    const { container } = mount('/x/pic.png')
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    act(() => emitFsEvent({ kind: 'renamed', path: '/x/pic2.png', from: '/x/pic.png', origin: 'local' }))
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toContain('pic2.png'))
  })
})
