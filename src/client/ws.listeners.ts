// Broadcast frames of the shared terminal socket (ws.ts) that are not tied to one terminal
// subscriber: agent status, fs dirty hints, canvas pushes, view/shot requests, workspace list.
import { emitFsEvent } from './fsEvents'
import type { CanvasMsg, ServerMsg, ShotMsg, ViewMsg, WorkspacesMsg } from '../shared/protocol'
import type { AgentStatus } from '../shared/workspace'
import { noteStatus } from './unread'

// Status is per-node but consumed by two readers: the node's own dot and the
// board overlay. Keep it on a separate channel so it survives independent of
// whether a terminal is currently mounted/subscribed.
// `undefined` ikut disiarkan: itu sapuan basi mencabut status (lihat `shared/agentStale.ts`), dan
// pembaca yang tidak mendengarnya akan menyimpan 'working' yang sudah dicabut selamanya.
const statuses = new Map<string, AgentStatus>()
const statusListeners = new Set<(id: string, status: AgentStatus | undefined) => void>()

/** Listen to every agent status change (including the stale sweep's `undefined`). */
export function subscribeStatus(cb: (id: string, status: AgentStatus | undefined) => void): () => void {
  statusListeners.add(cb)
  return () => { statusListeners.delete(cb) }
}
/** Last known agent status of node `id`. */
export function getStatus(id: string): AgentStatus | undefined { return statuses.get(id) }

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

/** Frames that go to every listener of a kind, not to one terminal subscriber. */
type BroadcastMsg = Extract<ServerMsg, { t: 'status' | 'fsdirty' | 'canvas' | 'view' | 'workspaces' | 'shot' }>

/** Deliver a broadcast frame to its listeners; false = not a broadcast (a per-terminal frame). */
export function dispatchBroadcast(msg: ServerMsg): msg is BroadcastMsg {
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
    return true
  }
  // Petunjuk watcher file manager (flag WATCH): lewat bus, bukan sub terminal.
  if (msg.t === 'fsdirty') { emitFsEvent({ kind: 'dirty', path: msg.dir, origin: 'remote' }); return true }
  if (msg.t === 'canvas') { for (const l of [...canvasListeners]) l(msg); return true }
  if (msg.t === 'view') { for (const l of [...viewListeners]) l(msg); return true }
  if (msg.t === 'workspaces') { for (const l of [...workspacesListeners]) l(msg); return true }
  if (msg.t === 'shot') { for (const l of [...shotListeners]) l(msg); return true }
  return false
}
