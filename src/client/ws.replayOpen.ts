import type { OpenMsg } from '../shared/protocol'
import { canResumeWith } from '../shared/workspace'

/**
 * Bentuk `open` yang DISIMPAN untuk replay, yang belum tentu sama dengan yang dikirim sekarang.
 *
 * Peluncuran pertama sebuah node agent mencetak session id-nya (`--session-id <sid>`), dan id itu
 * hanya bisa dicetak SEKALI: claude menolak yang kedua dengan "Session ID … is already in use."
 * (lihat `withSessionId` di shared/workspace.ts). Selama PTY-nya hidup itu tak berakibat — server
 * me-re-attach dan mengabaikan `cmd`/`resume` sepenuhnya — tapi sesudah RESTART SERVER registri
 * sesinya kosong, jadi replay yang sama benar-benar MELUNCURKAN, dan node-nya mati di peluncuran.
 * Jadi yang disimpan adalah bentuk sambungnya: `--resume <sid>` yang sama.
 *
 * Tanpa pemeriksaan transcript di sini dengan sengaja: kalau percakapannya sudah tidak ada di disk,
 * server menurunkan kembali `resume` lewat probe-nya sendiri (`server/transcriptPresence.ts`) dan
 * meluncurkan dengan `--session-id` plus catatan ke terminal. Jadi aman di kedua arah.
 */
export function replayOpen(msg: OpenMsg): OpenMsg {
  const sid = msg.sessionId
  // Digerbangi `canResumeWith`: tanpa bentuk resume yang membawa id, membalik `resume` justru
  // meluncurkan polos dan node itu kehilangan rantai sesinya (`launchLine`).
  if (!sid || !msg.agentId || !canResumeWith(msg.agentId, sid)) return msg
  return { ...msg, resume: true }
}
