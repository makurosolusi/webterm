/** @vitest-environment jsdom */
// Slot upload (WS-FM-10): menu terkunci capabilities, download tanpa tab baru, drop file OS, status toolbar.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({
  capabilities: vi.fn(),
  rawUrl: (p: string) => `/api/fs/raw?path=${encodeURIComponent(p)}`,
}))
vi.mock('./fsClient', () => fs)

import type { FileMeta } from '../shared/fsContract'
import type { FilesSlotCtx } from './filesSlots'
import { UPLOAD_TEXT, resetUploadSlot, uploadSlot, uploadStatus } from './filesSlot.upload'

const caps = (o: object) => ({ mutate: true, viewers: true, watch: false, git: false, quickOpen: false, upload: true, listMax: 1, ...o })
const entries: FileMeta[] = [{ name: 'a.txt', dir: false, ignored: false }, { name: 'sub', dir: true, ignored: false }]
const mkCtx = (o: Partial<FilesSlotCtx> = {}): FilesSlotCtx => ({
  cwd: '/p', dir: '/p', entries, selection: [], refresh: vi.fn(), open: vi.fn(), nodeId: 'n1', ...o,
})

/** Meniru FilesNode: memanggil useSlot tiap render, menampilkan toolbar, dan elemen node ber-data-id. */
function Host({ ctx }: { ctx: FilesSlotCtx }): ReactNode {
  uploadSlot.useSlot?.(ctx)
  return <div data-id={ctx.nodeId} data-testid="node">{uploadSlot.toolbar?.(ctx)}</div>
}

class FakeXhr {
  static calls: Array<{ url: string; sent: unknown }> = []
  static replyFor: (name: string) => string = () => '{"ok":true}'
  upload: { onprogress?: (e: unknown) => void } = {}
  onload?: () => void
  status = 200; responseText = ''; url = ''
  open(_m: string, u: string) { this.url = u }
  send(b: unknown) {
    FakeXhr.calls.push({ url: this.url, sent: b })
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 })
    this.responseText = FakeXhr.replyFor(new URL(this.url, 'http://x').searchParams.get('name') ?? '')
    queueMicrotask(() => this.onload?.())
  }
}

beforeEach(() => {
  resetUploadSlot()
  FakeXhr.calls = []
  FakeXhr.replyFor = () => '{"ok":true}'
  fs.capabilities.mockResolvedValue(caps({}))
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const settle = () => act(async () => {})
const dropFiles = (el: Element, names: string[]) => {
  const files = names.map((n) => new File(['x'], n))
  const dt = { types: ['Files'], files, items: [] as unknown[], dropEffect: '' }
  const ev = new Event('drop', { bubbles: true, cancelable: true })
  Object.assign(ev, { dataTransfer: dt })
  act(() => { el.dispatchEvent(ev) })
  return ev
}

describe('capabilities', () => {
  it('upload off: tanpa menu, tanpa toolbar, drop diabaikan', async () => {
    fs.capabilities.mockResolvedValue(caps({ upload: false }))
    render(<Host ctx={mkCtx({ selection: ['a.txt'] })} />)
    await settle()
    expect(uploadSlot.menu?.(mkCtx({ selection: ['a.txt'] }))).toEqual([])
    const ev = dropFiles(screen.getByTestId('node'), ['x.txt'])
    expect(ev.defaultPrevented).toBe(false)
    expect(FakeXhr.calls).toHaveLength(0)
  })
  it('capabilities melempar sinkron: slot tidak crash, galat dicatat, tanpa menu upload', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    fs.capabilities.mockImplementation(() => { throw new Error('mock tanpa export') })
    render(<Host ctx={mkCtx({ selection: ['a.txt'] })} />)
    await settle()
    expect(screen.getByTestId('node')).toBeTruthy()
    expect(uploadSlot.menu?.(mkCtx({ selection: ['a.txt'] }))).toEqual([])
    expect(err).toHaveBeenCalled()
  })
  it('capabilities gagal (fail-closed) -> sama dengan off', async () => {
    fs.capabilities.mockResolvedValue(caps({ upload: false, viewers: false }))
    render(<Host ctx={mkCtx()} />)
    await settle()
    expect(uploadSlot.menu?.(mkCtx())).toEqual([])
  })
})

describe('menu', () => {
  it('upload on: "Upload…" selalu; "Download" hanya untuk satu file terpilih (bukan folder / multi / kosong)', async () => {
    render(<Host ctx={mkCtx()} />)
    await settle()
    const labels = (sel: string[]) => uploadSlot.menu!(mkCtx({ selection: sel })).flatMap((r) => ('label' in r ? [r.label] : []))
    expect(labels([])).toEqual([UPLOAD_TEXT.menuUpload])
    expect(labels(['sub'])).toEqual([UPLOAD_TEXT.menuUpload])
    expect(labels(['a.txt', 'sub'])).toEqual([UPLOAD_TEXT.menuUpload])
    expect(labels(['a.txt'])).toEqual([UPLOAD_TEXT.menuUpload, UPLOAD_TEXT.menuDownload])
  })
  it('viewers off: Download hilang (raw dikunci VIEWERS), Upload tetap', async () => {
    fs.capabilities.mockResolvedValue(caps({ viewers: false }))
    render(<Host ctx={mkCtx()} />)
    await settle()
    expect(uploadSlot.menu!(mkCtx({ selection: ['a.txt'] }))).toHaveLength(1)
  })
  it('Download: tautan sementara ke raw?download=1 dengan atribut download, tanpa tab baru', async () => {
    render(<Host ctx={mkCtx()} />)
    await settle()
    const open = vi.spyOn(window, 'open')
    let clicked: HTMLAnchorElement | undefined
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked = this })
    const row = uploadSlot.menu!(mkCtx({ selection: ['a.txt'] })).find((r) => 'label' in r && r.label === UPLOAD_TEXT.menuDownload)
    if (!row || !('onClick' in row)) throw new Error('baris Download tidak ada')
    row.onClick()
    expect(clicked?.getAttribute('href')).toBe('/api/fs/raw?path=%2Fp%2Fa.txt&download=1')
    expect(clicked?.download).toBe('a.txt')
    expect(clicked?.target).toBe('')
    expect(open).not.toHaveBeenCalled()
    expect(document.querySelector('a[download]')).toBeNull()
  })
  it('Upload…: input file tersembunyi `multiple`; pilihan diunggah berurutan lalu refresh', async () => {
    render(<Host ctx={mkCtx()} />)
    await settle()
    let input: HTMLInputElement | undefined
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) { input = this })
    const ctx = mkCtx()
    const row = uploadSlot.menu!(ctx)[0]
    if (!('onClick' in row)) throw new Error('baris Upload tidak ada')
    row.onClick()
    expect(input?.type).toBe('file')
    expect(input?.multiple).toBe(true)
    expect(input?.hidden).toBe(true)
    Object.defineProperty(input, 'files', { value: [new File(['1'], 'one.txt'), new File(['2'], 'two.txt')] })
    await act(async () => { input?.onchange?.(new Event('change')); await new Promise((r) => setTimeout(r, 10)) })
    expect(FakeXhr.calls.map((c) => new URL(c.url, 'http://x').searchParams.get('name'))).toEqual(['one.txt', 'two.txt'])
    expect(ctx.refresh).toHaveBeenCalledTimes(1)
  })
})

