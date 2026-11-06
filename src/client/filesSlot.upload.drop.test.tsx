/** @vitest-environment jsdom */
// OS file drop onto a Files node (VS Code Explorer): node/row highlight, target folder, hint, clearing.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({
  capabilities: vi.fn(),
  resetCapabilitiesCache: vi.fn(),
  rawUrl: (p: string) => `/api/fs/raw?path=${encodeURIComponent(p)}`,
}))
vi.mock('./fsClient', () => fs)

import { resetFilesNotices } from './filesNotice'
import { DND_MIME } from './filesSlot.dnd'
import { UPLOAD_TEXT, resetUploadSlot } from './filesSlot.upload'
import { DROP_ROW_ATTR, filesFromDrop, isOsFileDrag } from './filesSlot.upload.drop'
import { FakeXhr, Host, drag, mkCtx, settle } from './filesSlot.upload.harness'

const caps = { mutate: true, viewers: true, watch: false, git: false, quickOpen: false, upload: true, listMax: 1 }

beforeEach(() => {
  resetUploadSlot()
  resetFilesNotices()
  FakeXhr.reset()
  fs.capabilities.mockResolvedValue(caps)
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const body = () => screen.getByTestId('body')
const nameOf = (row: string) => screen.getByTestId(`row-${row}`).querySelector('.files-name') as Element
const dirs = () => FakeXhr.all.map((x) => x.q.get('dir'))
const mount = async () => { render(<Host ctx={mkCtx()} />); await settle() }

describe('isOsFileDrag / filesFromDrop', () => {
  it('only OS files count; an internal path drag never does', () => {
    const dt = (types: string[]) => ({ types }) as unknown as DataTransfer
    expect(isOsFileDrag(dt(['Files']))).toBe(true)
    expect(isOsFileDrag(dt(['Files', DND_MIME]))).toBe(false)
    expect(isOsFileDrag(dt(['text/plain']))).toBe(false)
    expect(isOsFileDrag(null)).toBe(false)
  })
  it('directory entries are skipped and named', () => {
    const f = (n: string) => new File(['x'], n)
    const item = (file: File, dir: boolean) => ({ kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: dir }) })
    const dt = { items: [item(f('a.txt'), false), item(f('pics'), true)], files: [] } as unknown as DataTransfer
    const r = filesFromDrop(dt)
    expect(r.files.map((x) => x.name)).toEqual(['a.txt'])
    expect(r.skipped).toEqual(['pics'])
  })
})

describe('drop target', () => {
  it('over a folder row: only that row is the target, hint names it, drop uploads into it', async () => {
    await mount()
    drag(nameOf('sub'), 'dragenter')
    const ev = drag(nameOf('sub'), 'dragover')
    expect(ev.defaultPrevented).toBe(true)
    expect(body().dataset.uploadDrop).toBe('row')
    expect(screen.getByTestId('row-sub').hasAttribute(DROP_ROW_ATTR)).toBe(true)
    expect(screen.getByTestId('row-a.txt').hasAttribute(DROP_ROW_ATTR)).toBe(false)
    expect(body().dataset.dropHint).toBe(UPLOAD_TEXT.dropHint('sub'))
    drag(nameOf('sub'), 'drop', ['x.txt'])
    await settle()
    expect(dirs()).toEqual(['/p/sub'])
    expect(body().dataset.uploadDrop).toBeUndefined()
    expect(screen.getByTestId('row-sub').hasAttribute(DROP_ROW_ATTR)).toBe(false)
  })

  it('over a file row or empty area: the current folder is the target and the whole node lights up', async () => {
    await mount()
    drag(nameOf('a.txt'), 'dragenter')
    drag(nameOf('a.txt'), 'dragover')
    expect(body().dataset.uploadDrop).toBe('node')
    expect(document.querySelector(`[${DROP_ROW_ATTR}]`)).toBeNull()
    expect(body().dataset.dropHint).toBe(UPLOAD_TEXT.dropHint('p'))
    drag(screen.getByTestId('list'), 'dragover')
    expect(body().dataset.uploadDrop).toBe('node')
    drag(nameOf('a.txt'), 'drop', ['x.txt'])
    drag(screen.getByTestId('list'), 'drop', ['y.txt'])
    await settle()
    expect(dirs()).toEqual(['/p', '/p'])
  })

  it('moving from a folder row to the empty area moves the highlight off the row', async () => {
    await mount()
    drag(nameOf('sub'), 'dragenter')
    drag(screen.getByTestId('list'), 'dragover')
    expect(screen.getByTestId('row-sub').hasAttribute(DROP_ROW_ATTR)).toBe(false)
    expect(body().dataset.uploadDrop).toBe('node')
  })

  it('depth counter: leaving a child keeps the highlight; leaving the node clears it', async () => {
    await mount()
    drag(body(), 'dragenter')
    drag(nameOf('a.txt'), 'dragenter')
    drag(body(), 'dragleave')
    expect(body().dataset.uploadDrop).toBe('node')
    drag(nameOf('a.txt'), 'dragleave')
    expect(body().dataset.uploadDrop).toBeUndefined()
    expect(body().dataset.dropHint).toBeUndefined()
  })

  it('Esc and a drop elsewhere on the page clear every drop state', async () => {
    await mount()
    drag(nameOf('sub'), 'dragenter')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(body().dataset.uploadDrop).toBeUndefined()
    expect(screen.getByTestId('row-sub').hasAttribute(DROP_ROW_ATTR)).toBe(false)
    drag(nameOf('sub'), 'dragenter')
    window.dispatchEvent(new Event('drop'))
    expect(body().dataset.uploadDrop).toBeUndefined()
  })

  it('an internal path drag neither highlights nor is intercepted', async () => {
    await mount()
    drag(nameOf('sub'), 'dragenter', ['x'], ['Files', DND_MIME])
    expect(body().dataset.uploadDrop).toBeUndefined()
    const ev = drag(nameOf('sub'), 'drop', ['x'], [DND_MIME])
    expect(ev.defaultPrevented).toBe(false)
    expect(FakeXhr.all).toHaveLength(0)
  })

  it('dropped folders are skipped with a footer notice; the files still upload', async () => {
    await mount()
    const ev = new Event('drop', { bubbles: true, cancelable: true })
    const item = (n: string, dir: boolean) => ({ kind: 'file', getAsFile: () => new File(['x'], n), webkitGetAsEntry: () => ({ isDirectory: dir }) })
    Object.assign(ev, { dataTransfer: { types: ['Files'], files: [], items: [item('a.bin', false), item('pics', true)] } })
    body().dispatchEvent(ev)
    await settle()
    expect(FakeXhr.all.map((x) => x.q.get('name'))).toEqual(['a.bin'])
    // The batch result is newer, so it is shown; the folder note stays underneath until dismissed.
    expect(screen.getByTestId('foot').textContent).toBe('1 file uploaded')
  })
})
