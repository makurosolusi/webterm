/**
 * @vitest-environment jsdom
 *
 * jsdom, bukan node-env: yang diuji HOOK React, dan `renderHook` butuh container. Tidak ada canvas
 * yang dimount di sini — React Flow dipalsukan sebagai satu objek spy, karena yang dijaga memang
 * bukan React Flow-nya melainkan WIRING-nya: durasi animasi, jeda sync yang harus LEBIH PANJANG
 * dari animasinya, zoom yang diteruskan eksplisit, dan langkah riwayat gagal yang harus inert.
 *
 * KENAPA ADA: sebelum ini, `onBack`/`onForward` dan seluruh jalur zoom/fit tidak punya SATU pun test
 * (`history.test.ts` menguji tumpukan murninya, bukan pengikatannya ke state). Semuanya baru
 * dipindah keluar dari App.tsx, dan refactor tanpa jaring persis seperti ini yang menghasilkan
 * closure basi yang lolos dari typecheck. Kembarannya: `./layoutHistory.test.tsx`.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactFlowInstance } from '@xyflow/react'
import { useCanvasViewport } from './canvasViewport'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { Viewport } from '../shared/workspace'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const vp = (x: number, zoom = 1): Viewport => ({ x, y: 0, zoom })

/** Instance React Flow tiruan. `getViewport` memulangkan apa pun yang disetel `at`, supaya test
 *  bisa memerankan "animasi sudah selesai, viewport sekarang begini". */
function fakeRf() {
  let now: Viewport = DEFAULT_VIEWPORT
  return {
    at(v: Viewport) { now = v },
    getViewport: vi.fn(() => now),
    fitView: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomTo: vi.fn(),
    setViewport: vi.fn(),
  }
}

function mountViewport() {
  const fake = fakeRf()
  const rf = { current: fake as unknown as ReactFlowInstance }
  const viewportRef = { current: DEFAULT_VIEWPORT }
  const scheduleSave = vi.fn()
  const hook = renderHook(() => useCanvasViewport({ rf, viewportRef, scheduleSave }))
  return { ...hook, fake, viewportRef, scheduleSave }
}

describe('useCanvasViewport — zoom & fit', () => {
  it('fit beranimasi 300ms dan menyinkronkan readout SESUDAHNYA, bukan sebelum', () => {
    const { result, fake, viewportRef, scheduleSave } = mountViewport()
    fake.at(vp(50, 0.4))
    act(() => result.current.onFit())
    expect(fake.fitView).toHaveBeenCalledWith({ duration: 300 })
    // Jeda sync > durasi animasi: dibaca lebih awal, yang terbaca adalah frame di tengah animasi.
    act(() => vi.advanceTimersByTime(300))
    expect(scheduleSave).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(20))
    expect(viewportRef.current).toEqual(vp(50, 0.4))
    expect(result.current.zoom).toBe(0.4)
    expect(scheduleSave).toHaveBeenCalledTimes(1)
  })

  it('zoom in/out memakai durasi 150 dan sync 170 — satu definisi, dua pemakai (Dock + menu konteks)', () => {
    const { result, fake, scheduleSave } = mountViewport()
    act(() => result.current.onZoomIn())
    expect(fake.zoomIn).toHaveBeenCalledWith({ duration: 150 })
    act(() => vi.advanceTimersByTime(150))
    expect(scheduleSave).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(20))
    expect(scheduleSave).toHaveBeenCalledTimes(1)

    act(() => result.current.onZoomOut())
    expect(fake.zoomOut).toHaveBeenCalledWith({ duration: 150 })
  })

  it('onZoomTo menerima PERSEN dan meneruskannya sebagai faktor', () => {
    const { result, fake } = mountViewport()
    act(() => result.current.onZoomTo(250))
    expect(fake.zoomTo).toHaveBeenCalledWith(2.5, { duration: 150 })
  })

  it('tanpa instance React Flow tidak melempar, dan tidak mem-persist apa pun', () => {
    const rf = { current: null }
    const viewportRef = { current: DEFAULT_VIEWPORT }
    const scheduleSave = vi.fn()
    const { result } = renderHook(() => useCanvasViewport({ rf, viewportRef, scheduleSave }))
    act(() => result.current.onFit())
    act(() => vi.advanceTimersByTime(1000))
    expect(scheduleSave).not.toHaveBeenCalled()
  })
})

describe('useCanvasViewport — riwayat pandangan', () => {
  it('onMoveEnd mencatat langkah, memperbarui readout, dan mem-persist', () => {
    const { result, viewportRef, scheduleSave } = mountViewport()
    expect(result.current.canBack).toBe(false)
    act(() => result.current.onMoveEnd(null, vp(10, 0.5)))
    expect(viewportRef.current).toEqual(vp(10, 0.5))
    expect(result.current.zoom).toBe(0.5)
    expect(scheduleSave).toHaveBeenCalledTimes(1)
    // Satu entri saja belum bisa di-back: butuh entri awal dari `resetViewport`.
    expect(result.current.canBack).toBe(false)
  })

  it('back/forward menelusuri riwayat dan mengumumkan ulang tombolnya', () => {
    const { result, fake } = mountViewport()
    act(() => result.current.resetViewport(vp(0)))
    act(() => result.current.onMoveEnd(null, vp(10)))
    act(() => result.current.onMoveEnd(null, vp(20)))
    expect(result.current.canBack).toBe(true)
    expect(result.current.canForward).toBe(false)

    act(() => result.current.onBack())
    expect(fake.setViewport).toHaveBeenLastCalledWith(vp(10), { duration: 300 })
    expect(result.current.canForward).toBe(true)

    act(() => result.current.onBack())
    expect(fake.setViewport).toHaveBeenLastCalledWith(vp(0), { duration: 300 })
    expect(result.current.canBack).toBe(false)

    act(() => result.current.onForward())
    expect(fake.setViewport).toHaveBeenLastCalledWith(vp(10), { duration: 300 })
  })

  it('back di ujung riwayat INERT: tidak memindahkan viewport, tidak mem-persist', () => {
    const { result, fake, viewportRef, scheduleSave } = mountViewport()
    act(() => result.current.resetViewport(vp(0)))
    act(() => result.current.onMoveEnd(null, vp(10)))
    act(() => result.current.onBack())
    expect(result.current.canBack).toBe(false)
    fake.setViewport.mockClear()
    scheduleSave.mockClear()

    // Langkah habis. `history.undo()` memulangkan undefined DAN tidak menggeser pointer, jadi satu-
    // satunya jawaban yang benar adalah tidak melakukan apa pun — bukan memindahkan viewport ke
    // `undefined`, dan bukan mem-persist ulang posisi yang sama.
    act(() => result.current.onBack())
    expect(fake.setViewport).not.toHaveBeenCalled()
    expect(scheduleSave).not.toHaveBeenCalled()
    expect(viewportRef.current).toEqual(vp(0))
    expect(result.current.canForward).toBe(true)
  })

  it('resetViewport membuang riwayat board sebelumnya', () => {
    const { result, viewportRef } = mountViewport()
    act(() => result.current.resetViewport(vp(0)))
    act(() => result.current.onMoveEnd(null, vp(10)))
    expect(result.current.canBack).toBe(true)
    act(() => result.current.resetViewport(vp(99, 0.25)))
    expect(result.current.canBack).toBe(false)
    expect(result.current.canForward).toBe(false)
    expect(viewportRef.current).toEqual(vp(99, 0.25))
    expect(result.current.zoom).toBe(0.25)
  })
})
