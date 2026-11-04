// Riwayat "Recently closed" untuk sidebar sesi: menutup sebuah sesi meninggalkan jejak yang bisa
// dibuka kembali, bukan lenyap tanpa bekas. Porting INTI dari nodeterm v0.4.5
// `state/reopenHistory.ts` + `components/ClosedHistorySection.tsx`.
//
// DIPERSIST ke SQLite (`/api/closed-history`, tabel `closed_history`, I1-c): dulu in-memory seperti
// nodeterm, tetapi webterm adalah board yang hidup berhari-hari dan reload/restart server yang
// menghapus semua jejak "baru ditutup" membuat fitur ini nyaris tak pernah berguna. Klien tetap
// pemilik daftarnya (cap, dedup, urutan); server menyimpan salinan utuh tiap kali daftar berubah.
//
// Yang DIBUANG dari nodeterm `lib/closedHistory.ts` (253 baris), bukan kelalaian: tab project yang
// ditutup (webterm menghapus workspace langsung, tidak punya keadaan "closed"), transcript agent,
// frame group, dan stack ⇧⌘T. Sisanya satu entry per NODE SESI yang ditutup — satu-satunya bentuk
// yang punya arti di model webterm.
//
// Logika dipisah dari JSX dengan alasan yang sama seperti `./workspaceMenu`: vitest webterm jalan
// di node-env tanpa DOM, jadi yang bisa di-assert harus hidup di luar komponen.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getWorkspace, saveWorkspace } from './api'
import { fetchClosedHistory, saveClosedHistory } from './SessionHistory.api'
import { isSession } from './sessionList'
import type { BridgeLink, Workspace, WsNode } from '../shared/workspace'

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
  /** Cables that touched the node when it closed (F3-d): reopening, after a reload too, brings them
   *  back. Absent = none, or an entry stored before this field existed. */
  bridges?: BridgeLink[]
}

/** Workspace fields a close needs. `bridges` is the fallback cable source when the caller has no
 *  fresher list (closing a node of a workspace that is not on the canvas). */
export type ClosedOwner = Pick<Workspace, 'id' | 'name'> & Partial<Pick<Workspace, 'bridges'>>

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
  ws: ClosedOwner | null,
  closedAt = Date.now(),
  bridges: readonly BridgeLink[] = ws?.bridges ?? [],
): ClosedEntry[] {
  if (!ws) return []
  return nodeIds
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is WsNode => !!n && isSession(n))
    .map((node) => {
      const own = uniqueById(bridges.filter((b) => b.source === node.id || b.target === node.id))
      return { node, workspaceId: ws.id, workspaceName: ws.name, closedAt, ...(own.length ? { bridges: own } : {}) }
    })
}

function uniqueById(list: readonly BridgeLink[]): BridgeLink[] {
  const seen = new Set<string>()
  return list.filter((b) => !seen.has(b.id) && !!seen.add(b.id))
}

/**
 * Cables of `entry` worth adding back: both ends must be on the board (`liveIds`; the other end
 * may have been closed too) and the same pair must not be cabled already, in either direction.
 */
export function bridgesToRestore(
  bridges: readonly BridgeLink[] | undefined,
  liveIds: ReadonlySet<string>,
  existing: readonly Pick<BridgeLink, 'source' | 'target'>[],
): BridgeLink[] {
  const pair = (a: string, b: string) => (a < b ? `${a}\0${b}` : `${b}\0${a}`)
  const have = new Set(existing.map((e) => pair(e.source, e.target)))
  return (bridges ?? []).filter((b) => {
    if (!liveIds.has(b.source) || !liveIds.has(b.target)) return false
    const k = pair(b.source, b.target)
    if (have.has(k)) return false
    have.add(k)
    return true
  })
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
  /** Jalur node BARU di canvas aktif (`addFlowNode` di App): append + scheduleSave + riwayat layout.
   *  x/y opsional: tanpa itu node lahir di titik spawn biasa (Resume dari Agent History). */
  addNode: (make: (n: number, ws: Workspace) => PlacedNode) => void
  setWorkspaces: (fn: (prev: Workspace[]) => Workspace[]) => void
  /** Pindah ke workspace lain (`onSelect` di App). */
  selectWorkspace: (id: string) => Promise<void>
  /** Add cables to the ACTIVE canvas (dedup + save are the callee's); `alsoLive` = ids just added
   *  that the board may not show yet. Absent = cables not restored. */
  addBridges?: (bridges: readonly BridgeLink[], alsoLive?: readonly string[]) => void
}

/** Node yang akan ditaruh: x/y boleh absen (titik spawn dipilih canvas). */
export type PlacedNode = Omit<WsNode, 'x' | 'y'> & Partial<Pick<WsNode, 'x' | 'y'>>

