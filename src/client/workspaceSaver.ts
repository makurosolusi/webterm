// Debounced persistence of the active board, split out of `workspaceLifecycle.ts`. Saves go
// through `createSaveQueue` (one in flight, version-checked); a save another window beat is
// answered by reloading the stored board, VS Code "file changed on disk" style.
import { useCallback, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Edge, Node } from '@xyflow/react'
import { toBridge, toWsNode } from './store'
import { createSaveQueue } from './workspaceSaveQueue'
import { DELETED_NOTICE, STALE_RELOADED_NOTICE, showSaveNotice, staleNotSavedNotice } from './workspaceSave.notice'
import type { Viewport, Workspace } from '../shared/workspace'

/** Jeda persistensi board aktif: cukup untuk menelan rentetan geser node, cukup pendek agar
 *  penyimpanan tidak terasa tertunda. */
export const SAVE_DEBOUNCE_MS = 400

export interface WorkspaceSaverDeps {
  activeWsRef: RefObject<Workspace | null>
  nodesRef: RefObject<Node[]>
  edgesRef: RefObject<Edge[]>
  viewportRef: RefObject<Viewport>
  saveTimer: RefObject<ReturnType<typeof setTimeout> | null>
  /** Mounts a board on the canvas (App's `applyWorkspace`, created after this hook, hence a ref). */
  applyRef: RefObject<((ws: Workspace) => void) | null>
}

export interface WorkspaceSaver {
  scheduleSave: () => void
  /** Tulis SEKARANG payload yang sudah terkunci, lalu batalkan timernya. No-op bila tak ada. */
  flushSave: () => void
  /** Buang debounce yang menggantung tanpa menulis. */
  cancelSave: () => void
}

/**
 * Debounce penyimpanan board aktif. Payload (workspace + nodes/edges/viewport) DIKUNCI saat
 * `scheduleSave` dipanggil, bukan dibaca ulang saat timer menembak: workspace bisa berpindah dalam
 * 400ms itu (`onSelect`/`onCreateWorkspace`/`onDeleteWorkspace` memanggil `applyWorkspace`), dan
 * membaca ref saat itu menulis board BARU ke id workspace LAMA.
 */
export function useWorkspaceSaver({ activeWsRef, nodesRef, edgesRef, viewportRef, saveTimer, applyRef }: WorkspaceSaverDeps): WorkspaceSaver {
  // Fungsi tulis yang payload-nya sudah tertangkap. Satu-satunya sumber `flushSave`. Disimpan di
  // ref, bukan di state: menembakkannya tidak boleh memicu render.
  const pending = useRef<(() => void) | null>(null)

  const cancelSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    pending.current = null
  }, [saveTimer])

  // Refused saves: the unsaved local layout is dropped, never merged or re-applied silently.
  const [queue] = useState(() => createSaveQueue({
    onStale: (current) => {
      if (activeWsRef.current?.id !== current.id) {
        showSaveNotice(staleNotSavedNotice(current.name), 'warning')
        return
      }
      cancelSave()
      applyRef.current?.(current)
      showSaveNotice(STALE_RELOADED_NOTICE, 'info')
    },
    onMissing: (id) => {
      if (activeWsRef.current?.id !== id) return // already left (e.g. this window deleted it)
      cancelSave()
      showSaveNotice(DELETED_NOTICE, 'warning')
    },
  }))

  const scheduleSave = useCallback(() => {
    const ws = activeWsRef.current
    if (!ws) return
    // `updatedAt` stays the version this board was loaded/saved at: it is the save's precondition.
    const payload: Workspace = {
      ...ws,
      nodes: nodesRef.current.map(toWsNode),
      bridges: edgesRef.current.map(toBridge),
      viewport: { ...viewportRef.current },
    }
    const fire = () => {
      saveTimer.current = null
      pending.current = null
      // `activeWsRef` adalah sumber payload save BERIKUTNYA. Menimpanya dengan board lama (timer
      // yang menembak setelah pengguna pindah) akan menyimpan board lama itu di workspace baru.
      if (activeWsRef.current?.id === payload.id) activeWsRef.current = payload
      void queue.enqueue(payload)
    }
    cancelSave()
    pending.current = fire
    saveTimer.current = setTimeout(fire, SAVE_DEBOUNCE_MS)
  }, [activeWsRef, nodesRef, edgesRef, viewportRef, saveTimer, cancelSave, queue])

  const flushSave = useCallback(() => {
    const fire = pending.current
    if (!fire) return
    cancelSave() // satu jalur pembersihan untuk timer + penanda
    fire()
  }, [cancelSave])

  return { scheduleSave, flushSave, cancelSave }
}
