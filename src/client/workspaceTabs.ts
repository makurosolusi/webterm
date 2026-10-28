// Logika murni di balik tab workspace pada header bar: dot mana yang dipakai sebuah tab, dan
// kalimat apa yang dibawa tooltip-nya. Dipisah dari komponen karena vitest webterm jalan di
// node-env tanpa DOM, jadi keputusan yang bisa di-assert harus hidup di luar JSX.
//
// KENAPA dot workspace NON-AKTIF selalu netral — ini batas sumber data, bukan kemalasan:
// `AgentStatus` hanya sampai ke client lewat socket node yang terbuka. `Sessions.setStatus`
// (src/server/sessions.ts) mengirim `{ t: 'status' }` ke `this.map.get(id)?.send`, yaitu socket
// node ITU saja, dan sebuah node baru masuk ke map setelah terminalnya mengirim `open`. Canvas
// hanya me-mount node workspace AKTIF (ReactFlow di-remount per `activeId`), jadi untuk workspace
// lain `statuses[node.id]` selalu `undefined`. Mewarnai dot mereka berarti mengarang status;
// yang benar adalah mengatakan "tidak diketahui" dan menyebutkannya di tooltip.
import { signalCounts, type SessionGroup } from './sessionList'

/** Glyph dot sebuah tab. 'neutral' = TIDAK DIKETAHUI, bukan "sehat". */
export type TabDot = 'attention' | 'working' | 'idle' | 'neutral'

/**
 * Dot untuk satu baris workspace hasil `buildSessionList`. Prioritas sama dengan sidebar sesi
 * (`sessionStatusGroup`): yang menuntut kamu mengalahkan yang sedang bekerja, karena satu tab
 * hanya punya satu glyph. Workspace tanpa sesi juga netral — tidak ada yang bisa punya status.
 */
export function workspaceTabDot(group: SessionGroup): TabDot {
  if (!group.isActive) return 'neutral'
  const { attention, working } = signalCounts(group.sessions)
  if (attention > 0) return 'attention'
  if (working > 0) return 'working'
  return group.sessions.length > 0 ? 'idle' : 'neutral'
}

/** Tooltip tab: jumlah sesi, lalu rinciannya. Pada workspace non-aktif tooltip-nya MENYEBUT
 *  kenapa tidak ada status, supaya dot kelabu tidak terbaca sebagai "semuanya diam". */
export function workspaceTabTitle(group: SessionGroup): string {
  const n = group.sessions.length
  const count = `${n} session${n === 1 ? '' : 's'}`
  if (!group.isActive) {
    return `${group.projectName} — ${count}; status is live only for the open workspace`
  }
  const { attention, working } = signalCounts(group.sessions)
  const parts = [count]
  if (attention > 0) parts.push(`${attention} waiting for you`)
  if (working > 0) parts.push(`${working} running`)
  return `${group.projectName} — ${parts.join(', ')}`
}

/** Sisi strip tab yang masih MENYEMBUNYIKAN tab. 'none' = seluruh deretan terlihat. */
export type TabOverflow = 'none' | 'left' | 'right' | 'both'

/** Toleransi sub-piksel. `scrollLeft` fraksional (zoom halaman, display HiDPI) sementara
 *  `scrollWidth`/`clientWidth` dibulatkan ke integer, jadi strip yang sudah digulung habis ke kanan
 *  bisa menyisakan beda <1px dan perbandingan ketat akan melaporkan "masih ada yang tersembunyi"
 *  selamanya — pita pudar yang tidak pernah hilang justru berbohong tentang tab yang tidak ada. */
const SCROLL_SLACK_PX = 1

/**
 * Sisi mana yang pantas dipudarkan, dari geometri gulung strip. Hanya sisi yang BENAR-BENAR punya
 * konten tersembunyi: memudarkan tepi yang tidak menyembunyikan apa pun menjanjikan tab yang tidak
 * ada. Semua argumen piksel layout, jadi aman dipanggil dengan nilai apa adanya dari elemen.
 */
export function tabStripOverflow(scrollLeft: number, clientWidth: number, scrollWidth: number): TabOverflow {
  const hiddenLeft = scrollLeft > SCROLL_SLACK_PX
  const hiddenRight = scrollLeft + clientWidth < scrollWidth - SCROLL_SLACK_PX
  if (hiddenLeft && hiddenRight) return 'both'
  if (hiddenLeft) return 'left'
  return hiddenRight ? 'right' : 'none'
}

/**
 * Apakah strip masih punya ruang gulung ke arah `delta` (positif = ke kanan). Dipakai untuk
 * memutuskan apakah roda mouse boleh DITELAN: menelannya di strip yang sudah habis (atau yang tidak
 * menggulung sama sekali) mencuri gulungan dari halaman/canvas di bawahnya tanpa memberi apa pun.
 */
export function canScrollStripBy(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
  delta: number,
): boolean {
  const sides = tabStripOverflow(scrollLeft, clientWidth, scrollWidth)
  if (delta > 0) return sides === 'right' || sides === 'both'
  if (delta < 0) return sides === 'left' || sides === 'both'
  return false
}
