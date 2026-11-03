/** @vitest-environment jsdom */
// Slot watch: fswatch/fsunwatch sekali per dir (lintas node), dirty remote untuk dir itu -> refresh.
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilesSlotCtx } from './filesSlots'

const capabilities = vi.hoisted(() => vi.fn())
const send = vi.hoisted(() => vi.fn())
vi.mock('./fsClient', () => ({ capabilities }))
// onReconnect didaftarkan sekali saat modul diimpor: tangkap callback-nya untuk mensimulasikan reconnect.
const reconnect = vi.hoisted(() => ({ cb: (() => {}) as () => void }))
vi.mock('./ws', () => ({ send, onReconnect: (cb: () => void) => { reconnect.cb = cb; return () => {} } }))

import { emitFsEvent } from './fsEvents'
import { watchSlot } from './filesSlot.watch'

const useSlot = watchSlot.useSlot!
const ctx = (dir: string, refresh = vi.fn()): FilesSlotCtx =>
  ({ cwd: '/', dir, entries: [], selection: [], refresh, open: vi.fn(), startInput: vi.fn(), nodeId: 'n' })
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

beforeEach(() => { capabilities.mockResolvedValue({ watch: true }) })
afterEach(() => { cleanup(); capabilities.mockReset(); send.mockReset() })

describe('watchSlot', () => {
  it('mengirim fswatch sekali saat mount, fsunwatch saat unmount', async () => {
    const { unmount } = renderHook(() => useSlot(ctx('/a')))
    await waitFor(() => expect(send).toHaveBeenCalledWith({ t: 'fswatch', dir: '/a' }))
    expect(send).toHaveBeenCalledTimes(1)
    unmount()
    expect(send).toHaveBeenLastCalledWith({ t: 'fsunwatch', dir: '/a' })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('ganti dir: unwatch dir lama, watch dir baru', async () => {
    const { rerender } = renderHook(({ d }) => useSlot(ctx(d)), { initialProps: { d: '/a' } })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    rerender({ d: '/b' })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3))
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { t: 'fswatch', dir: '/a' }, { t: 'fsunwatch', dir: '/a' }, { t: 'fswatch', dir: '/b' },
    ])
  })

  it('dua node pada dir sama: satu fswatch, fsunwatch hanya saat node terakhir pergi', async () => {
    const one = renderHook(() => useSlot(ctx('/shared')))
    const two = renderHook(() => useSlot(ctx('/shared')))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    one.unmount()
    expect(send).toHaveBeenCalledTimes(1)
    two.unmount()
    expect(send).toHaveBeenLastCalledWith({ t: 'fsunwatch', dir: '/shared' })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('dirty remote untuk dir itu -> refresh; lokal atau dir lain tidak', async () => {
    const refresh = vi.fn()
    renderHook(() => useSlot(ctx('/a', refresh)))
    await waitFor(() => expect(send).toHaveBeenCalled())
    emitFsEvent({ kind: 'dirty', path: '/a', origin: 'local' })
    emitFsEvent({ kind: 'dirty', path: '/other', origin: 'remote' })
    emitFsEvent({ kind: 'written', path: '/a', origin: 'remote' })
    expect(refresh).not.toHaveBeenCalled()
    emitFsEvent({ kind: 'dirty', path: '/a', origin: 'remote' })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('berhenti mendengar setelah unmount', async () => {
    const refresh = vi.fn()
    const { unmount } = renderHook(() => useSlot(ctx('/a', refresh)))
    await waitFor(() => expect(send).toHaveBeenCalled())
    unmount()
    emitFsEvent({ kind: 'dirty', path: '/a', origin: 'remote' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('reconnect: kirim ulang fswatch tepat sekali per dir aktif; dir yang sudah di-unwatch tidak', async () => {
    const one = renderHook(() => useSlot(ctx('/a')))
    const two = renderHook(() => useSlot(ctx('/a')))
    const b = renderHook(() => useSlot(ctx('/b')))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2)) // /a sekali + /b
    await flush()
    b.unmount() // /b di-unwatch
    send.mockClear()
    reconnect.cb()
    expect(send.mock.calls.map((c) => c[0])).toEqual([{ t: 'fswatch', dir: '/a' }])
    one.unmount(); two.unmount()
    send.mockClear()
    reconnect.cb()
    expect(send).not.toHaveBeenCalled()
  })

  it('capabilities.watch false atau gagal: tidak mengirim apa pun', async () => {
    capabilities.mockResolvedValue({ watch: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const off = renderHook(() => useSlot(ctx('/a')))
    await flush(); await flush()
    off.unmount()
    capabilities.mockRejectedValue(new Error('down'))
    const bad = renderHook(() => useSlot(ctx('/b')))
    await waitFor(() => expect(warn).toHaveBeenCalled())
    bad.unmount()
    expect(send).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
