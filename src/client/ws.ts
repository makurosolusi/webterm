// One shared WebSocket multiplexing many terminals by id.
// Survives refresh/reconnect: each subscriber's `open` params are retained and
// re-sent on every (re)connect so the server re-attaches the PTY and replays scrollback.
import { WS_PATH } from '../shared/protocol'
import type { ClientMsg, ServerMsg } from '../shared/protocol'
import type { AgentStatus } from '../shared/workspace'
import { tokenQuery } from './api'
import { noteStatus } from './unread'

interface Sub {
  onOutput: (data: string) => void
  onExit: (code: number) => void
  open?: ClientMsg & { t: 'open' } // last open sent for this id; replayed on reconnect
}

const subs = new Map<string, Sub>()

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
let ws: WebSocket | null = null
let queue: ClientMsg[] = []
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function url(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  // `new WebSocket` cannot set headers, so the token (when there is one) rides in the query.
  const q = tokenQuery()
  return `${proto}://${location.host}${WS_PATH}${q === '' ? '' : `?${q}`}`
}

function connect() {
  ws = new WebSocket(url())
  ws.onopen = () => {
    // Re-attach every known terminal first (replay), then drain anything queued.
    for (const sub of subs.values()) if (sub.open) ws!.send(JSON.stringify(sub.open))
    const pending = queue
    queue = []
    for (const m of pending) ws!.send(JSON.stringify(m))
  }
  ws.onmessage = (ev) => {
    let msg: ServerMsg
    try {
      msg = JSON.parse(ev.data)
    } catch {
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
    const sub = subs.get(msg.id)
    if (!sub) return
    if (msg.t === 'output') sub.onOutput(msg.data)
    else if (msg.t === 'exit') sub.onExit(msg.code)
  }
  ws.onclose = () => {
    ws = null
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, 1000)
  }
  ws.onerror = () => ws?.close()
}

export function send(msg: ClientMsg) {
  if (msg.t === 'open') {
    const sub = subs.get(msg.id)
    if (sub) sub.open = msg // remembered; onopen replays it on every (re)connect
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    return // never queue 'open' — the reconnect/onopen replay covers the not-open case
  }
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  else queue.push(msg)
}

export function subscribe(
  id: string,
  onOutput: (data: string) => void,
  onExit: (code: number) => void
): () => void {
  subs.set(id, { onOutput, onExit })
  if (!ws) connect()
  return () => { subs.delete(id) }
}
