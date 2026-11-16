// Tanda "belum dibaca" per node: turn yang BERAKHIR selagi kamu tidak menontonnya. Memakai
// `markUnread`/`clearUnread`, gerbang `watching`, dan aturan clear-on-select.
//
// Kanal tersendiri, bentuknya sama dengan kanal status di `./ws` dan untuk alasan yang sama: sesi
// di workspace NON-AKTIF tidak punya terminal yang ter-mount, tapi statusnya tetap datang lewat
// socket — dan justru itu kasus yang membuat section "Unread" ada. Menggantungkan tanda ini pada
// komponen node berarti kehilangan tepat sesi yang paling butuh ditandai.
//
// TIDAK DIPERSIST, tidak disimpan ke localStorage. Alasannya: `statuses`
// webterm juga tidak dipersist — ia dibangun ulang dari hook begitu socket tersambung. Tanda unread
// yang hidup lebih lama dari status yang membenarkannya akan membuat sidebar, sesudah reload,
// menaruh sesi di "Unread" sementara statusnya sendiri terbaca "Unknown": klaim tanpa bukti di
// belakangnya. Jadi umurnya sengaja disamakan dengan umur `statuses` — satu tab, mati bersama.
import { useEffect, useState } from 'react'
import type { AgentStatus } from '../shared/workspace'
import { noteAttention } from './osNotify'
import { setBadgeCount } from './osNotify.badge'

const unread = new Set<string>()
const listeners = new Set<(ids: ReadonlySet<string>) => void>()

/** Node yang sedang ditempati pengguna: `activeId` (terminal yang ber-fokus
 *  keyboard); di webterm seleksi canvas adalah sinyal setara yang memang ada. */
let watchingId: string | null = null

function emit(): void {
  // Snapshot baru tiap perubahan: pembacanya state React, yang butuh identitas baru untuk render.
  const snapshot: ReadonlySet<string> = new Set(unread)
  for (const l of listeners) l(snapshot)
  // Tab title + favicon carry the same count the sidebar's "Unread" section shows.
  setBadgeCount(unread.size)
}

/** Snapshot awal untuk pembaca yang baru mount (kanal ini tidak memancar ulang saat disubscribe). */
export function unreadIds(): ReadonlySet<string> {
  return new Set(unread)
}

export function subscribeUnread(cb: (ids: ReadonlySet<string>) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Idempoten: menandai yang sudah ditandai tidak memancarkan event — render ulang tanpa perubahan. */
export function markUnread(id: string): void {
  if (unread.has(id)) return
  unread.add(id)
  emit()
}

/** No-op untuk node yang tak pernah ditandai. */
export function clearUnread(id: string): void {
  if (!unread.delete(id)) return
  emit()
}

/** Aturan CLEAR. Pengguna masuk ke node ini: ia jadi node yang "ditonton", dan isinya dengan
 *  sendirinya terhitung sudah dibaca. Satu kejadian, jadi satu fungsi. */
export function watchNode(id: string): void {
  watchingId = id
  clearUnread(id)
}

/** Keluar dari node. Dijaga identitasnya: dua node yang bertukar seleksi mengirim `watchNode(B)`
 *  dan `unwatchNode(A)` dalam satu commit React, dan tanpa jaga ini A bisa membatalkan B. */
export function unwatchNode(id: string): void {
  if (watchingId === id) watchingId = null
}

function isWatching(id: string): boolean {
  if (watchingId !== id) return false
  // Jendela tak fokus = tidak menonton, walau node-nya terpilih — gerbang `document.hasFocus()`
  // Di luar browser (vitest node-env) tidak ada jendela untuk ditanyai, jadi di sana
  // seleksi sendiri yang menentukan.
  return typeof document === 'undefined' || document.hasFocus()
}

/**
 * Aturan SET, dipanggil kanal status `./ws` untuk SETIAP status yang masuk. Status yang mengakhiri
 * turn (`done`/`waiting`/`blocked`) menandai belum-dibaca kalau kamu tidak sedang menontonnya;
 * `working` tidak pernah menandai — turn yang baru mulai belum punya hasil untuk dibaca, dan ia
 * tetap tampil di section Running (lihat prioritas di `sessionStatusGroup`).
 */
export function noteStatus(id: string, status: AgentStatus, opts: { quiet?: boolean } = {}): void {
  // OS notification has its own, stricter gate (transition-only, in-view, mute) — see `./osNotify`.
  // `quiet` (completionAlert): no banner or chime, the unread mark still lands.
  if (!opts.quiet) noteAttention(id, status, isWatching(id))
  if (status === 'working') return
  if (!isWatching(id)) markUnread(id)
}

/** React hook: the unread ids, re-rendering on change (snapshot read at mount, then every emit). */
export function useUnreadIds(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(unreadIds)
  useEffect(() => subscribeUnread(setIds), [])
  return ids
}
