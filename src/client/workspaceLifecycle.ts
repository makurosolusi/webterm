// Siklus hidup workspace: concern "board MANA yang sedang dibuka", terpisah tegas dari "apa ISI
// board-nya" (yang tetap di App — nodes/edges/viewport/riwayat layout). Di sini: boot, pindah tab,
// rename, hapus, buat baru.
//
// Aksi sesi lintas-workspace (`onFocus`, `closeSession`) ikut tinggal di sini, bukan di App, karena
// ia tunduk pada invarian yang SAMA dan komentarnya saling merujuk: baris sidebar bisa milik
// workspace yang nodenya tidak ter-mount, jadi jalurnya bercabang (canvas aktif vs salinan TERBARU
// dari server) dan snapshot `workspaces` di client tidak boleh dipakai sebagai sumber tulis.
//
// Logika dipisah dari JSX dengan alasan yang sama seperti `./closedHistory`: vitest webterm jalan di
// node-env tanpa DOM, jadi yang bisa di-assert harus hidup di luar komponen.
//
// Every action returned here except `onCreateWorkspace` never rejects: a failure is reported with
// its cause and a Retry (`./workspaceActionError`), so App's `void onSelect(id)` call sites cannot
// lose one silently. `onCreateWorkspace` rejects on purpose: the create dialog shows the error.
import { useCallback, useMemo } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { Edge, Node, ReactFlowInstance } from '@xyflow/react'
import { getWorkspace, createWorkspace, saveWorkspace, deleteWorkspace } from './api'
import { nextActiveWorkspaceId } from './workspaceMenu'
import { workspaceNameFromPath } from './store'
import { sessionIdsOf } from './paneTree'
import { send } from './ws'
import { revealInTabs } from './nodeReveal'
import { getTabLayout } from './tabLayout.store'
import type { ClosedHistory } from './closedHistory'
import { useWorkspaceBoot, type BootState } from './workspaceLifecycle.boot'
import { useLatestSelect } from './workspaceLifecycle.select'
import { reported } from './workspaceActionError'
import type { Workspace } from '../shared/workspace'

/** Yang dibutuhkan hook ini dari App. Setter & ref dipinjam APA ADANYA — ref harus ref yang sama
 *  yang dibaca `scheduleSave`/canvas, bukan salinan baru yang dibuat di sini. */
export interface WorkspaceLifecycleDeps {
  workspaces: Workspace[]
  activeId: string | null
  /** Pasang board ke canvas (`applyWorkspace` di App): nodes/edges/viewport + reset riwayat. */
  applyWorkspace: (ws: Workspace) => void
  scheduleSave: () => void
  recordClosed: ClosedHistory['record']
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>
  setActiveWs: Dispatch<SetStateAction<Workspace | null>>
  setHydrated: Dispatch<SetStateAction<boolean>>
  /** Dinaikkan saat boot fetch menjawab 403: browser belum punya sesi UI → render SignInScreen. */
  setAuthRequired: Dispatch<SetStateAction<boolean>>
  setNodes: Dispatch<SetStateAction<Node[]>>
  setEdges: Dispatch<SetStateAction<Edge[]>>
  setBoard: Dispatch<SetStateAction<boolean>>
  setPicker: Dispatch<SetStateAction<{ onPick: (p: string) => void } | null>>
  activeWsRef: RefObject<Workspace | null>
  nodesRef: RefObject<Node[]>
  edgesRef: RefObject<Edge[]>
  /** Batalkan debounce `scheduleSave` yang menggantung TANPA menulis (lihat `useWorkspaceSaver` di `./workspaceSaver`). */
  cancelSave: () => void
  rf: RefObject<ReactFlowInstance | null>
}

export interface WorkspaceLifecycle {
  onSelect: (id: string) => Promise<void>
  onFocus: (id: string) => Promise<void>
  closeSession: (id: string) => Promise<void>
  onRenameWorkspace: (id: string, name: string) => Promise<void>
  onDeleteWorkspace: (id: string) => Promise<void>
  /** Rejects on failure (the create dialog shows it); every other action reports its own. */
  onCreateWorkspace: (name: string, cwd?: string) => Promise<void>
  /** No path: pick an existing folder. A path (just cloned/created): open it as a workspace. */
  onNewProject: (path?: string) => void
  /** `onCreateWorkspace` for fire-and-forget callers (Welcome): a failure is reported. */
  onCreateReported: (name: string, cwd?: string) => Promise<void>
  boot: BootState
  retryBoot: () => void
}

