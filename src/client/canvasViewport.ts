// Concern viewport canvas: readout zoom, persistensi posisi, tombol zoom/fit, dan riwayat pandangan
// (back/forward). Satu modul karena setiap jalur di bawah menulis TRIO yang sama — `viewportRef`,
// `setZoom`, `vpHist` — dan jalur yang lupa salah satunya adalah bug tersendiri: readout zoom basi,
// posisi tidak tersimpan, atau tombol back yang mati.
//
// KENAPA BUKAN DI App.tsx. App menembus hard limit 20.000 karakter (Rule 8), dan `zoomIn`/`zoomOut`
// sempat ditulis DUA KALI identik di sana (sekali untuk rail zoom lama, sekali untuk Dock) justru karena
// tidak ada tempat bersama untuk menaruhnya — dua salinan durasi animasi yang bebas menyimpang.
// Satu definisi di sini = satu durasi.
//
// `zoom` dan `vpHist` DIMILIKI hook ini. `viewportRef` tetap milik App dan dipinjam apa adanya
// (pola yang sama dengan `./workspaceLifecycle`): `scheduleSave` App membaca `.current` yang SAMA
// dengan yang ditulis di sini, jadi ref salinan akan mem-persist viewport yang sudah basi.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import { createHistory } from './history'
import { setNotifyCanvas } from './osNotify'
import { getTabLayout } from './tabLayout.store'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { Viewport } from '../shared/workspace'

export interface CanvasViewportDeps {
  /** Dibaca saat aksi, bukan saat hook dibuat: instance-nya baru ada setelah `onInit` React Flow. */
  rf: RefObject<ReactFlowInstance | null>
  viewportRef: RefObject<Viewport>
  scheduleSave: () => void
}

export interface CanvasViewport {
  /** Readout zoom untuk Dock (persen). */
  zoom: number
  /** Sinkronkan readout + persist SESUDAH animasi selesai; `delay` dalam ms. */
  syncViewport: (delay: number) => void
  onMoveEnd: (e: unknown, vp: Viewport) => void
  onFit: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  /** `pct` dalam persen, seperti yang dikirim Dock (100 = zoom 1). */
  onZoomTo: (pct: number) => void
  onBack: () => void
  onForward: () => void
  canBack: boolean
  canForward: boolean
  /** Pasang board baru: viewport awalnya jadi satu-satunya entri riwayat. */
  resetViewport: (vp: Viewport) => void
}

// Tab mode hides the canvas: zoom/fit/history would move a viewport nobody can see.
const inTabs = (): boolean => getTabLayout().mode === 'tabs'

export function useCanvasViewport({ rf, viewportRef, scheduleSave }: CanvasViewportDeps): CanvasViewport {
  const [zoom, setZoom] = useState(DEFAULT_VIEWPORT.zoom)
  const vpHist = useRef(createHistory<Viewport>())
  // Riwayat hidup di ref — snapshot-nya di-push dari dalam updater `setNodes`/handler, dan state
  // biasa di sana adalah tulisan saat render. Konsekuensinya `canBack`/`canForward` tidak pernah
  // memicu render sendiri, jadi `bump` yang melakukannya: tanpa itu tombol Dock membeku.
  const [, bump] = useReducer((x: number) => x + 1, 0)

  // Perpindahan programatik (setViewport/zoomIn/fitView) lewat setTransform tidak mengirim
  // sourceEvent sama sekali, jadi onMoveEnd kemungkinan besar TETAP jalan. Panggilan ini
  // jaring pengaman eksplisit: sync readout + persist tanpa bergantung pada jalur event.
  const syncViewport = useCallback((delay: number) => {
    setTimeout(() => {
      const vp = rf.current?.getViewport()
      if (vp) { viewportRef.current = vp; setZoom(vp.zoom); scheduleSave() }
    }, delay)
  }, [rf, viewportRef, scheduleSave])

  const onMoveEnd = useCallback((_e: unknown, vp: Viewport) => {
    viewportRef.current = vp
    setZoom(vp.zoom)
    vpHist.current.push(vp)
    bump()
    scheduleSave()
  }, [viewportRef, scheduleSave])

  // Satu definisi untuk dua jalan masuk (Dock, menu konteks) — durasinya tidak menyimpang.
  const onFit = useCallback(() => {
    if (inTabs()) return
    rf.current?.fitView({ duration: 300 })
    syncViewport(320)
  }, [rf, syncViewport])

  const onZoomIn = useCallback(() => {
    if (inTabs()) return
    rf.current?.zoomIn({ duration: 150 })
    syncViewport(170)
  }, [rf, syncViewport])

  const onZoomOut = useCallback(() => {
    if (inTabs()) return
    rf.current?.zoomOut({ duration: 150 })
    syncViewport(170)
  }, [rf, syncViewport])

  const onZoomTo = useCallback((pct: number) => {
    if (inTabs()) return
    rf.current?.zoomTo(pct / 100, { duration: 150 })
    syncViewport(170)
  }, [rf, syncViewport])

  // `bump` tanpa syarat, apa adanya seperti di App sebelum dipindah. Yang menggelapkan tombol Dock
  // adalah bump pada langkah SUKSES terakhir — di situlah `canUndo()` berubah jadi false. Langkah
  // yang GAGAL tidak menggeser pointer `history` (lihat `./history`), jadi di sana bump memang tidak
  // mengubah apa pun; dibiarkan tak bersyarat karena memindahkannya ke dalam cabang tak menghemat
  // apa-apa dan membuat benar/salahnya bergantung pada detail `history` yang tak terlihat di sini.
  const step = useCallback((pick: (h: typeof vpHist.current) => Viewport | undefined) => {
    if (inTabs()) return
    const v = pick(vpHist.current)
    if (v) {
      viewportRef.current = v
      rf.current?.setViewport(v, { duration: 300 })
      setZoom(v.zoom)
      scheduleSave()
    }
    bump()
  }, [rf, viewportRef, scheduleSave])

  const onBack = useCallback(() => step((h) => h.undo()), [step])
  const onForward = useCallback(() => step((h) => h.redo()), [step])

  // "In view" for OS notifications (`./osNotify`): a node on screen in a focused tab needs no
  // banner. Click-to-focus is App's (`workspaceLifecycle#onFocus`): only it can switch workspace.
  useEffect(() => setNotifyCanvas({
    inView: (id) => {
      const n = rf.current?.getNode(id)
      if (!n || !rf.current) return false
      const a = rf.current.flowToScreenPosition(n.position)
      const b = rf.current.flowToScreenPosition({
        x: n.position.x + (n.measured?.width ?? n.width ?? 0),
        y: n.position.y + (n.measured?.height ?? n.height ?? 0),
      })
      // ponytail: window rect, not the canvas pane's — a node under a docked panel counts as visible.
      return b.x > 0 && b.y > 0 && a.x < window.innerWidth && a.y < window.innerHeight
    },
  }), [rf])

  const resetViewport = useCallback((vp: Viewport) => {
    viewportRef.current = vp
    setZoom(vp.zoom)
    vpHist.current = createHistory<Viewport>()
    vpHist.current.push(vp)
    bump()
  }, [viewportRef])

  return {
    zoom, syncViewport, onMoveEnd, onFit, onZoomIn, onZoomOut, onZoomTo, onBack, onForward,
    canBack: vpHist.current.canUndo(),
    canForward: vpHist.current.canRedo(),
    resetViewport,
  }
}
