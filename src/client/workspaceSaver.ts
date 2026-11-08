// Debounced persistence of the active board, split out of `workspaceLifecycle.ts`. Saves go
// through `createSaveQueue` (one in flight, version-checked, failures kept dirty and retried); a
// save another window beat is answered by reloading the stored board, VS Code "file changed on
// disk" style. Every locked payload and every server answer is written into App's `workspaces`
// list, the one client store the Sessions panel and notification focus read.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { Edge, Node } from '@xyflow/react'
import { toBridge, toWsNode } from './store'
import { createSaveQueue, type SaveState } from './workspaceSaveQueue'
import { mergeCanvasPush } from './workspaceCanvasMerge'
import { subscribeCanvas } from './ws'
import { DELETED_NOTICE, STALE_RELOADED_NOTICE, showSaveNotice, staleNotSavedNotice } from './workspaceSave.notice'
import { useSaveLifecycle } from './workspaceSave.lifecycle'
import { useSaveStateSurface } from './workspaceSave.status'
import type { VscodeStatusItem } from './components/vscode/vscodeStatusBar'
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
  /** App's workspace list: fed with every locked payload and every board the server answers. */
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>
}

export interface WorkspaceSaver {
  scheduleSave: () => void
  /** Tulis SEKARANG payload yang sudah terkunci, lalu batalkan timernya. No-op bila tak ada. */
  flushSave: () => void
  /** Buang debounce yang menggantung tanpa menulis. */
  cancelSave: () => void
  saveState: SaveState
  /** Resend a failed save now (the notice's / status item's Retry). */
  retrySave: () => void
  /** Status bar entry while a save is failing. */
  saveStatusItems: VscodeStatusItem[]
}

/**
 * Debounce penyimpanan board aktif. Payload (workspace + nodes/edges/viewport) DIKUNCI saat
 * `scheduleSave` dipanggil, bukan dibaca ulang saat timer menembak: workspace bisa berpindah dalam
 * 400ms itu (`onSelect`/`onCreateWorkspace`/`onDeleteWorkspace` memanggil `applyWorkspace`), dan
 * membaca ref saat itu menulis board BARU ke id workspace LAMA.
 */
export function useWorkspaceSaver({ activeWsRef, nodesRef, edgesRef, viewportRef, saveTimer, applyRef, setWorkspaces }: WorkspaceSaverDeps): WorkspaceSaver {
  // Fungsi tulis yang payload-nya sudah tertangkap. Satu-satunya sumber `flushSave`. Disimpan di
  // ref, bukan di state: menembakkannya tidak boleh memicu render.
  const pending = useRef<(() => void) | null>(null)
  // The payload `pending` will write, boxed so a server push can add its nodes (effect below).
  const locked = useRef<{ payload: Workspace } | null>(null)

  const cancelSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    pending.current = null
    locked.current = null
  }, [saveTimer])

  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })
  const names = useRef(new Map<string, string>()) // board id -> name, for the save-failed notice
  const store = useCallback((ws: Workspace) => setWorkspaces((prev) => prev.map((w) => (w.id === ws.id ? ws : w))), [setWorkspaces])

  // Refused saves: the unsaved local layout is dropped, never merged or re-applied silently.
  const [queue] = useState(() => createSaveQueue({
    onSaved: (saved, superseded) => { if (!superseded) store(saved) },
    onState: setSaveState,
    onStale: (current) => {
      store(current)
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
    const box: { payload: Workspace } = { payload: {
      ...ws,
      nodes: nodesRef.current.map(toWsNode),
      bridges: edgesRef.current.map(toBridge),
      viewport: { ...viewportRef.current },
    } }
    const fire = () => {
      const { payload } = box
      saveTimer.current = null
      pending.current = null
      locked.current = null
      // `activeWsRef` adalah sumber payload save BERIKUTNYA. Menimpanya dengan board lama (timer
      // yang menembak setelah pengguna pindah) akan menyimpan board lama itu di workspace baru.
      if (activeWsRef.current?.id === payload.id) activeWsRef.current = payload
      names.current.set(payload.id, payload.name)
      store(payload) // the store shows what the canvas shows, saved or still dirty
      void queue.enqueue(payload) // never rejects: failures become `saveState`
    }
    cancelSave()
    pending.current = fire
    locked.current = box
    saveTimer.current = setTimeout(fire, SAVE_DEBOUNCE_MS)
  }, [activeWsRef, nodesRef, edgesRef, viewportRef, saveTimer, cancelSave, queue, store])

  // Server pushes are already stored: added nodes have to survive in every payload not yet sent and
  // removed ones must not come back from it, and the list shows both, for every board (the mounted
  // canvas applies them in `workspaceCanvasPush.ts`).
  useEffect(() => subscribeCanvas((msg) => {
    queue.absorb(msg)
    const box = locked.current
    if (box?.payload.id === msg.workspaceId) box.payload = mergeCanvasPush(box.payload, msg)
    setWorkspaces((prev) => prev.map((w) => (w.id === msg.workspaceId ? mergeCanvasPush(w, msg) : w)))
  }), [queue, setWorkspaces])

  const flushSave = useCallback(() => {
    const fire = pending.current
    if (!fire) return
    cancelSave() // satu jalur pembersihan untuk timer + penanda
    fire()
  }, [cancelSave])

  const retrySave = useCallback(() => { void queue.retry() }, [queue])
  const hasUnsaved = useCallback(() => pending.current !== null || queue.isDirty(), [queue])
  useSaveLifecycle({ flushSave, retrySave, hasUnsaved })
  const nameOf = useCallback((id: string) => names.current.get(id) ?? id, [])
  const saveStatusItems = useSaveStateSurface(saveState, nameOf, retrySave)

  return { scheduleSave, flushSave, cancelSave, saveState, retrySave, saveStatusItems }
}
