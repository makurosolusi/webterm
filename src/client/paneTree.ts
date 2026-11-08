// Operasi pohon pane node terminal — split terminal seperti Ghostty/iTerm/tmux.
//
// MURNI dan serializable: pohonnya hidup di `data.panes` node React Flow dan dipersist apa adanya
// di blob JSON workspace (`WsNode.panes`). Nol DOM di sini supaya semua keputusan bentuk pohon bisa
// diuji di node-env; satu-satunya yang menyentuh geometri adalah `ratioFromPointer`, dan ia menerima
// rect sebagai argumen, bukan membacanya sendiri.
//
// Tipenya (`Pane`/`PaneLeaf`/`PaneSplit`) hidup di `shared/workspace.ts` bersama bentuk persisted
// lainnya, dengan pola yang sama seperti `Comment`: tipe di shared, logikanya di sini.
import type { Pane, PaneLeaf, PaneSplit } from '../shared/workspace'
import { paneLeafIds, sessionIdsOf } from '../shared/paneSessions'

export { sessionIdsOf }

export const isLeaf = (p: Pane): p is PaneLeaf => 'id' in p

/** Porsi minimum satu sisi. Pane yang bisa digeser sampai nol hilang tanpa jejak sementara PTY-nya
 *  tetap hidup — tak terlihat, tak bisa ditutup. */
export const MIN_RATIO = 0.1

/** Alamat sebuah cabang: urutan langkah 'a'/'b' dari akar, string kosong = akar sendiri. Dipakai
 *  komponen pane untuk mengatakan cabang MANA yang rasionya berubah tanpa memberi id pada cabang. */
export type PanePath = string

/** Pohon efektif sebuah node. Node tanpa `panes` (termasuk SEMUA board yang tersimpan sebelum
 *  fitur ini ada) jadi satu daun ber-id node itu, jadi shell-nya tidak pernah ganti id. */
export function rootPane(nodeId: string, panes?: Pane): Pane {
  return panes ?? { id: nodeId }
}

/** Semua id PTY di dalam pohon, urut kiri-ke-kanan / atas-ke-bawah (shared: server ikut memakainya). */
export const leafIds = paneLeafIds

/**
 * Ganti daun `targetId` dengan split dua: daun itu jadi `a`, pane baru jadi `b`.
 *
 * Mengembalikan pohon yang SAMA (identitas objek) kalau `targetId` tidak ada — pemanggil memakai
 * itu sebagai sinyal "tidak ada yang terbelah", dan React juga melewati render ulang karenanya.
 */
export function splitLeaf(root: Pane, targetId: string, dir: PaneSplit['dir'], newId: string): Pane {
  if (isLeaf(root)) {
    return root.id === targetId ? { dir, ratio: 0.5, a: root, b: { id: newId } } : root
  }
  const a = splitLeaf(root.a, targetId, dir, newId)
  const b = splitLeaf(root.b, targetId, dir, newId)
  return a === root.a && b === root.b ? root : { ...root, a, b }
}

/**
 * Buang daun `targetId` dan KEMPISKAN cabangnya: cabang yang tinggal satu anak digantikan anak itu.
 * Tanpa pengempisan, pohon menyimpan cabang dengan satu sisi kosong dan pane sisanya tidak pernah
 * mengambil kembali ruang yang ditinggalkan.
 *
 * `null` = daun itu satu-satunya di pohon, jadi tidak ada lagi node yang bisa ditampilkan — pemanggil
 * yang memutuskan artinya (menutup seluruh node).
 */
export function closeLeaf(root: Pane, targetId: string): Pane | null {
  if (isLeaf(root)) return root.id === targetId ? null : root
  const a = closeLeaf(root.a, targetId)
  const b = closeLeaf(root.b, targetId)
  if (!a) return b
  if (!b) return a
  return a === root.a && b === root.b ? root : { ...root, a, b }
}

/** Rasio baru untuk cabang di `path`. Dijepit ke `MIN_RATIO` di kedua ujung. */
export function setRatio(root: Pane, path: PanePath, ratio: number): Pane {
  if (isLeaf(root)) return root
  if (path === '') {
    return { ...root, ratio: Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio)) }
  }
  const rest = path.slice(1)
  if (path[0] === 'a') {
    const a = setRatio(root.a, rest, ratio)
    return a === root.a ? root : { ...root, a }
  }
  const b = setRatio(root.b, rest, ratio)
  return b === root.b ? root : { ...root, b }
}

/** Id untuk pane BARU di dalam `root`, diturunkan dari id node. Menghindari id yang sudah dipakai:
 *  dua PTY ber-id sama akan saling menimpa di registri sesi server. */
export function nextPaneId(root: Pane, nodeId: string): string {
  const used = new Set(leafIds(root))
  let n = used.size + 1
  while (used.has(`${nodeId}:p${n}`)) n++
  return `${nodeId}:p${n}`
}

