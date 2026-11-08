// One shared WebSocket multiplexing many terminals by id.
// Survives refresh/reconnect: each subscriber's `open` params are retained and re-sent on every
// (re)connect with `since` (the last seq it drew), so the server re-attaches the PTY and replays
// only the gap, or `reset` + the whole scrollback when it cannot (pty-207-9).
// A subscriber whose session has exited is NOT replayed: its `open` would make the server spawn
// a fresh PTY and wipe the final scrollback the user is looking at.
import { emitFsEvent } from './fsEvents'
import { WS_PATH } from '../shared/protocol'
import type { CanvasMsg, ClientMsg, ExitMsg, OpenMsg, ServerMsg } from '../shared/protocol'
import { canResumeWith } from '../shared/workspace'
import type { AgentStatus } from '../shared/workspace'
import { noteStatus } from './unread'
import { reconnectDelay, setConnection } from './ws.connection'

interface Sub {
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

// Status is per-node but consumed by two readers: the node's own dot and the
// board overlay. Keep it on a separate channel so it survives independent of
// whether a terminal is currently mounted/subscribed.
// `undefined` ikut disiarkan: itu sapuan basi mencabut status (lihat `shared/agentStale.ts`), dan
// pembaca yang tidak mendengarnya akan menyimpan 'working' yang sudah dicabut selamanya.
const statuses = new Map<string, AgentStatus>()
const statusListeners = new Set<(id: string, status: AgentStatus | undefined) => void>()

export function subscribeStatus(cb: (id: string, status: AgentStatus | undefined) => void): () => void {
  statusListeners.add(cb)
  return () => { statusListeners.delete(cb) }
}
export function getStatus(id: string): AgentStatus | undefined { return statuses.get(id) }

const canvasListeners = new Set<(msg: CanvasMsg) => void>()

/** Nodes/cables the server added to a stored board (`t:'canvas'`). */
export function subscribeCanvas(cb: (msg: CanvasMsg) => void): () => void {
  canvasListeners.add(cb)
  return () => { canvasListeners.delete(cb) }
}
let ws: WebSocket | null = null
let everConnected = false
// Messages that wait for the socket, keyed so the queue stays bounded: the latest resize per
// terminal, one close per terminal, the latest watch state per dir. Input is NEVER queued: keys
// typed during an outage are dropped, not replayed into the shell minutes later (pty-207-5).
const queue = new Map<string, ClientMsg>()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let attempts = 0

const reconnectListeners = new Set<() => void>()

/**
 * Daftarkan callback yang jalan setelah tiap RECONNECT (bukan koneksi pertama), sesudah replay
 * `open` dan antrean; untuk memulihkan state per-koneksi di server (mis. langganan fswatch).
 */
export function onReconnect(cb: () => void): () => void {
  reconnectListeners.add(cb)
  return () => { reconnectListeners.delete(cb) }
}

function url(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  // No credential in the URL: the same-origin upgrade carries the `wt_ui` session cookie.
  return `${proto}://${location.host}${WS_PATH}`
}

const isOpen = (): boolean => ws !== null && ws.readyState === WebSocket.OPEN

function scheduleReconnect(): void {
  if (reconnectTimer) return
  const delay = reconnectDelay(attempts++)
  setConnection({ phase: everConnected ? 'reconnecting' : 'connecting', retryAt: Date.now() + delay })
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, delay)
}

/** Skip the backoff wait ("Retry now"). No-op while a socket exists. */
export function reconnectNow(): void {
  if (ws) return
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  connect()
}

