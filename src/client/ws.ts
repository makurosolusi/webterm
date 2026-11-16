// One shared WebSocket multiplexing many terminals by id.
// Survives refresh/reconnect: each subscriber's `open` params are retained and re-sent on every
// (re)connect with `since` (the last seq it drew), so the server re-attaches the PTY and replays
// only the gap, or `reset` + the whole scrollback when it cannot (pty-207-9).
// A subscriber whose session has exited is NOT replayed: its `open` would make the server spawn
// a fresh PTY and wipe the final scrollback the user is looking at.
// Offline resilience: full-jitter backoff, wake triggers + app-level heartbeat (ws.liveness.ts),
// the server `hello` (restart / new build) and an auth probe that stops a refused credential looping.
import { HEALTH_PATH, WS_PATH } from '../shared/protocol'
import type { ClientMsg, ExitMsg, HelloMsg, ServerMsg } from '../shared/protocol'
import { replayOpen } from './ws.replayOpen'
import { type ConnectionPhase, getConnection, reconnectDelay, setConnection, setRetryHandler } from './ws.connection'
import { dispatchBroadcast, notifyReconnect } from './ws.listeners'
import { browserOffline, createHeartbeat, installWakeTriggers } from './ws.liveness'
import { noteClientMsg, noteServerMsg } from './nodeActivity.store'
import { addStream, dispatchStreamFrame, streamsSocketClosed, streamsSocketOpened, __resetStreamsForTests, type WsEventSource } from './ws.streams'

export { replayOpen } from './ws.replayOpen'
export { STREAM_CLOSED, STREAM_CONNECTING, STREAM_OPEN, type WsEventSource } from './ws.streams'
export { getStatus, onReconnect, subscribeAct, subscribeCanvas, subscribeShot, subscribeStatus, subscribeView, subscribeWorkspaces } from './ws.listeners'

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

let ws: WebSocket | null = null
let everConnected = false
/** The current socket fired `open` (a close before that is a refused/failed connect). */
let opened = false
// Messages that wait for the socket, keyed so the queue stays bounded: the latest resize per
// terminal, one close per terminal, the latest watch state per dir. Input is NEVER queued: keys
// typed during an outage are dropped, not replayed into the shell minutes later (pty-207-5).
const queue = new Map<string, ClientMsg>()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let attempts = 0
/** The server refused our credential: no retry loop until `retryNow()`. */
let authStopped = false
let probing = false
let uninstallTriggers: (() => void) | null = null
/** Build of the first `hello` this page met: what its bundle was served with. */
let pageBuild: string | undefined
/** `connectEagerly()` ran: the app wants the socket even with no terminal subscribed. */
let eager = false

const isOpen = (): boolean => ws !== null && ws.readyState === WebSocket.OPEN
const waitingPhase = (): ConnectionPhase => (everConnected ? 'reconnecting' : 'connecting')

// Half-open socket (no pong): abandon it now. `close()` on a dead link can take minutes to fire
// `onclose`, so the handlers are detached and the close path runs right away.
const heartbeat = createHeartbeat((id) => { if (isOpen()) ws!.send(JSON.stringify({ t: 'ping', id })) }, () => abandonSocket())

function abandonSocket(): void {
  const s = ws
  if (!s) return
  s.onopen = s.onmessage = s.onclose = s.onerror = null
  s.close()
  socketClosed()
}

function scheduleReconnect(): void {
  if (reconnectTimer || authStopped) return
  // No network: waiting out a backoff only burns attempts. `online` (a wake trigger) resumes.
  if (browserOffline()) { setConnection({ phase: 'offline', attempt: attempts }); return }
  const delay = reconnectDelay(attempts++)
  setConnection({ phase: waitingPhase(), attempt: attempts, retryAt: Date.now() + delay })
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, delay)
}

function clearTimer(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
}

/** Skip the backoff wait and connect now; also leaves the `auth` and `offline` stops. No-op while a socket exists. */
export function reconnectNow(): void {
  authStopped = false
  if (ws) return
  clearTimer()
  connect()
}
setRetryHandler(reconnectNow)

/** A wake event: check a socket that looks open, or retry a closed one without waiting. */
function wake(): void {
  if (authStopped) return
  if (isOpen()) heartbeat.probe()
  else if (!ws && (eager || subs.size > 0 || everConnected)) { clearTimer(); connect() }
}

function wentOffline(): void {
  if (isOpen()) { heartbeat.probe(); return } // a real drop shows up as a missed pong
  if (ws || authStopped || !browserOffline()) return
  clearTimer()
  setConnection({ phase: 'offline', attempt: attempts })
}

/**
 * A connect failed before opening: ask /api/health why. 401/403 = our credential is refused, which
 * no amount of retrying fixes; anything else (network error, 5xx) keeps the backoff going.
 */
