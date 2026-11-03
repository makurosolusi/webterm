/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FileMeta, FsCapabilities, GitMark } from '../shared/fsContract'
import { emitFsEvent } from './fsEvents'
import { gitSlot } from './filesSlot.git'
import type { FilesSlotCtx } from './filesSlots'

const h = vi.hoisted(() => ({ caps: vi.fn(), status: vi.fn() }))
vi.mock('./fsClient', () => ({ capabilities: h.caps, gitStatus: h.status }))

const file = (name: string, dir = false): FileMeta => ({ name, dir, ignored: false })
const ctx = (over: Partial<FilesSlotCtx> = {}): FilesSlotCtx =>
  ({ cwd: '/r', dir: '/r', entries: [], selection: [], refresh: () => {}, open: () => {}, nodeId: 'n1', ...over })
const ok = (marks: Record<string, GitMark>) => ({ ok: true, marks })
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const caps = (git: boolean) => ({ git }) as FsCapabilities

beforeEach(() => { vi.useFakeTimers(); h.caps.mockResolvedValue(caps(true)) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

it('dekorasi: huruf+kelas untuk file, titik untuk folder, kosong tanpa mark', async () => {
  h.status.mockResolvedValue(ok({ 'a.txt': 'M', src: 'D', 'é.txt': 'U' }))
  const c = ctx()
  renderHook(() => gitSlot.useSlot!(c))
  await flush()
  expect(gitSlot.decorate!(file('a.txt'), c)).toEqual({ badge: 'M', title: 'Modified', className: 'files-git--M' })
  expect(gitSlot.decorate!(file('src', true), c)).toMatchObject({ badge: '•', className: 'files-git--D' })
  expect(gitSlot.decorate!(file('é.txt'), c)).toMatchObject({ badge: 'U' }) // NFD cocok kunci NFC
  expect(gitSlot.decorate!(file('clean.txt'), c)).toBeUndefined()
  expect(h.status).toHaveBeenCalledWith('/r')
})

it('capabilities.git=false: tidak memanggil git-status dan tanpa dekorasi', async () => {
  h.caps.mockResolvedValue(caps(false))
  const c = ctx()
  renderHook(() => gitSlot.useSlot!(c))
  await flush()
  emitFsEvent({ kind: 'dirty', path: '/r', origin: 'remote' })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(h.status).not.toHaveBeenCalled()
  expect(gitSlot.decorate!(file('a.txt'), c)).toBeUndefined()
})

it('event fs (lokal/remote) memuat ulang dengan debounce: badai event = satu panggilan', async () => {
  h.status.mockResolvedValueOnce(ok({ 'a.txt': 'M' })).mockResolvedValue(ok({ 'a.txt': 'A' }))
  const c = ctx()
  renderHook(() => gitSlot.useSlot!(c))
  await flush()
  expect(h.status).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 5; i++) emitFsEvent({ kind: 'written', path: '/r/a.txt', origin: i % 2 ? 'local' : 'remote' })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(h.status).toHaveBeenCalledTimes(2)
  expect(gitSlot.decorate!(file('a.txt'), c)).toMatchObject({ badge: 'A' })
})

it('unmount: marks dibuang dan event berikutnya tak memuat lagi', async () => {
  h.status.mockResolvedValue(ok({ 'a.txt': 'M' }))
  const c = ctx()
  const { unmount } = renderHook(() => gitSlot.useSlot!(c))
  await flush()
  unmount()
  emitFsEvent({ kind: 'dirty', path: '/r', origin: 'remote' })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(h.status).toHaveBeenCalledTimes(1)
  expect(gitSlot.decorate!(file('a.txt'), c)).toBeUndefined()
})

it('gagal git-status: dekorasi kosong, tidak melempar', async () => {
  h.status.mockResolvedValue({ ok: false, code: 'EIO', error: 'x' })
  const c = ctx()
  renderHook(() => gitSlot.useSlot!(c))
  await flush()
  expect(gitSlot.decorate!(file('a.txt'), c)).toBeUndefined()
})
