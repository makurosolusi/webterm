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
import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { Edge, Node, ReactFlowInstance } from '@xyflow/react'
import { fetchWorkspaces, getActive, setActive, getWorkspace, createWorkspace, saveWorkspace, deleteWorkspace } from './api'
import { bootWorkspaceId, nextActiveWorkspaceId } from './workspaceMenu'
import { toBridge, toWsNode, workspaceNameFromPath } from './store'
import { sessionIdsOf } from './paneTree'
import { send } from './ws'
import { revealInTabs } from './nodeReveal'
import { getTabLayout } from './tabLayout.store'
import type { ClosedHistory } from './closedHistory'
import type { Viewport, Workspace } from '../shared/workspace'

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
  /** Dinaikkan saat boot fetch menjawab 403: token hilang/salah → render layar Login. */
  setAuthRequired: Dispatch<SetStateAction<boolean>>
  setNodes: Dispatch<SetStateAction<Node[]>>
  setEdges: Dispatch<SetStateAction<Edge[]>>
  setBoard: Dispatch<SetStateAction<boolean>>
  setPicker: Dispatch<SetStateAction<{ onPick: (p: string) => void } | null>>
  activeWsRef: RefObject<Workspace | null>
  nodesRef: RefObject<Node[]>
  edgesRef: RefObject<Edge[]>
  /** Batalkan debounce `scheduleSave` yang menggantung TANPA menulis (lihat `useWorkspaceSaver`). */
  cancelSave: () => void
  rf: RefObject<ReactFlowInstance | null>
}

/** Jeda persistensi board aktif: cukup untuk menelan rentetan geser node, cukup pendek agar
 *  penyimpanan tidak terasa tertunda. */
export const SAVE_DEBOUNCE_MS = 400

export interface WorkspaceSaverDeps {
  activeWsRef: RefObject<Workspace | null>
  nodesRef: RefObject<Node[]>
  edgesRef: RefObject<Edge[]>
  viewportRef: RefObject<Viewport>
  saveTimer: RefObject<ReturnType<typeof setTimeout> | null>
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
export function useWorkspaceSaver({ activeWsRef, nodesRef, edgesRef, viewportRef, saveTimer }: WorkspaceSaverDeps): WorkspaceSaver {
  // Fungsi tulis yang payload-nya sudah tertangkap. Satu-satunya sumber `flushSave`. Disimpan di
  // ref, bukan di state: menembakkannya tidak boleh memicu render.
  const pending = useRef<(() => void) | null>(null)

  const cancelSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    pending.current = null
  }, [saveTimer])

  const scheduleSave = useCallback(() => {
    const ws = activeWsRef.current
    if (!ws) return
    const payload: Workspace = {
      ...ws,
      nodes: nodesRef.current.map(toWsNode),
      bridges: edgesRef.current.map(toBridge),
      viewport: { ...viewportRef.current },
    }
    const fire = () => {
      saveTimer.current = null
      pending.current = null
      const updated: Workspace = { ...payload, updatedAt: Date.now() }
      // `activeWsRef` adalah sumber payload save BERIKUTNYA. Menimpanya dengan board lama (timer
      // yang menembak setelah pengguna pindah) akan menyimpan board lama itu di workspace baru.
      if (activeWsRef.current?.id === updated.id) activeWsRef.current = updated
      void saveWorkspace(updated)
    }
    cancelSave()
    pending.current = fire
    saveTimer.current = setTimeout(fire, SAVE_DEBOUNCE_MS)
  }, [activeWsRef, nodesRef, edgesRef, viewportRef, saveTimer, cancelSave])

  const flushSave = useCallback(() => {
    const fire = pending.current
    if (!fire) return
    cancelSave() // satu jalur pembersihan untuk timer + penanda
    fire()
  }, [cancelSave])

  return { scheduleSave, flushSave, cancelSave }
}

export interface WorkspaceLifecycle {
  onSelect: (id: string) => Promise<void>
  onFocus: (id: string) => Promise<void>
  closeSession: (id: string) => Promise<void>
  onRenameWorkspace: (id: string, name: string) => Promise<void>
  onDeleteWorkspace: (id: string) => Promise<void>
  onCreateWorkspace: (name: string, cwd?: string) => Promise<void>
  /** No path: pick an existing folder. A path (just cloned/created): open it as a workspace. */
  onNewProject: (path?: string) => void
}

