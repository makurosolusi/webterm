// Riwayat "Recently closed" untuk sidebar sesi: menutup sebuah sesi meninggalkan jejak yang bisa
// dibuka kembali, bukan lenyap tanpa bekas. Porting INTI dari nodeterm v0.4.5
// `state/reopenHistory.ts` + `components/ClosedHistorySection.tsx`.
//
// IN-MEMORY, hilang saat halaman di-reload — persis nodeterm, dan alasannya sama: ini undo pendek
// seperti "reopen closed tab" di browser, bukan arsip. Jadi nol kolom SQLite, nol endpoint, nol
// field protokol baru.
//
// Yang DIBUANG dari nodeterm `lib/closedHistory.ts` (253 baris), bukan kelalaian: tab project yang
// ditutup (webterm menghapus workspace langsung, tidak punya keadaan "closed"), transcript agent,
// frame group, dan stack ⇧⌘T. Sisanya satu entry per NODE SESI yang ditutup — satu-satunya bentuk
// yang punya arti di model webterm.
//
// Logika dipisah dari JSX dengan alasan yang sama seperti `./workspaceMenu`: vitest webterm jalan
// di node-env tanpa DOM, jadi yang bisa di-assert harus hidup di luar komponen.
import { useCallback, useMemo, useRef, useState } from 'react'
import { getWorkspace, saveWorkspace } from './api'
import { isSession } from './sessionList'
import type { Workspace, WsNode } from '../shared/workspace'

/** Sedalam apa riwayatnya. Angka nodeterm (`HISTORY_CAP`), dan batasnya memang harus ada: tanpa
 *  itu sesi yang ditutup sepanjang hari menumpuk jadi daftar yang tak lagi berarti "baru saja". */
export const CLOSED_HISTORY_CAP = 10

/** Satu sesi yang ditutup. Snapshot `WsNode` UTUH, bukan id: node-nya sudah tidak ada di mana pun
 *  setelah ditutup, jadi entry inilah satu-satunya salinan yang bisa memulihkannya. */
export interface ClosedEntry {
  node: WsNode
  workspaceId: string
  workspaceName: string
  closedAt: number
}

/**
 * Entry untuk node yang baru ditutup. `nodeIds` boleh memuat apa pun yang dihapus canvas —
 * penyaringnya di sini: hanya kind di `SESSION_KINDS` yang jadi entry, karena node `files`/`editor`
 * bukan sesi dan "Recently closed" yang memuat penampil file akan jadi daftar sampah.
 *
 * `ws` boleh `null` (tidak ada workspace aktif) dan hasilnya kosong: entry tanpa pemilik tidak bisa
 * dipulihkan ke mana pun.
 */
export function closedEntriesFor(
  nodeIds: readonly string[],
  nodes: readonly WsNode[],
  ws: Pick<Workspace, 'id' | 'name'> | null,
  closedAt = Date.now(),
): ClosedEntry[] {
  if (!ws) return []
  return nodeIds
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is WsNode => !!n && isSession(n))
    .map((node) => ({ node, workspaceId: ws.id, workspaceName: ws.name, closedAt }))
}

/**
 * Menaruh `add` di DEPAN lalu memotong yang terlama. Urutannya kebalikan nodeterm (yang append +
 * `slice(-cap)`) karena daftar webterm dirender apa adanya dan terbaru harus di atas.
 *
 * Dedup per `node.id` dengan yang DEPAN menang: menutup id yang sama dua kali (mis. ditutup, di-undo,
 * ditutup lagi) harus menyisakan satu baris dengan waktu terbaru — dua baris untuk satu node berarti
 * yang kedua memulihkan id yang sudah hidup.
 */
export function pushClosed(
  list: readonly ClosedEntry[],
  add: readonly ClosedEntry[],
  cap = CLOSED_HISTORY_CAP,
): ClosedEntry[] {
  const seen = new Set<string>()
  const out: ClosedEntry[] = []
  for (const e of [...add, ...list]) {
    if (seen.has(e.node.id)) continue
    seen.add(e.node.id)
    out.push(e)
  }
  return out.slice(0, cap)
}

/**
 * Entry yang layak DIRENDER. Dua yang dibuang, dan keduanya akan jadi baris bohong:
 * - workspace pemiliknya sudah dihapus — tidak ada tempat untuk memulihkannya;
 * - node-nya sudah kembali ke canvas (undo layout mengembalikan node yang baru ditutup) — baris
 *   "closed" untuk node yang hidup, dan mengkliknya akan menduplikasi id-nya di React Flow.
 *
 * Fungsi, bukan guard di dalam JSX, supaya keduanya ikut teruji.
 */
export function visibleClosed(
  list: readonly ClosedEntry[],
  workspaceIds: readonly string[],
  liveNodeIds: readonly string[] = [],
): ClosedEntry[] {
  const live = new Set(workspaceIds)
  const back = new Set(liveNodeIds)
  return list.filter((e) => live.has(e.workspaceId) && !back.has(e.node.id))
}

