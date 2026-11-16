// Per-terminal subscriber registry of the shared socket: who draws which id, the `open` each one
// replays on reconnect, and routing of a server frame to its subscriber. No socket access here;
// ws.ts owns the connection and calls in (same split as ws.streams.ts).
import type { ClientMsg, ExitMsg, ServerMsg } from '../shared/protocol'
import { replayOpen } from './ws.replayOpen'
import { noteServerMsg } from './nodeActivity.store'

export interface Sub {
  onOutput: (data: string) => void
  onExit: (code: number, reason?: ExitReason) => void
  onReset?: () => void
  open?: ClientMsg & { t: 'open' } // last open sent for this id; replayed on reconnect
  /** PTY sudah berhenti: jangan putar ulang `open` (itu men-spawn PTY baru) atau antre input. */
  exited?: boolean
  /** Session log this xterm is drawing (from the server's `reset`) and the last seq it drew. */
  epoch?: string
  seq: number
}

/**
 * Kenapa PTY berhenti, dari sudut pandang client ini. `self`/`closed` berasal dari server
 * (`ExitMsg['reason']`): `closed` berarti ADA yang meminta close, bukan prosesnya yang keluar.
 * Karena itu client menambahkan `peer-closed` untuk close yang diminta client LAIN — tanpa itu,
 * menutup satu node di satu tab membuat terminal itu senyap di semua tab.
 */
export type ExitReason = NonNullable<ExitMsg['reason']> | 'peer-closed'

const subs = new Map<string, Sub>()

// Close yang KITA minta. Server hanya tahu "ada yang menutup", jadi hanya client ini yang bisa
// membedakan close-nya sendiri (tidak perlu dikabarkan) dari close client lain (perlu notice).
const closedByUs = new Set<string>()

/**
 * Terjemahkan intent server ke sudut pandang client. `closed` yang tidak kita minta menjadi
 * `peer-closed`; intent masuk dikonsumsi supaya close berikutnya tidak ikut tersenyapkan.
 */
function exitReasonFor(id: string, reason: ExitMsg['reason']): ExitReason | undefined {
  if (reason !== 'closed') return reason
  return closedByUs.delete(id) ? 'closed' : 'peer-closed'
}

/** True while at least one terminal is subscribed. */
export const hasSubs = (): boolean => subs.size > 0

/** Register a subscriber for `id`, replacing any earlier one; a remount forgets an old close we asked for. */
export function addSub(
  id: string,
  onOutput: (data: string) => void,
  onExit: (code: number, reason?: ExitReason) => void,
  onReset?: () => void
): Sub {
  // Remount = id ini hidup lagi dari sudut client: lepaskan memori close lama supaya `exit`
  // yang tertinggal tidak tersenyapkan, dan mulai tanpa `open` (mount baru mengirim miliknya).
  closedByUs.delete(id)
  const sub: Sub = { onOutput, onExit, onReset, seq: 0 }
  subs.set(id, sub)
  return sub
}

/** Drop `sub` unless a newer mount already owns its id; true when it was removed. */
export function removeSub(id: string, sub: Sub): boolean {
  if (subs.get(id) !== sub) return false
  subs.delete(id)
  return true
}

/** The `open` messages to re-send on every (re)connect, with `since` so the server replays only the gap. */
export function replayMessages(): ClientMsg[] {
  const out: ClientMsg[] = []
  for (const sub of subs.values()) {
    if (sub.open && !sub.exited) out.push(sub.epoch ? { ...sub.open, since: { epoch: sub.epoch, seq: sub.seq } } : sub.open)
  }
  return out
}

/** This terminal's PTY already exited (its input is dropped, not queued). */
export const isExited = (id: string): boolean => subs.get(id)?.exited === true

/** Remember an outgoing `open` for replay; an explicit `open` is a new session, so the old exit state is released. */
export function noteOpenSent(msg: ClientMsg & { t: 'open' }): void {
  const sub = subs.get(msg.id)
  if (sub) {
    // `open` eksplisit = sesi baru untuk id ini, jadi status keluar yang lama dilepas.
    sub.exited = false
    sub.open = replayOpen(msg) // remembered; onopen replays it on every (re)connect
  }
}

/** Record a close WE asked for, BEFORE it is sent: `exit` can arrive before any reply. */
export function noteCloseRequested(id: string): void {
  closedByUs.add(id)
}

/** Keep the remembered `open` at the terminal's current size. */
export function noteResize(msg: ClientMsg & { t: 'resize' }): void {
  // `open` yang diingat ikut dibarui, kalau tidak ia membawa ukuran SAAT NODE LAHIR selamanya.
  // Selama PTY-nya hidup ukuran basi itu tak berakibat (re-attach mengabaikan `cols`/`rows`), tapi
  // sesudah RESTART SERVER registri sesinya kosong dan replay yang sama benar-benar MELUNCURKAN —
  // `spawnPty` memakai `cols`/`rows` pesan itu, jadi PTY duduk di ukuran lahir sementara xterm di
  // browser sudah di ukuran sekarang. Di sinilah satu-satunya tempat yang semua resize lewati.
  const sub = subs.get(msg.id)
  // Disalin, bukan dimutasi: `replayOpen` bisa mengembalikan objek pemanggil apa adanya.
  if (sub?.open && !sub.exited) sub.open = { ...sub.open, cols: msg.cols, rows: msg.rows }
}

/** Route a terminal frame (reset / output / exit) to its subscriber; frames for unknown ids are ignored. */
export function dispatchTerminalFrame(msg: Extract<ServerMsg, { t: 'reset' | 'output' | 'exit' }>): void {
  const sub = subs.get(msg.id)
  if (!sub) return
  if (msg.t === 'reset') {
    sub.epoch = msg.epoch
    sub.seq = 0
    sub.onReset?.()
  } else if (msg.t === 'output') {
    // seq at or below the last drawn = a chunk this xterm already shows (overlapping replay).
    if (msg.seq !== undefined) {
      if (msg.seq <= sub.seq) return
      sub.seq = msg.seq
    }
    noteServerMsg(msg)
    sub.onOutput(msg.data)
  } else if (msg.t === 'exit') {
    sub.exited = true
    const reason = exitReasonFor(msg.id, msg.reason)
    noteServerMsg(msg, reason)
    sub.onExit(msg.code, reason)
  }
}

/** Test teardown: forget every subscriber and every close we asked for. */
export function resetTerminalsForTests(): void {
  subs.clear()
  closedByUs.clear()
}