export function useWorkspaceLifecycle(deps: WorkspaceLifecycleDeps): WorkspaceLifecycle {
  const {
    workspaces, activeId, applyWorkspace, scheduleSave, recordClosed,
    setWorkspaces, setActiveWs, setHydrated, setAuthRequired, setNodes, setEdges, setBoard, setPicker,
    activeWsRef, nodesRef, edgesRef, cancelSave, rf,
  } = deps

  // Board diambil LENGKAP sebelum satu pun state di-commit. React Flow membaca `defaultViewport`
  // hanya saat mount, jadi commit `activeId` lebih dulu me-mount canvas dengan viewport default dan
  // tanpa node — board tersimpan baru menyusul di render berikutnya.
  useEffect(() => {
    void (async () => {
      try {
        const [list, active] = await Promise.all([fetchWorkspaces(), getActive()])
        const id = bootWorkspaceId(list.map((w) => w.id), active)
        const ws = id ? await getWorkspace(id) : null
        if (id && id !== active) await setActive(id)
        setWorkspaces(list)
        if (ws) applyWorkspace(ws)
        setHydrated(true)
      } catch (e) {
        // 403 = gate server menolak token: pakai ulang fetch boot ini sebagai probe auth, jadi tak
        // ada ronde jaringan terpisah. `hydrated` tetap dinaikkan — tanpa itu App menahan render di
        // `null` dan layar Login tidak pernah muncul. Error lain diteruskan: blank screen lama
        // tetap menjadi sinyal bahwa boot benar-benar gagal, bukan sekadar belum login.
        if ((e as { status?: number }).status === 403) { setAuthRequired(true); setHydrated(true) }
        else throw e
      }
    })()
  }, [applyWorkspace])

  // Save yang menggantung ditulis oleh `applyWorkspace` (flush, lihat `useWorkspaceSaver`) SEBELUM
  // board baru dipasang — bukan dibatalkan di sini, karena itu membuang edit terakhir pengguna.
  const onSelect = useCallback(async (id: string) => {
    if (!id || id === activeId) return
    const ws = await getWorkspace(id)
    await setActive(id)
    applyWorkspace(ws)
  }, [activeId, applyWorkspace])

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
  // canvas yang ter-mount. Yang di luar canvas dibuang dari salinan TERBARU di server: snapshot
  // `workspaces` di client hanya di-refresh saat workspace dibuat, jadi menulis ulang dari sana
  // akan mengembalikan layout workspace itu ke keadaan lama.
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
    const updated: Workspace = { ...fresh, nodes: fresh.nodes.filter((n) => n.id !== id), updatedAt: Date.now() }
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
    // Workspace lain: ambil salinan TERBARU dari server, ubah satu field, kirim itu. Snapshot
    // `workspaces` di client hanya di-refresh saat workspace dibuat, jadi PUT dari sana akan
    // mengembalikan node/viewport workspace itu ke keadaan lama.
    const fresh = await getWorkspace(id)
    const updated: Workspace = { ...fresh, name, updatedAt: Date.now() }
    await saveWorkspace(updated)
    setWorkspaces((prev) => prev.map((w) => (w.id === id ? updated : w)))
  }, [scheduleSave])

  // Hapus workspace (sudah dikonfirmasi di header). Tidak bisa dibatalkan: row + board tersimpan.
  const onDeleteWorkspace = useCallback(async (id: string) => {
    if (id === activeId) {
      // Debounce yang masih menggantung akan PUT id ini SETELAH row-nya hilang dan menghidupkannya
      // kembali (PUT = upsert). Hanya untuk workspace aktif: timer itu selalu milik board aktif,
      // membatalkannya saat menghapus workspace lain berarti membuang save yang sah.
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
    if (ws) await setActive(ws.id)
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
  }, [activeId, applyWorkspace, cancelSave, workspaces])

  const onCreateWorkspace = useCallback(async (name: string, cwd?: string) => {
    const ws = await createWorkspace(name, cwd)
    await setActive(ws.id)
    setWorkspaces((prev) => [...prev, ws])
    applyWorkspace(ws)
  }, [applyWorkspace])

  const onNewProject = useCallback((path?: string) => {
    const open = (p: string) => void onCreateWorkspace(workspaceNameFromPath(p), p)
    if (typeof path === 'string') open(path)
    else setPicker({ onPick: open })
  }, [onCreateWorkspace])

  return { onSelect, onFocus, closeSession, onRenameWorkspace, onDeleteWorkspace, onCreateWorkspace, onNewProject }
}