/** Mengambil entry `nodeId` keluar dari daftar. Mengembalikan `rest` terpisah (bukan mutasi) supaya
 *  pemanggil bisa membatalkan pengambilan kalau pemulihannya gagal. */
export function takeClosed(
  list: readonly ClosedEntry[],
  nodeId: string,
): { entry: ClosedEntry | undefined; rest: ClosedEntry[] } {
  return {
    entry: list.find((e) => e.node.id === nodeId),
    rest: list.filter((e) => e.node.id !== nodeId),
  }
}

/** Yang dibutuhkan `reopen` dari App. Dikirim saat DIPANGGIL, bukan saat hook dibuat: `addNode` dan
 *  `selectWorkspace` lahir jauh di bawah titik pendaftaran entry di App, dan hook yang menuntutnya
 *  di awal akan memaksa seluruh urutan deklarasi App dibongkar. */
export interface ReopenDeps {
  activeId: string | null
  /** Jalur node BARU di canvas aktif (`addFlowNode` di App): append + scheduleSave + riwayat layout. */
  addNode: (make: (n: number, ws: Workspace) => WsNode) => void
  setWorkspaces: (fn: (prev: Workspace[]) => Workspace[]) => void
  /** Pindah ke workspace lain (`onSelect` di App). */
  selectWorkspace: (id: string) => Promise<void>
}

export interface ClosedHistory {
  /** Siap render: terbaru dulu, sudah disaring `visibleClosed`. */
  entries: ClosedEntry[]
  record: (nodeIds: readonly string[], nodes: readonly WsNode[], ws: Pick<Workspace, 'id' | 'name'> | null) => void
  reopen: (nodeId: string, deps: ReopenDeps) => Promise<void>
}

/**
 * State riwayat + aksi reopen-nya.
 *
 * Reopen TIDAK punya logika spawn/resume sendiri, dan itu bukan jalan pintas: node yang dipulihkan
 * identik dengan node yang dipulihkan reload halaman biasa — `TerminalCore` mengirim `open`-nya
 * sendiri saat mount, dengan cwd/cmd/agentId/sessionId dari data node. Jadi mengembalikan snapshot
 * `WsNode`-nya sudah cukup; jalur mount yang ada mengerjakan sisanya.
 */
export function useClosedHistory(
  workspaces: readonly { id: string }[],
  liveNodes: readonly { id: string }[] | null,
): ClosedHistory {
  const [all, setAll] = useState<ClosedEntry[]>([])
  // Cermin ref: `reopen` harus membaca daftar TERKINI secara sinkron (ia mengambil satu entry lalu
  // menunggu I/O), dan state React hanya terbaca per-render.
  const ref = useRef<ClosedEntry[]>([])

  const commit = useCallback((next: ClosedEntry[]) => {
    ref.current = next
    setAll(next)
  }, [])

  const record = useCallback<ClosedHistory['record']>(
    (nodeIds, nodes, ws) => {
      const add = closedEntriesFor(nodeIds, nodes, ws)
      if (add.length) commit(pushClosed(ref.current, add))
    },
    [commit],
  )

  const reopen = useCallback<ClosedHistory['reopen']>(
    async (nodeId, deps) => {
      const { entry, rest } = takeClosed(ref.current, nodeId)
      if (!entry) return
      // Dibuang DULU: dua klik cepat pada baris yang sama akan memulihkan node yang sama dua kali.
      commit(rest)
      if (entry.workspaceId === deps.activeId) {
        deps.addNode(() => entry.node)
        return
      }
      // Workspace lain: tulis ke salinan TERBARU dari server lalu pindah ke sana. Menambah node ke
      // canvas yang sedang menampilkan workspace LAIN akan menaruhnya di board yang salah.
      try {
        const fresh = await getWorkspace(entry.workspaceId)
        const updated: Workspace = { ...fresh, nodes: [...fresh.nodes, entry.node], updatedAt: Date.now() }
        await saveWorkspace(updated)
        deps.setWorkspaces((prev) => prev.map((w) => (w.id === updated.id ? updated : w)))
        await deps.selectWorkspace(entry.workspaceId)
      } catch (e) {
        // Entry dikembalikan: riwayat ini in-memory, jadi snapshot node tadi satu-satunya salinan
        // yang tersisa dan tulis yang gagal tidak boleh ikut menghapusnya. Barisnya muncul lagi —
        // itu sinyal yang terlihat pengguna, dan webterm belum punya permukaan toast.
        commit(pushClosed(ref.current, [entry]))
        console.error(`reopen closed session ${nodeId} in workspace ${entry.workspaceId}:`, e)
      }
    },
    [commit],
  )

  const entries = useMemo(
    () => visibleClosed(all, workspaces.map((w) => w.id), (liveNodes ?? []).map((n) => n.id)),
    [all, workspaces, liveNodes],
  )

  return { entries, record, reopen }
}
