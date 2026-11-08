// Server-side writes onto a stored board: add nodes (placed in free space) and cables, then tell every
// open UI so it merges them live (`t:'canvas'`, client `workspaceCanvasPush.ts`) without a save conflict.
import type { Workspace } from '../../shared/workspace'
import type { ServerMsg } from '../../shared/protocol'
import { OPEN_GAP, placeBeside, type Rect } from '../../shared/canvasPlace'
import type { Db } from '../db'
import { resolveFsPath } from '../fsOps'

export type CanvasNode = Workspace['nodes'][number]
export type CanvasBridge = Workspace['bridges'][number]
export interface CanvasAddInput {
  workspaceId: string
  /** Place the new nodes beside this node (free space, no overlap); absent = free space near the board's existing nodes / viewport. */
  anchorNodeId?: string
  /** x/y of each node are ignored and computed by placement. */
  nodes: CanvasNode[]
  bridges?: CanvasBridge[]
}
export type CanvasAddResult =
  | { ok: true; updatedAt: number; nodes: CanvasNode[] }
  | { ok: false; code: 'workspace_not_found' | 'node_exists' }
export interface CanvasPush {
  add(input: CanvasAddInput): CanvasAddResult
  /** The stored board that contains `nodeId` (top-level node id), or null. */
  workspaceOfNode(nodeId: string): Workspace | null
  /** Best board for a directory: the one whose cwd equals `cwd` (or is its nearest ancestor), else the active board, else the most recently updated; null when there are none. */
  workspaceForCwd(cwd: string): Workspace | null
}

/** Same as the client's `toFlow` default: a stored node without a size renders at 400x300. */
const NODE_DEFAULT = { width: 400, height: 300 }
/** Other writers (UI saves) can win between our read and write; each retry re-reads the board. */
const SAVE_ATTEMPTS = 5

type CanvasDb = Pick<Db, 'get' | 'save' | 'list' | 'getActive' | 'nodeIds'>

const rectOf = (n: CanvasNode): Rect => ({ x: n.x, y: n.y, width: n.width ?? NODE_DEFAULT.width, height: n.height ?? NODE_DEFAULT.height })

/** `nodes` with final x/y: beside the anchor (or the newest node), else at the viewport's top-left corner. */
function place(ws: Workspace, nodes: CanvasNode[], anchorNodeId?: string): CanvasNode[] {
  const anchorNode = ws.nodes.find((n) => n.id === anchorNodeId) ?? ws.nodes[ws.nodes.length - 1]
  const anchor = anchorNode && rectOf(anchorNode)
  const occupied = ws.nodes.map(rectOf)
  const { x, y, zoom } = ws.viewport
  const placed: CanvasNode[] = []
  for (const n of nodes) {
    const size = { width: n.width ?? NODE_DEFAULT.width, height: n.height ?? NODE_DEFAULT.height }
    const center = { x: -x / zoom + OPEN_GAP + size.width / 2, y: -y / zoom + OPEN_GAP + size.height / 2 }
    const node = { ...n, ...placeBeside({ anchor, center, occupied, size }) }
    occupied.push(rectOf(node))
    placed.push(node)
  }
  return placed
}

export function createCanvasPush(deps: { db: CanvasDb; broadcast(msg: ServerMsg): void }): CanvasPush {
  const { db } = deps

  const add = (input: CanvasAddInput): CanvasAddResult => {
    const ids = input.nodes.map((n) => n.id)
    const taken = new Set(db.nodeIds())
    if (new Set(ids).size !== ids.length || ids.some((id) => taken.has(id))) return { ok: false, code: 'node_exists' }
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
      const ws = db.get(input.workspaceId)
      if (!ws) return { ok: false, code: 'workspace_not_found' }
      const nodes = place(ws, input.nodes, input.anchorNodeId)
      const bridgeIds = new Set(ws.bridges.map((b) => b.id))
      const bridges = (input.bridges ?? []).filter((b) => !bridgeIds.has(b.id))
      const outcome = db.save({ ...ws, nodes: [...ws.nodes, ...nodes], bridges: [...ws.bridges, ...bridges] }, ws.updatedAt)
      if (outcome === 'missing') return { ok: false, code: 'workspace_not_found' }
      if (outcome === 'stale') continue
      const updatedAt = db.get(ws.id)?.updatedAt ?? ws.updatedAt
      deps.broadcast({ t: 'canvas', workspaceId: ws.id, base: ws.updatedAt, updatedAt, nodes, bridges })
      return { ok: true, updatedAt, nodes }
    }
    throw new Error(`canvas add to workspace ${input.workspaceId} lost ${SAVE_ATTEMPTS} save races in a row`)
  }

  const workspaceOfNode = (nodeId: string): Workspace | null =>
    db.list().find((w) => w.nodes.some((n) => n.id === nodeId)) ?? null

  const workspaceForCwd = (cwd: string): Workspace | null => {
    const all = db.list() // newest first
    const dir = resolveFsPath(cwd)
    let best: { ws: Workspace; len: number } | null = null
    for (const ws of all) {
      if (!ws.cwd) continue
      const root = resolveFsPath(ws.cwd)
      const inside = dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`)
      if (inside && (!best || root.length > best.len)) best = { ws, len: root.length }
    }
    if (best) return best.ws
    const active = db.getActive()
    return all.find((w) => w.id === active) ?? all[0] ?? null
  }

  return { add, workspaceOfNode, workspaceForCwd }
}