/**
 * Rasio dari posisi pointer di dalam rect sebuah cabang. Dijepit sama seperti `setRatio`.
 *
 * Span nol → 0.5: itu keadaan "belum terukur" (node collapsed, elemen belum ter-layout), dan
 * membagi dengan nol di sana akan menulis `NaN` ke pohon yang DIPERSIST.
 */
export function ratioFromPointer(
  rect: { left: number; top: number; width: number; height: number },
  point: { x: number; y: number },
  dir: PaneSplit['dir'],
): number {
  const span = dir === 'h' ? rect.width : rect.height
  if (span <= 0) return 0.5
  const at = dir === 'h' ? point.x - rect.left : point.y - rect.top
  return Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, at / span))
}

/** Kotak di dalam badan node, dalam PERSEN. Persen, bukan piksel: node bisa di-resize dan di-zoom
 *  kapan saja, dan layout yang menyimpan piksel harus dihitung ulang setiap kali itu terjadi. */
export interface Box { left: number; top: number; width: number; height: number }

/** Satu daun beserta tempatnya. */
export interface PaneRect extends Box { id: string }

/** Satu pembatas: `at` adalah posisi batasnya (persen, pada sumbu split), `box` kotak CABANG-nya —
 *  dipakai dua kali, untuk merentangkan pembatas dan untuk mengubah posisi pointer jadi rasio. */
export interface DividerRect { path: PanePath; dir: PaneSplit['dir']; at: number; box: Box }

const WHOLE: Box = { left: 0, top: 0, width: 100, height: 100 }

/** 4 desimal sudah di bawah satu piksel untuk node selebar apa pun, dan membuat angkanya bisa
 *  dibandingkan: `100 * 0.3` di JS adalah 30.000000000000004, dan itu ikut masuk ke string CSS. */
const r4 = (n: number): number => Math.round(n * 1e4) / 1e4

/**
 * Pohon → daftar RATA daun beserta kotaknya, plus pembatasnya.
 *
 * KENAPA RATA: kalau tiap cabang dirender sebagai elemen bersarang, membelah sebuah daun memindahkan
 * daun itu satu tingkat lebih dalam — dan React tidak bisa mempertahankan komponen yang berpindah
 * posisi di pohon, jadi SETIAP `TerminalCore` di node itu dibuang dan dibuat ulang pada tiap split
 * (seleksi, pencarian, dan posisi scroll lokal hilang; server lalu memutar ulang seluruh scrollback).
 * Dengan daftar rata ber-key id pane, kedalaman komponennya tidak pernah berubah: yang berubah cuma
 * `style`-nya.
 */
export function paneLayout(root: Pane, box: Box = WHOLE, path: PanePath = ''): {
  panes: PaneRect[]
  dividers: DividerRect[]
} {
  if (isLeaf(root)) return { panes: [{ id: root.id, ...box }], dividers: [] }
  const horiz = root.dir === 'h'
  const span = horiz ? box.width : box.height
  const first = r4(span * root.ratio)
  const rest = r4(span - first)
  const a = horiz ? { ...box, width: first } : { ...box, height: first }
  const b = horiz
    ? { ...box, left: r4(box.left + first), width: rest }
    : { ...box, top: r4(box.top + first), height: rest }
  const at = horiz ? r4(box.left + first) : r4(box.top + first)
  const left = paneLayout(root.a, a, path + 'a')
  const right = paneLayout(root.b, b, path + 'b')
  return {
    panes: [...left.panes, ...right.panes],
    dividers: [{ path, dir: root.dir, at, box }, ...left.dividers, ...right.dividers],
  }
}

/** Kotak persen → rect PIKSEL, relatif terhadap rect host. Pasangan `ratioFromPointer`: pembatas
 *  duduk di host (bukan di dalam cabangnya), jadi rect cabangnya harus dihitung, bukan diukur. */
export function boxRect(host: { left: number; top: number; width: number; height: number }, box: Box) {
  return {
    left: host.left + (host.width * box.left) / 100,
    top: host.top + (host.height * box.top) / 100,
    width: (host.width * box.width) / 100,
    height: (host.height * box.height) / 100,
  }
}

/**
 * `sessionIdsOf` untuk node React Flow (pohonnya di `data.panes`), dicari per id.
 *
 * Id yang tidak ditemukan di `nodes` tetap dipulangkan apa adanya: itu perilaku lama (server
 * mengabaikan `close` untuk id tak dikenal), dan menyaringnya di sini akan MEMBATALKAN penutupan
 * sesi yang node-nya memang sudah lepas dari daftar.
 */
export function paneSessionIds(
  nodes: readonly { id: string; data?: unknown }[],
  removed: readonly string[],
): string[] {
  return removed.flatMap((id) =>
    sessionIdsOf((nodes.find((n) => n.id === id)?.data as { panes?: Pane } | undefined)?.panes, id),
  )
}
