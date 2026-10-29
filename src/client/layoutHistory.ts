// Undo/redo LAYOUT canvas: posisi, ukuran, dan keberadaan node. Kembaran `./canvasViewport` yang
// menyimpan riwayat pandangan — dipisah karena keduanya memang dua tumpukan berbeda: menggeser node
// lalu menekan back harus memindahkan PANDANGAN, bukan mengembalikan node.
//
// `history.ts` sengaja dibiarkan murni (tanpa React) dan tetap di sana: ia tumpukan generik yang
// dipakai dua hook ini plus test-nya sendiri. Yang tinggal di file ini cuma pengikatannya ke state
// React — snapshot mana yang di-push, dan apa yang terjadi saat undo.
//
// Perubahan data-only (collapse/warna/rename/sessionId) TIDAK boleh masuk ke sini: undo yang
// mengembalikan layout juga akan membuang sessionId sebuah sesi yang masih hidup. Pemanggil yang
// memutuskan — lihat cabang `settled` di `onNodesChange`.
import { useCallback, useReducer, useRef } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { Node } from '@xyflow/react'
import { createHistory } from './history'

export interface LayoutHistoryDeps {
  /** Dipinjam APA ADANYA: undo menulis `.current` yang sama dengan yang dibaca `scheduleSave`. */
  nodesRef: RefObject<Node[]>
  setNodes: Dispatch<SetStateAction<Node[]>>
  scheduleSave: () => void
}

export interface LayoutHistory {
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  /** Catat satu langkah. Aman dipanggil dari dalam updater `setNodes`. */
  pushLayout: (nodes: Node[]) => void
  /** Pasang board baru: layout awalnya jadi satu-satunya entri. */
  resetLayout: (nodes: Node[]) => void
}

export function useLayoutHistory({ nodesRef, setNodes, scheduleSave }: LayoutHistoryDeps): LayoutHistory {
  const hist = useRef(createHistory<Node[]>())
  // Tumpukannya di ref, bukan state: `pushLayout` dipanggil dari dalam updater `setNodes`, dan
  // state biasa di sana adalah tulisan saat render. Akibatnya `canUndo`/`canRedo` tidak memicu
  // render sendiri — `bump` yang melakukannya, kalau tidak tombol Dock membeku.
  const [, bump] = useReducer((x: number) => x + 1, 0)

  const step = useCallback((pick: (h: typeof hist.current) => Node[] | undefined) => {
    const s = pick(hist.current)
    if (s) { nodesRef.current = s; setNodes(s); scheduleSave() }
    // Tanpa syarat, apa adanya seperti di App sebelum dipindah — alasan lengkapnya ada di `step`
    // pada `./canvasViewport`: yang memadamkan tombol adalah bump pada langkah SUKSES terakhir.
    bump()
  }, [nodesRef, setNodes, scheduleSave])

  const onUndo = useCallback(() => step((h) => h.undo()), [step])
  const onRedo = useCallback(() => step((h) => h.redo()), [step])

  const pushLayout = useCallback((nodes: Node[]) => {
    hist.current.push(nodes)
    bump()
  }, [])

  const resetLayout = useCallback((nodes: Node[]) => {
    hist.current = createHistory<Node[]>()
    hist.current.push(nodes)
    bump()
  }, [])

  return {
    onUndo,
    onRedo,
    canUndo: hist.current.canUndo(),
    canRedo: hist.current.canRedo(),
    pushLayout,
    resetLayout,
  }
}
