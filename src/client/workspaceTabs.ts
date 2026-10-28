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