export function useWorkspaceLifecycle(deps: WorkspaceLifecycleDeps): WorkspaceLifecycle {
  const {
    workspaces, activeId, applyWorkspace, scheduleSave, recordClosed,
    setWorkspaces, setActiveWs, setHydrated, setAuthRequired, setNodes, setEdges, setBoard, setPicker,
    activeWsRef, nodesRef, edgesRef, cancelSave, rf,
  } = deps

  const { boot, retryBoot } = useWorkspaceBoot({ applyWorkspace, setWorkspaces, setHydrated, setAuthRequired })

  // Save yang menggantung ditulis oleh `applyWorkspace` (flush, lihat `useWorkspaceSaver`) SEBELUM
  // board baru dipasang — bukan dibatalkan di sini, karena itu membuang edit terakhir pengguna.
  const { onSelect, cancelSelect, setActiveInOrder } = useLatestSelect({ activeWsRef, applyWorkspace, setWorkspaces })

  // Baris sidebar bisa milik workspace LAIN yang nodenya tidak ter-mount, kelas jebakan yang sama
  // dengan `closeSession` di bawah: dulu `if (!node) return` menelan klik itu diam-diam. Node dicari
  // ULANG setelah pindah karena `onSelect` → `applyWorkspace` menulis `nodesRef` secara sinkron,
  // jadi begitu await selesai isinya sudah board yang baru — tanpa perlu menunggu render.
  const onFocus = useCallback(async (id: string) => {
    if (!nodesRef.current.some((n) => n.id === id)) {
      const owner = workspaces.find((w) => w.nodes.some((n) => n.id === id))
      if (!owner) return
      await onSelect(owner.id)
    }
    const node = nodesRef.current.find((n) => n.id === id)
    if (!node) return
    if (getTabLayout().mode === 'tabs') revealInTabs(id, node.type)
    else rf.current?.setCenter(node.position.x + 240, node.position.y + 160, { zoom: 1, duration: 400 })
    setBoard(false)
  }, [onSelect, workspaces])

  // Sidebar mendaftar sesi dari SEMUA workspace, jadi baris yang ditutup belum tentu ada di
  // canvas yang ter-mount. The owner is found in the client store (fed by every save and switch),
  // but the write starts from the server's LATEST copy: another window may have changed it.
  const closeSession = useCallback(async (id: string) => {
    if (nodesRef.current.some((n) => n.id === id)) {
      await rf.current?.deleteElements({ nodes: [{ id }] })
      return
    }
    const owner = workspaces.find((w) => w.nodes.some((n) => n.id === id))
    if (!owner) return
    // Tiap DAUN, bukan id node: node terminal yang terbelah memegang satu PTY per pane, dan `close`
    // untuk id node saja meninggalkan sisanya hidup tanpa pemilik (lihat `sessionIdsOf`).
    for (const sid of sessionIdsOf(owner.nodes.find((n) => n.id === id)?.panes, id)) send({ t: 'close', id: sid })
    const fresh = await getWorkspace(owner.id)
    recordClosed([id], fresh.nodes, fresh)
    // `fresh.updatedAt` rides along as the save's precondition (409 if another window wrote since).
    const updated: Workspace = { ...fresh, nodes: fresh.nodes.filter((n) => n.id !== id) }
    await saveWorkspace(updated)
    setWorkspaces((prev) => prev.map((w) => (w.id === updated.id ? updated : w)))
  }, [recordClosed, workspaces])

  // Rename dari menu kebab header. Rutenya BEDA tergantung workspace itu sedang terbuka atau
  // tidak — kelas jebakan yang sama dengan `closeSession` di atas.
  const onRenameWorkspace = useCallback(async (id: string, name: string) => {
    const live = activeWsRef.current
    if (live?.id === id) {
      // Workspace AKTIF tidak boleh lewat GET+PUT: salinan server bisa ketinggalan sampai 400ms
      // dari canvas yang hidup (debounce `scheduleSave`), jadi menulisnya kembali membatalkan edit
      // terakhir pengguna. Yang benar: ganti nama di `activeWsRef` — sumber payload `scheduleSave`
      // — lalu biarkan save berikutnya membawa nama baru bersama layout TERBARU. Nama yang hanya
      // hidup di state React akan ditimpa kembali dengan nama lama oleh edit canvas berikutnya.
      activeWsRef.current = { ...live, name }
      setActiveWs((ws) => (ws && ws.id === id ? { ...ws, name } : ws))
      setWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, name } : w)))
      scheduleSave()
      return
    }
    // Workspace lain: ambil salinan TERBARU dari server, ubah satu field, kirim itu: the client
    // store can lag a write from another window, and a PUT from it would revert that write.
    const fresh = await getWorkspace(id)
    const updated: Workspace = { ...fresh, name } // fresh.updatedAt = the save's precondition
    await saveWorkspace(updated)
    setWorkspaces((prev) => prev.map((w) => (w.id === id ? updated : w)))
  }, [scheduleSave])

  // Hapus workspace (sudah dikonfirmasi di header). Tidak bisa dibatalkan: row + board tersimpan.
  const onDeleteWorkspace = useCallback(async (id: string) => {
    if (id === activeId) {
      cancelSelect() // this delete mounts the replacement board; a switch still loading must not land after it
      // A pending debounce would PUT this id after its row is gone: a pointless 404 (the server no
      // longer re-creates it). Active board only: the timer always belongs to the active board,
      // cancelling it while deleting another workspace would drop a legitimate save.
      cancelSave()
    }
    // Sesi PTY tidak mati sendiri saat row-nya hilang — node yang unmount sengaja TIDAK menutup
    // sesinya (itu yang membuat board bertahan saat pindah workspace), jadi shell-nya ditutup di
    // sini atau bocor tanpa pemilik. Daftar node diambil dari server karena snapshot client bisa
    // ketinggalan untuk workspace yang tidak aktif; GET gagal pun hapusnya tetap jalan.
    const doomed = await getWorkspace(id).catch(() => null)
    for (const n of doomed?.nodes ?? []) for (const sid of sessionIdsOf(n.panes, n.id)) send({ t: 'close', id: sid })
    await deleteWorkspace(id)
    const next = nextActiveWorkspaceId(workspaces.map((w) => w.id), id, activeId)
    // Board pengganti diambil sebelum daftar tab dikecilkan supaya hilangnya tab dan datangnya
    // board baru mendarat dalam SATU render, bukan dua.
    const ws = next && next !== activeId ? await getWorkspace(next) : null
    if (ws) await setActiveInOrder(ws.id)
    setWorkspaces((prev) => prev.filter((w) => w.id !== id))
    if (next === activeId) return // yang dihapus bukan yang aktif: board di layar tidak tersentuh
    if (ws) {
      applyWorkspace(ws)
      return
    }
    // Workspace terakhir: mendarat di `Welcome` dengan canvas kosong. `activeWsRef` dikosongkan
    // supaya `scheduleSave` berhenti di baris pertamanya, bukan menulis board hantu.
    setActiveWs(null)
    activeWsRef.current = null
    nodesRef.current = []
    edgesRef.current = []
    setNodes([])
    setEdges([])
  }, [activeId, applyWorkspace, cancelSave, cancelSelect, setActiveInOrder, workspaces])

  const onCreateWorkspace = useCallback(async (name: string, cwd?: string) => {
    const ws = await createWorkspace(name, cwd)
    cancelSelect()
    await setActiveInOrder(ws.id)
    setWorkspaces((prev) => [...prev, ws])
    applyWorkspace(ws)
  }, [applyWorkspace, cancelSelect, setActiveInOrder])

  const safe = useMemo(() => ({
    onSelect: reported('switch workspace', onSelect),
    onFocus: reported('show the session', onFocus),
    closeSession: reported('close the session', closeSession),
    onRenameWorkspace: reported('rename workspace', onRenameWorkspace),
    onDeleteWorkspace: reported('delete workspace', onDeleteWorkspace),
    onCreateReported: reported('create workspace', onCreateWorkspace),
  }), [onSelect, onFocus, closeSession, onRenameWorkspace, onDeleteWorkspace, onCreateWorkspace])

  const { onCreateReported } = safe
  const onNewProject = useCallback((path?: string) => {
    const open = (p: string) => void onCreateReported(workspaceNameFromPath(p), p)
    if (typeof path === 'string') open(path)
    else setPicker({ onPick: open })
  }, [onCreateReported])

  return { ...safe, onCreateWorkspace, onNewProject, boot, retryBoot }
}
