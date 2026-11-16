// Broadcast frames of the shared terminal socket (ws.ts) that are not tied to one terminal
// subscriber: agent status, fs dirty hints, canvas pushes, view/shot requests, workspace list.
import { emitFsEvent } from './fsEvents'
import type { ActMsg, CanvasMsg, NetMsg, ServerMsg, ShotMsg, StatusReason, ViewMsg, WorkspacesMsg } from '../shared/protocol'
import type { AgentStatus } from '../shared/workspace'
import { noteStatus } from './unread'

// Status is per-node but consumed by two readers: the node's own dot and the
// board overlay. Keep it on a separate channel so it survives independent of
// whether a terminal is currently mounted/subscribed.
// `undefined` ikut disiarkan: itu sapuan basi mencabut status (lihat `shared/agentStale.ts`), dan
// pembaca yang tidak mendengarnya akan menyimpan 'working' yang sudah dicabut selamanya.
const statuses = new Map<string, AgentStatus>()
const reasons = new Map<string, StatusReason>()
type StatusListener = (id: string, status: AgentStatus | undefined, reason: StatusReason | undefined) => void
const statusListeners = new Set<StatusListener>()

/** Listen to every agent status change (including the stale sweep's `undefined`); `reason` = why it needs you or failed. */
export function subscribeStatus(cb: StatusListener): () => void {
  statusListeners.add(cb)
  return () => { statusListeners.delete(cb) }
}
/** Last known agent status of node `id`. */
export function getStatus(id: string): AgentStatus | undefined { return statuses.get(id) }
/** Reason of node `id`'s current status (permission tool, question, error), when the server gave one. */
export function getStatusReason(id: string): StatusReason | undefined { return reasons.get(id) }

const canvasListeners = new Set<(msg: CanvasMsg) => void>()
/** Nodes/cables the server added to a stored board (`t:'canvas'`). */
export function subscribeCanvas(cb: (msg: CanvasMsg) => void): () => void {
  canvasListeners.add(cb)
  return () => { canvasListeners.delete(cb) }
}

const viewListeners = new Set<(msg: ViewMsg) => void>()
/** The central agent asks this window to show a board (and maybe one node): `t:'view'`. */
export function subscribeView(cb: (msg: ViewMsg) => void): () => void {
  viewListeners.add(cb)
  return () => { viewListeners.delete(cb) }
}

const workspacesListeners = new Set<(msg: WorkspacesMsg) => void>()
/** The server's workspace list changed (Central's `workspace.create`): `t:'workspaces'`. */
export function subscribeWorkspaces(cb: (msg: WorkspacesMsg) => void): () => void {
  workspacesListeners.add(cb)
  return () => { workspacesListeners.delete(cb) }
}

const shotListeners = new Set<(msg: ShotMsg) => void>()
/** The central agent asks for a screenshot of what the user sees: `t:'shot'`. */
export function subscribeShot(cb: (msg: ShotMsg) => void): () => void {
  shotListeners.add(cb)
  return () => { shotListeners.delete(cb) }
}

const actListeners = new Set<(msg: ActMsg) => void>()
/** Central acted on a node through a tool: `t:'act'`. */
export function subscribeAct(cb: (msg: ActMsg) => void): () => void {
  actListeners.add(cb)
  return () => { actListeners.delete(cb) }
}

const netListeners = new Set<(msg: NetMsg) => void>()
/** The server's link to the Claude API changed state: `t:'net'`. */
export function subscribeNet(cb: (msg: NetMsg) => void): () => void {
  netListeners.add(cb)
  return () => { netListeners.delete(cb) }
}

/** Frames that go to every listener of a kind, not to one terminal subscriber. */
type BroadcastMsg = Extract<ServerMsg, { t: 'status' | 'fsdirty' | 'canvas' | 'view' | 'workspaces' | 'shot' | 'act' | 'net' }>

/** Deliver a broadcast frame to its listeners; false = not a broadcast (a per-terminal frame). */
export function dispatchBroadcast(msg: ServerMsg): msg is BroadcastMsg {
  if (msg.t === 'status') {
    if (msg.status === undefined) {
      // Sapuan basi: statusnya DICABUT, bukan diganti. Dan sengaja TIDAK lewat `noteStatus` —
      // sapuan bukan kabar, tidak ada yang terjadi untuk dibaca, jadi node ini tidak ditandai
      // belum-dibaca.
      statuses.delete(msg.id)
    } else {
      const prev = statuses.get(msg.id)
      statuses.set(msg.id, msg.status)
      // Aturan SET unread hidup DI SINI, bukan di komponen node: ini satu-satunya tempat yang
      // melihat status node mana pun, termasuk node workspace non-aktif yang tak ter-mount.
      // A connect snapshot is news only where it differs from what this tab already knew (reconnect).
      if (!msg.snapshot || (prev !== undefined && prev !== msg.status)) noteStatus(msg.id, msg.status)
    }
    const reason: StatusReason | undefined = msg.status && msg.reason ? { reason: msg.reason, ...(msg.detail ? { detail: msg.detail } : {}) } : undefined
    if (reason) reasons.set(msg.id, reason)
    else reasons.delete(msg.id)
    for (const l of statusListeners) l(msg.id, msg.status, reason)
    return true
  }
  // Petunjuk watcher file manager (flag WATCH): lewat bus, bukan sub terminal.
  if (msg.t === 'fsdirty') { emitFsEvent({ kind: 'dirty', path: msg.dir, origin: 'remote' }); return true }
  if (msg.t === 'canvas') { for (const l of [...canvasListeners]) l(msg); return true }
  if (msg.t === 'view') { for (const l of [...viewListeners]) l(msg); return true }
  if (msg.t === 'workspaces') { for (const l of [...workspacesListeners]) l(msg); return true }
  if (msg.t === 'act') { for (const l of [...actListeners]) l(msg); return true }
  if (msg.t === 'net') { for (const l of [...netListeners]) l(msg); return true }
  if (msg.t === 'shot') { for (const l of [...shotListeners]) l(msg); return true }
  return false
}

const reconnectListeners = new Set<() => void>()

/**
 * Daftarkan callback yang jalan setelah tiap RECONNECT (bukan koneksi pertama), sesudah replay
 * `open` dan antrean; untuk memulihkan state per-koneksi di server (mis. langganan fswatch).
 */
export function onReconnect(cb: () => void): () => void {
  reconnectListeners.add(cb)
  return () => { reconnectListeners.delete(cb) }
}

/** Run every `onReconnect` callback (ws.ts, after a reconnect's replay); one failing does not stop the rest. */
export function notifyReconnect(): void {
  for (const cb of [...reconnectListeners]) {
    try { cb() } catch (err) { console.warn('ws: onReconnect listener failed', err) }
  }
}
