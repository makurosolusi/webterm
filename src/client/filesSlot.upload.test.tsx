/** @vitest-environment jsdom */
// Upload slot (WS-FM-10): capability gating, menu/Download, toolbar icon, and the per-node FIFO queue
// reported through the footer notice + progress bar (never the toolbar).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({
  capabilities: vi.fn(),
  resetCapabilitiesCache: vi.fn(),
  rawUrl: (p: string) => `/api/fs/raw?path=${encodeURIComponent(p)}`,
}))
vi.mock('./fsClient', () => fs)

import { noticesOf, resetFilesNotices } from './filesNotice'
import { NOTICE_TEXT } from './FilesNoticeLine'
import { UPLOAD_NOTICE, UPLOAD_TEXT, resetUploadSlot, uploadSlot } from './filesSlot.upload'
import { FakeXhr, Host, dropFiles, mkCtx, sent, settle } from './filesSlot.upload.harness'
import { resetFilesWriteOffer, WRITE_OFFER_TEXT } from './filesWriteOffer'
import { resetCapabilitiesCache } from './useCapabilities'

const caps = (o: object) => ({ mutate: true, viewers: true, watch: false, git: false, quickOpen: false, upload: true, listMax: 1, ...o })

beforeEach(() => {
  resetUploadSlot()
  resetFilesNotices()
  resetFilesWriteOffer()
  resetCapabilitiesCache()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    capabilities: [{ id: 'filesWrite', title: 'Edit and upload files', blurb: 'Edit, rename, delete, and upload files from the canvas.', status: 'off' }], advanced: {},
  }))))
  FakeXhr.reset()
  fs.capabilities.mockResolvedValue(caps({}))
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const foot = () => screen.getByTestId('foot').textContent
const mount = async (ctx = mkCtx()) => { render(<Host ctx={ctx} />); await settle(); return ctx }

describe('capabilities', () => {
  it('upload off: no menu, no overflow row, drop ignored', async () => {
    fs.capabilities.mockResolvedValue(caps({ upload: false }))
    await mount(mkCtx({ selection: ['a.txt'] }))
    expect(uploadSlot.menu?.(mkCtx({ selection: ['a.txt'] }))).toEqual([])
    expect(screen.getByTestId('toolbar').children).toHaveLength(0)
    const ev = dropFiles(screen.getByTestId('node'), ['x.txt'])
    expect(ev.defaultPrevented).toBe(false)
    expect(FakeXhr.all).toHaveLength(0)
  })
  it('filesWrite off (mutate+upload off): "Upload…" shows locked and opens the turn-on offer', async () => {
    fs.capabilities.mockResolvedValue(caps({ mutate: false, upload: false }))
    await mount()
    const rows = uploadSlot.menu!(mkCtx())
    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (!('onClick' in row)) throw new Error('no Upload row')
    expect(row.label).toBe(UPLOAD_TEXT.menuUpload)
    expect(row.hint).toBe(WRITE_OFFER_TEXT.lockedHint)
    const pick = vi.spyOn(HTMLInputElement.prototype, 'click')
    act(() => row.onClick())
    expect(await screen.findByText(/Turn it on now\?/)).toBeTruthy()
    expect(pick).not.toHaveBeenCalled()
  })
  it('capabilities throwing synchronously: slot does not crash, error logged, no upload menu', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    fs.capabilities.mockImplementation(() => { throw new Error('mock without export') })
    await mount(mkCtx({ selection: ['a.txt'] }))
    expect(screen.getByTestId('node')).toBeTruthy()
    expect(uploadSlot.menu?.(mkCtx({ selection: ['a.txt'] }))).toEqual([])
    expect(err).toHaveBeenCalled()
  })
})

describe('menu and toolbar', () => {
  it('"Upload…" always; "Download" only for exactly one selected file', async () => {
    await mount()
    const labels = (sel: string[]) => uploadSlot.menu!(mkCtx({ selection: sel })).flatMap((r) => ('label' in r ? [r.label] : []))
    expect(labels([])).toEqual([UPLOAD_TEXT.menuUpload])
    expect(labels(['sub'])).toEqual([UPLOAD_TEXT.menuUpload])
    expect(labels(['a.txt', 'sub'])).toEqual([UPLOAD_TEXT.menuUpload])
    expect(labels(['a.txt'])).toEqual([UPLOAD_TEXT.menuUpload, UPLOAD_TEXT.menuDownload])
  })
  it('viewers off: Download hidden (raw is gated by VIEWERS), Upload kept', async () => {
    fs.capabilities.mockResolvedValue(caps({ viewers: false }))
    await mount()
    expect(uploadSlot.menu!(mkCtx({ selection: ['a.txt'] }))).toHaveLength(1)
  })
  it('Download: temporary link to raw?download=1 with the download attribute, no new tab', async () => {
    await mount()
    const open = vi.spyOn(window, 'open')
    let clicked: HTMLAnchorElement | undefined
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked = this })
    const row = uploadSlot.menu!(mkCtx({ selection: ['a.txt'] })).find((r) => 'label' in r && r.label === UPLOAD_TEXT.menuDownload)
    if (!row || !('onClick' in row)) throw new Error('no Download row')
    row.onClick()
    expect(clicked?.getAttribute('href')).toBe('/api/fs/raw?path=%2Fp%2Fa.txt&download=1')
    expect(clicked?.download).toBe('a.txt')
    expect(open).not.toHaveBeenCalled()
    expect(document.querySelector('a[download]')).toBeNull()
  })
  it('overflow menu offers "Upload Files…" with an icon, which opens a hidden multiple file input', async () => {
    const ctx = await mount()
    const row = uploadSlot.overflow?.(ctx)[0]
    expect(row && 'label' in row ? [row.label, !!row.icon] : null).toEqual([UPLOAD_TEXT.toolbarUpload, true])
    let input: HTMLInputElement | undefined
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) { input = this })
    fireEvent.click(screen.getByRole('button', { name: UPLOAD_TEXT.toolbarUpload }))
    expect(input?.type).toBe('file')
    expect(input?.multiple).toBe(true)
    expect(input?.hidden).toBe(true)
    Object.defineProperty(input, 'files', { value: [new File(['1'], 'one.txt'), new File(['2'], 'two.txt')] })
    act(() => { input?.onchange?.(new Event('change')) })
    await waitFor(() => expect(foot()).toBe(UPLOAD_TEXT.done(2, 0)))
    expect(sent()).toEqual(['one.txt', 'two.txt'])
    expect(ctx.refresh).toHaveBeenCalledTimes(1)
  })
})