function connect() {
  setConnection({ phase: everConnected ? 'reconnecting' : 'connecting' })
  ws = new WebSocket(url())
  ws.onopen = () => {
    // A reconnect re-attaches to live PTYs. The xterm still holds what it showed before the drop,
    // so its open carries `since`: the server sends only what came after, or `reset` first (the
    // xterm clears) when the gap is gone or the session is a different one. Without that, replay
    // onto the old screen duplicated every line (the macOS login banner piling up while idle).
    // Exited terminals are not replayed: their screen holds the exit notice.
    const wasReconnect = everConnected
    everConnected = true
    attempts = 0
    setConnection({ phase: 'connected' })
    for (const sub of subs.values()) {
      if (sub.open && !sub.exited) ws!.send(JSON.stringify(sub.epoch ? { ...sub.open, since: { epoch: sub.epoch, seq: sub.seq } } : sub.open))
    }
    const pending = [...queue.values()]
    queue.clear()
    for (const m of pending) ws!.send(JSON.stringify(m))
    if (wasReconnect) for (const cb of [...reconnectListeners]) {
      try { cb() } catch (err) { console.warn('ws: onReconnect listener failed', err) }
    }
  }
  ws.onmessage = (ev) => {
    let msg: ServerMsg
    try {
      msg = JSON.parse(ev.data)
    } catch (err) {
      console.warn('ws: ignoring a frame that is not JSON', err)
      return
    }
    if (msg.t === 'status') {
      if (msg.status === undefined) {
        // Sapuan basi: statusnya DICABUT, bukan diganti. Dan sengaja TIDAK lewat `noteStatus` —
        // sapuan bukan kabar, tidak ada yang terjadi untuk dibaca, jadi node ini tidak ditandai
        // belum-dibaca.
        statuses.delete(msg.id)
      } else {
        statuses.set(msg.id, msg.status)
        // Aturan SET unread hidup DI SINI, bukan di komponen node: ini satu-satunya tempat yang
        // melihat status node mana pun, termasuk node workspace non-aktif yang tak ter-mount.
        noteStatus(msg.id, msg.status)
      }
      for (const l of statusListeners) l(msg.id, msg.status)
      return
    }
    // Petunjuk watcher file manager (flag WATCH): lewat bus, bukan sub terminal.
    if (msg.t === 'fsdirty') { emitFsEvent({ kind: 'dirty', path: msg.dir, origin: 'remote' }); return }
    if (msg.t === 'canvas') { for (const l of [...canvasListeners]) l(msg); return }
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
      sub.onOutput(msg.data)
    } else if (msg.t === 'exit') {
      sub.exited = true
      sub.onExit(msg.code, exitReasonFor(msg.id, msg.reason))
    }
  }
  ws.onclose = () => {
    ws = null
    scheduleReconnect()
  }
  ws.onerror = () => ws?.close()
}

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

export function send(msg: ClientMsg) {
  if (msg.t === 'open') {
    const sub = subs.get(msg.id)
    if (sub) {
      // `open` eksplisit = sesi baru untuk id ini, jadi status keluar yang lama dilepas.
      sub.exited = false
      sub.open = replayOpen(msg) // remembered; onopen replays it on every (re)connect
    }
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    return // never queue 'open' — the reconnect/onopen replay covers the not-open case
  }
  if (msg.t === 'close') {
    // Dicatat SEBELUM dikirim: `exit` bisa tiba sebelum jawaban apa pun.
    closedByUs.add(msg.id)
  }
  if (msg.t === 'input' && (subs.get(msg.id)?.exited || !isOpen())) {
    // Dead session, or no socket: input is dropped, never queued. Queued keys would land in the
    // next PTY with this id, or in the shell long after the user stopped typing (the banner in
    // TerminalCore.offline.tsx says typing is paused).
    return
  }
  // Detach only matters to a live socket: a socket that closed already dropped every subscription.
  if (msg.t === 'detach' && !isOpen()) return
  if (msg.t === 'resize') {
    // `open` yang diingat ikut dibarui, kalau tidak ia membawa ukuran SAAT NODE LAHIR selamanya.
    // Selama PTY-nya hidup ukuran basi itu tak berakibat (re-attach mengabaikan `cols`/`rows`), tapi
    // sesudah RESTART SERVER registri sesinya kosong dan replay yang sama benar-benar MELUNCURKAN —
    // `spawnPty` memakai `cols`/`rows` pesan itu, jadi PTY duduk di ukuran lahir sementara xterm di
    // browser sudah di ukuran sekarang. Di sinilah satu-satunya tempat yang semua resize lewati.
    const sub = subs.get(msg.id)
    // Disalin, bukan dimutasi: `replayOpen` bisa mengembalikan objek pemanggil apa adanya.
    if (sub?.open && !sub.exited) sub.open = { ...sub.open, cols: msg.cols, rows: msg.rows }
  }
  if (isOpen()) ws!.send(JSON.stringify(msg))
  else if (msg.t !== 'input' && msg.t !== 'detach') {
    const key = 'dir' in msg ? `fs:${msg.dir}` : `${msg.t}:${msg.id}`
    queue.delete(key) // re-inserted at the end: the latest one keeps its place in send order
    queue.set(key, msg)
  }
}

export function subscribe(
  id: string,
  onOutput: (data: string) => void,
  onExit: (code: number, reason?: ExitReason) => void,
  onReset?: () => void
): () => void {
  // Remount = id ini hidup lagi dari sudut client: lepaskan memori close lama supaya `exit`
  // yang tertinggal tidak tersenyapkan, dan mulai tanpa `open` (mount baru mengirim miliknya).
  closedByUs.delete(id)
  const sub: Sub = { onOutput, onExit, onReset, seq: 0 }
  subs.set(id, sub)
  // A pending reconnect timer will connect; connecting now as well would leave two sockets.
  if (!ws && !reconnectTimer) connect()
  return () => {
    if (subs.get(id) !== sub) return // a newer mount owns this id now
    subs.delete(id)
    // Unmounted view: the server stops streaming this terminal to us; the session keeps running
    // and a remount re-opens and replays (pty-207-8).
    if (!sub.exited) send({ t: 'detach', id })
  }
}
