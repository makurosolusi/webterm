/**
 * @vitest-environment jsdom
 *
 * jsdom, bukan node-env: yang diuji HOOK React, dan `renderHook` butuh container. Tidak ada canvas
 * yang dimount — `nodesRef`/`setNodes` dipalsukan, karena yang dijaga adalah pengikatannya ke state,
 * bukan React Flow. Tumpukan murninya sudah punya test sendiri di `./history.test.ts`.
 *
 * KENAPA ADA: `onUndo`/`onRedo` tidak punya SATU pun test sebelum ini, dan keduanya baru dipindah
 * keluar dari App.tsx — refactor tanpa jaring persis seperti ini yang menghasilkan closure basi
 * yang lolos dari typecheck.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useLayoutHistory } from './layoutHistory'

const n = (id: string) => ({ id, position: { x: 0, y: 0 }, data: {} })

function mountLayout() {
  const nodesRef = { current: [] as ReturnType<typeof n>[] }
  const setNodes = vi.fn()
  const scheduleSave = vi.fn()
  const hook = renderHook(() => useLayoutHistory({ nodesRef, setNodes, scheduleSave }))
  return { ...hook, nodesRef, setNodes, scheduleSave }
}

describe('useLayoutHistory', () => {
  it('undo memulangkan layout sebelumnya ke ref DAN ke state — keduanya, bukan salah satu', () => {
    const { result, nodesRef, setNodes, scheduleSave } = mountLayout()
    act(() => result.current.resetLayout([n('a')]))
    act(() => result.current.pushLayout([n('a'), n('b')]))
    expect(result.current.canUndo).toBe(true)

    act(() => result.current.onUndo())
    // Ref ikut ditulis: `scheduleSave` mem-persist dari ref, jadi undo yang hanya menyentuh state
    // akan tersimpan balik ke layout lamanya pada save berikutnya.
    expect(nodesRef.current.map((x) => x.id)).toEqual(['a'])
    expect(setNodes).toHaveBeenLastCalledWith(nodesRef.current)
    expect(scheduleSave).toHaveBeenCalledTimes(1)
    expect(result.current.canRedo).toBe(true)

    act(() => result.current.onRedo())
    expect(nodesRef.current.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('undo di ujung riwayat INERT: tidak menulis node, tidak mem-persist', () => {
    const { result, nodesRef, setNodes, scheduleSave } = mountLayout()
    act(() => result.current.resetLayout([n('a')]))
    expect(result.current.canUndo).toBe(false)
    act(() => result.current.onUndo())
    // Bukan `setNodes(undefined)` dan bukan ref yang dikosongkan: entri pertama bukan langkah yang
    // bisa di-undo, jadi canvas harus tetap seperti apa adanya.
    expect(setNodes).not.toHaveBeenCalled()
    expect(scheduleSave).not.toHaveBeenCalled()
    expect(nodesRef.current.map((x) => x.id)).toEqual([])
  })

  it('resetLayout membuang riwayat board sebelumnya', () => {
    const { result } = mountLayout()
    act(() => result.current.resetLayout([n('a')]))
    act(() => result.current.pushLayout([n('a'), n('b')]))
    act(() => result.current.resetLayout([n('z')]))
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
  })
})