function probeAuth(): void {
  if (probing || typeof fetch !== 'function') return
  probing = true
  fetch(HEALTH_PATH, { cache: 'no-store' })
    .then((r) => r.status, () => 0) // 0 = unreachable: the server is down, not refusing us
    .then((status) => {
      probing = false
      if ((status !== 401 && status !== 403) || isOpen()) return
      authStopped = true
      clearTimer()
      if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); ws = null }
      setConnection({ phase: 'auth', attempt: attempts })
    })
}

function noteHello(m: HelloMsg): void {
  const prev = getConnection()
  pageBuild ??= m.build
  setConnection({
    phase: prev.phase,
    bootId: m.bootId,
    build: m.build,
    serverRestartedAt: prev.bootId && prev.bootId !== m.bootId ? Date.now() : prev.serverRestartedAt,
    buildChanged: m.build !== pageBuild,
  })
}

function socketClosed(): void {
  const failedConnect = !opened
  ws = null
  opened = false
  heartbeat.stop()
  streamsSocketClosed()
  scheduleReconnect()
  if (failedConnect) probeAuth()
}

/**
 * Open the socket. Every path (first subscribe, reconnect timer, wake trigger, retry) routes here.
 * No `location` = the DOM is gone: a timer outlived its page (a torn-down jsdom test environment),
 * and there is no origin to connect to.
 */
function connect() {
  if (typeof location === 'undefined') return
  uninstallTriggers ??= installWakeTriggers({ wake, offline: wentOffline })
  setConnection({ phase: waitingPhase(), attempt: attempts })
  // No credential in the URL: the same-origin upgrade carries the `wt_ui` session cookie.
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`)
  ws.onopen = () => {
    // A reconnect re-attaches to live PTYs. The xterm still holds what it showed before the drop,
    // so its open carries `since`: the server sends only what came after, or `reset` first (the
    // xterm clears) when the gap is gone or the session is a different one. Without that, replay
    // onto the old screen duplicated every line (the macOS login banner piling up while idle).
    // Exited terminals are not replayed: their screen holds the exit notice.
    const wasReconnect = everConnected
    everConnected = true
    opened = true
    attempts = 0
    heartbeat.start()
    setConnection({ phase: 'connected', attempt: 0 })
    for (const sub of subs.values()) {
      if (sub.open && !sub.exited) ws!.send(JSON.stringify(sub.epoch ? { ...sub.open, since: { epoch: sub.epoch, seq: sub.seq } } : sub.open))
    }
    const pending = [...queue.values()]
    queue.clear()
    for (const m of pending) ws!.send(JSON.stringify(m))
    streamsSocketOpened()
    if (wasReconnect) notifyReconnect()
  }
  ws.onmessage = (ev) => {
    let msg: ServerMsg
    try {
      msg = JSON.parse(ev.data)
    } catch (err) {
      console.warn('ws: ignoring a frame that is not JSON', err)
      return
    }
    if (msg.t === 'pong') { heartbeat.pong(msg.id); return }
    if (msg.t === 'hello') { noteHello(msg); return }
    if (dispatchBroadcast(msg) || dispatchStreamFrame(msg)) return
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
  ws.onclose = socketClosed
  ws.onerror = () => ws?.close()
}

/**
 * Open the shared socket now, not on the first terminal subscribe (App calls it once signed in).
 * Like VS Code connecting its remote at once: heartbeat, `hello` (restart / new build), broadcasts
 * and the auth probe then run on every screen, and a board with no terminal (Welcome) reaches
 * `connected` instead of sitting in `connecting` with no attempt behind it.
 */
export function connectEagerly(): void {
  eager = true
  if (!ws && !reconnectTimer && !authStopped) connect()
}

/** Test teardown: drop the socket, every timer, the window listeners and all per-page state. */
export function __resetWsForTests(): void {
  clearTimer()
  heartbeat.stop()
  uninstallTriggers?.(); uninstallTriggers = null
  if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); ws = null }
  subs.clear(); queue.clear(); closedByUs.clear(); __resetStreamsForTests()
  everConnected = opened = authStopped = probing = eager = false; attempts = 0; pageBuild = undefined
  setConnection({ phase: 'connecting', attempt: 0, bootId: undefined, build: undefined, serverRestartedAt: undefined, buildChanged: false })
}

/**
 * An EventSource-compatible stream of GET `url` (an /api/ SSE route), carried on this socket so it
 * holds no HTTP connection (ws.streams.ts). Use it instead of `new EventSource(url)`.
 */
export function openEventStream(url: string): WsEventSource {
  const stream = addStream(url, (m) => { if (!isOpen()) return false; ws!.send(JSON.stringify(m)); return true })
  if (!ws && !reconnectTimer && !authStopped) connect()
  return stream
}

export function send(msg: ClientMsg) {
  noteClientMsg(msg)
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
  if (!ws && !reconnectTimer && !authStopped) connect()
  return () => {
    if (subs.get(id) !== sub) return // a newer mount owns this id now
    subs.delete(id)
    // Unmounted view: the server stops streaming this terminal to us; the session keeps running
    // and a remount re-opens and replays (pty-207-8).
    if (!sub.exited) send({ t: 'detach', id })
  }
}