describe('queue + footer notice', () => {
  it('a drop while an upload runs joins the queue (not rejected); footer shows "Uploading i of n · name"', async () => {
    FakeXhr.hold = true
    const ctx = await mount()
    dropFiles(screen.getByTestId('node'), ['a.bin'])
    await settle()
    expect(foot()).toBe(UPLOAD_TEXT.progress(1, 1, 'a.bin'))
    dropFiles(screen.getByTestId('node'), ['b.bin'])
    await settle()
    expect(foot()).toBe(UPLOAD_TEXT.progress(1, 2, 'a.bin'))
    act(() => FakeXhr.all[0].reply())
    await settle()
    expect(foot()).toBe(UPLOAD_TEXT.progress(2, 2, 'b.bin'))
    act(() => FakeXhr.all[1].reply())
    await settle()
    expect(foot()).toBe('2 files uploaded')
    expect(noticesOf('n1').find((n) => n.id === UPLOAD_NOTICE)?.kind).toBe('info')
    expect(ctx.refresh).toHaveBeenCalledTimes(1)
  })
  it('progress bar is byte-based over the whole batch and goes away when done', async () => {
    FakeXhr.hold = true
    await mount()
    dropFiles(screen.getByTestId('node'), ['a.bin', 'b.bin']) // 2 bytes each
    await settle()
    act(() => FakeXhr.all[0].progress(1, 2))
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
    act(() => FakeXhr.all[0].reply())
    await settle()
    act(() => FakeXhr.all[1].progress(1, 2))
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('75')
    act(() => FakeXhr.all[1].reply())
    await settle()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })
  it('Cancel aborts the current request and drops the rest of the queue', async () => {
    FakeXhr.hold = true
    await mount()
    dropFiles(screen.getByTestId('node'), ['a.bin', 'b.bin', 'c.bin'])
    await settle()
    fireEvent.click(screen.getByRole('button', { name: NOTICE_TEXT.cancel }))
    await settle()
    expect(FakeXhr.all).toHaveLength(1)
    expect(FakeXhr.all[0].aborted).toBe(true)
    expect(foot()).toBe(UPLOAD_TEXT.cancelled(0))
  })
  it('failure stays until dismissed, names each file + reason; Retry re-sends the failed files only', async () => {
    FakeXhr.replyFor = (n) => (n === 'bad.txt' ? '{"ok":false,"code":"ETOOLARGE","error":"big"}' : '{"ok":true}')
    await mount()
    dropFiles(screen.getByTestId('node'), ['ok.txt', 'bad.txt'])
    await settle()
    expect(foot()).toBe('1 of 2 files failed — bad.txt: exceeds the upload size limit')
    expect(noticesOf('n1').find((n) => n.id === UPLOAD_NOTICE)?.kind).toBe('error')
    FakeXhr.replyFor = () => '{"ok":true}'
    fireEvent.click(screen.getByRole('button', { name: UPLOAD_TEXT.retry }))
    await settle()
    expect(sent()).toEqual(['ok.txt', 'bad.txt', 'bad.txt'])
    expect(foot()).toBe('1 file uploaded')
  })
  it('Dismiss clears a failure and the footer returns to the count', async () => {
    FakeXhr.replyFor = () => '{"ok":false,"code":"EACCES","error":"no"}'
    await mount()
    dropFiles(screen.getByTestId('node'), ['a.txt'])
    await settle()
    expect(foot()).toContain('a.txt: no permission to write to this folder')
    fireEvent.click(screen.getByRole('button', { name: NOTICE_TEXT.dismiss }))
    expect(foot()).toBe('2 of 2')
  })
  it('EDISABLED: the failure notice offers "Turn on…", which opens the offer', async () => {
    FakeXhr.replyFor = () => '{"ok":false,"code":"EDISABLED","error":"off"}'
    await mount()
    dropFiles(screen.getByTestId('node'), ['a.txt'])
    await settle()
    expect(foot()).toContain('a.txt: the “Edit and upload files” capability is off')
    fireEvent.click(screen.getByRole('button', { name: WRITE_OFFER_TEXT.enableAction }))
    expect(await screen.findByText(/Turn it on now\?/)).toBeTruthy()
  })
  it('queues are per node: an upload on n1 never shows on n2', async () => {
    FakeXhr.hold = true
    render(<><Host ctx={mkCtx()} /><Host ctx={mkCtx({ nodeId: 'n2' })} /></>)
    await settle()
    dropFiles(screen.getAllByTestId('node')[0], ['a.bin'])
    await settle()
    const [f1, f2] = screen.getAllByTestId('foot').map((f) => f.textContent)
    expect(f1).toBe(UPLOAD_TEXT.progress(1, 1, 'a.bin'))
    expect(f2).toBe('2 of 2')
  })
})