describe('drop file OS', () => {
  it('drop meng-upload ke ctx.dir, refresh sekali, ringkasan tampil di toolbar', async () => {
    const ctx = mkCtx({ dir: '/p/x' })
    render(<Host ctx={ctx} />)
    await settle()
    const ev = dropFiles(screen.getByTestId('node'), ['a.bin', 'b.bin'])
    expect(ev.defaultPrevented).toBe(true)
    await waitFor(() => expect(uploadStatus().summary?.ok).toEqual(['a.bin', 'b.bin']))
    expect(FakeXhr.calls.map((c) => new URL(c.url, 'http://x').searchParams.get('dir'))).toEqual(['/p/x', '/p/x'])
    expect(ctx.refresh).toHaveBeenCalledTimes(1)
    await screen.findByText(UPLOAD_TEXT.summary(2, 0))
  })
  it('bentrok nama: galat jelas per file, file lain tetap naik, tanpa overwrite diam-diam', async () => {
    FakeXhr.replyFor = (n) => (n === 'dup.txt' ? '{"ok":false,"code":"EEXIST","error":"e"}' : '{"ok":true}')
    render(<Host ctx={mkCtx()} />)
    await settle()
    dropFiles(screen.getByTestId('node'), ['dup.txt', 'new.txt'])
    await waitFor(() => expect(uploadStatus().summary).not.toBeNull())
    const s = uploadStatus().summary!
    expect(s.ok).toEqual(['new.txt'])
    expect(s.failed[0].message).toContain('dup.txt')
    expect(s.failed[0].message).toContain('tidak ditimpa')
    const btn = await screen.findByRole('status')
    expect(btn.getAttribute('title')).toContain('dup.txt')
    fireEvent.click(btn)
    expect(uploadStatus().summary).toBeNull()
  })
  it('drag non-file (path internal) tidak dicegat', async () => {
    render(<Host ctx={mkCtx()} />)
    await settle()
    const ev = new Event('drop', { bubbles: true, cancelable: true })
    Object.assign(ev, { dataTransfer: { types: ['application/x-webterm-path'], files: [], items: [] } })
    act(() => { screen.getByTestId('node').dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(false)
    expect(FakeXhr.calls).toHaveLength(0)
  })
})