/** Titik jatuh node yang ditulis ke workspace NON-aktif, di mana tidak ada canvas untuk memilihkan
 *  titik spawn. Pojok kiri atas board: selalu terlihat setelah pindah workspace + fit. */
const OFFSCREEN_SPAWN = { x: 80, y: 80 }

/**
 * Taruh `entry.node` di workspace `entry.workspaceId`. Dipakai reopen-closed DAN Resume Agent History supaya
 * keduanya punya satu jalur lintas-workspace. Workspace aktif: lewat `addNode` (riwayat layout +
 * simpan). Workspace lain: tulis ke salinan TERBARU dari server lalu pindah ke sana — menambah node
 * ke canvas yang sedang menampilkan workspace LAIN akan menaruhnya di board yang salah.
 */
export async function placeNode(
  entry: { node: PlacedNode; workspaceId: string; bridges?: readonly BridgeLink[] },
  deps: ReopenDeps,
): Promise<void> {
  const { workspaceId } = entry
  if (workspaceId === deps.activeId) {
    deps.addNode(() => entry.node)
    if (entry.bridges?.length) deps.addBridges?.(entry.bridges, [entry.node.id])
    return
  }
  const fresh = await getWorkspace(workspaceId)
  const full: WsNode = { ...OFFSCREEN_SPAWN, ...entry.node }
  const live = new Set([...fresh.nodes.map((n) => n.id), full.id])
  const cables = bridgesToRestore(entry.bridges, live, fresh.bridges ?? [])
  const updated: Workspace = {
    ...fresh, nodes: [...fresh.nodes, full], bridges: [...(fresh.bridges ?? []), ...cables], updatedAt: Date.now(),
  }
  await saveWorkspace(updated)
  deps.setWorkspaces((prev) => prev.map((w) => (w.id === updated.id ? updated : w)))
  await deps.selectWorkspace(workspaceId)
}

export interface ClosedHistory {
  /** Siap render: terbaru dulu, sudah disaring `visibleClosed`. */
  entries: ClosedEntry[]
  record: (nodeIds: readonly string[], nodes: readonly WsNode[], ws: ClosedOwner | null, bridges?: readonly BridgeLink[]) => void
  reopen: (nodeId: string, deps: ReopenDeps) => Promise<void>
  /** Cables stored for these node ids (a layout undo brought the nodes back, but not their edges). */
  bridgesOf: (nodeIds: readonly string[]) => BridgeLink[]
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
  // Sebelum salinan server termuat, TIDAK ada tulis: PUT daftar parsial akan menimpa riwayat yang
  // tersimpan dengan satu-dua entry yang kebetulan ditutup selama boot.
  const loaded = useRef(false)

  const commit = useCallback((next: ClosedEntry[]) => {
    ref.current = next
    setAll(next)
    if (!loaded.current) return
    saveClosedHistory(next).catch((e: unknown) => {
      // Daftar di memori tetap benar; hanya salinan tersimpannya tertinggal sampai commit berikutnya.
      console.error(`save closed history (${next.length} entries):`, e)
    })
  }, [])

  useEffect(() => {
    let live = true
    fetchClosedHistory()
      .then((stored) => {
        if (!live) return
        loaded.current = true
        // Yang ditutup selama boot (di `ref`) lebih baru dari yang tersimpan, jadi ia di depan.
        commit(pushClosed(stored, ref.current))
      })
      .catch((e: unknown) => {
        // Server tak menjawab: riwayat tetap jalan in-memory untuk tab ini, tanpa menimpa apa pun.
        console.error('load closed history:', e)
      })
    return () => {
      live = false
    }
  }, [commit])

  const record = useCallback<ClosedHistory['record']>(
    (nodeIds, nodes, ws, bridges) => {
      const add = closedEntriesFor(nodeIds, nodes, ws, Date.now(), bridges ?? ws?.bridges ?? [])
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
      try {
        await placeNode(entry, deps)
      } catch (e) {
        // Entry dikembalikan: snapshot node tadi satu-satunya salinan yang bisa memulihkannya, dan
        // tulis yang gagal tidak boleh ikut menghapusnya. Barisnya muncul lagi — itu sinyal yang
        // terlihat pengguna, dan webterm belum punya permukaan toast.
        commit(pushClosed(ref.current, [entry]))
        console.error(`reopen closed session ${nodeId} in workspace ${entry.workspaceId}:`, e)
      }
    },
    [commit],
  )

  const bridgesOf = useCallback<ClosedHistory['bridgesOf']>((nodeIds) => {
    const ids = new Set(nodeIds)
    return ref.current.filter((e) => ids.has(e.node.id)).flatMap((e) => e.bridges ?? [])
  }, [])

  const entries = useMemo(
    () => visibleClosed(all, workspaces.map((w) => w.id), (liveNodes ?? []).map((n) => n.id)),
    [all, workspaces, liveNodes],
  )

  return { entries, record, reopen, bridgesOf }
}
