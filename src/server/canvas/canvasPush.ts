// Server-side writes onto a stored board: add nodes (placed in free space) and cables, remove nodes
// (ending their sessions), or patch existing nodes' layout/look and add/remove cables, then tell every open UI so it applies that live (`t:'canvas'`, client
// `workspaceCanvasPush.ts`) without a save conflict.
import { randomUUID } from 'node:crypto'
import type { PersistedTabs } from '../../shared/browser.tabs'
import type { Workspace } from '../../shared/workspace'
import { CANVAS_PATCH_KEYS, type ServerMsg } from '../../shared/protocol'
import { OPEN_GAP, placeBeside, type Rect } from '../../shared/canvasPlace'
import { withNodeNames } from '../../shared/nodeNames'
import { normalizeTabLayout, reconcileTabs, sameGroups, type TabGroup } from '../../shared/tabLayout.schema'
import { applyGroupOp, type GroupOp, type GroupOpCode } from './canvasPush.layout'
import type { Db } from '../db'
import { resolveFsPath } from '../fsOps'
import { createLogger } from '../logs'

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
export type CanvasRemoveResult =
  | { ok: true; workspace: Workspace; removed: CanvasNode[] }
  | { ok: false; code: 'workspace_not_found' | 'node_not_found' }
/** Fields of an existing node a push may change; `null` clears title/color/chatSessionId/agentId/sessionId/cmd. Any other key is ignored.
 *  The agent chat fields are written by the node's server session (agentChat.runtime.ts), and kind/agentId/sessionId/cmd
 *  by the Claude view switch (agentChat.view.ts), never by Central's canvas.edit (its ops set only layout/look fields). */
export type NodePatch = { id: string } & Partial<Pick<CanvasNode, 'x' | 'y' | 'width' | 'height' | 'collapsed' | 'hideLinks' | 'chatConfig' | 'permissionMode' | 'kind'>> & {
  tabs?: PersistedTabs | null
  title?: string | null
  color?: string | null
  chatSessionId?: string | null
  agentId?: CanvasNode['agentId'] | null
  sessionId?: string | null
  cmd?: string | null
}
export interface CanvasUpdateInput {
  workspaceId: string
  patches: NodePatch[]
  /** Cables to add; an id already on the board is skipped. Both ends must be nodes of this board. */
  bridgesAdd?: CanvasBridge[]
  /** Cable ids to remove; each must be on the board. */
  bridgesRemove?: string[]
}
export type CanvasUpdateResult =
  | { ok: true; updatedAt: number; nodes: CanvasNode[]; bridges: CanvasBridge[]; unlinked: string[] }
  | { ok: false; code: 'workspace_not_found' | 'node_not_found' | 'bridge_invalid' | 'bridge_not_found' }
export type CanvasGroupsResult =
  | { ok: true; updatedAt: number; groups: TabGroup[]; groupId?: string }
  | { ok: false; code: 'workspace_not_found' | GroupOpCode }
export interface CanvasPush {
  add(input: CanvasAddInput): CanvasAddResult
  /** Remove nodes (all-or-nothing) and every bridge touching them, end their sessions/pages, broadcast. */
  remove(input: { workspaceId: string; nodeIds: string[] }): CanvasRemoveResult
  /** Patch existing nodes and add/remove cables (all-or-nothing), broadcast `updated`/`bridges`/`unlinked`. */
  update(input: CanvasUpdateInput): CanvasUpdateResult
  /** One Layers group edit on the board's tab layout (the human's rules, `canvasPush.layout.ts`), broadcast `groups`. */
  groups(input: { workspaceId: string; op: GroupOp }): CanvasGroupsResult
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
const log = createLogger('canvas.push')

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

/** `node` with the patch's known keys applied: `undefined` leaves a field, `null` deletes it. */
function applyPatch(node: CanvasNode, patch: NodePatch): CanvasNode {
  const next: Record<string, unknown> = { ...node }
  for (const key of CANVAS_PATCH_KEYS) {
    const value = patch[key]
    if (value === null) delete next[key]
    else if (value !== undefined) next[key] = value
  }
  return next as unknown as CanvasNode
}

export interface CanvasPushDeps {
  db: CanvasDb
  broadcast(msg: ServerMsg): void
  /** Ends what removed nodes still run (PTY sessions, browser pages); called only after the save. */
  teardown?(nodes: CanvasNode[]): void
}

export function createCanvasPush(deps: CanvasPushDeps): CanvasPush {
  const { db } = deps

  const add = (input: CanvasAddInput): CanvasAddResult => {
    const ids = input.nodes.map((n) => n.id)
    const taken = new Set(db.nodeIds())
    if (new Set(ids).size !== ids.length || ids.some((id) => taken.has(id))) return { ok: false, code: 'node_exists' }
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
      const ws = db.get(input.workspaceId)
      if (!ws) return { ok: false, code: 'workspace_not_found' }
      // Named here, not only in Db.save, so the live push carries the same names the row stores.
      const all = withNodeNames([...ws.nodes, ...place(ws, input.nodes, input.anchorNodeId)])
      const nodes = all.slice(ws.nodes.length)
      const bridgeIds = new Set(ws.bridges.map((b) => b.id))
      const bridges = (input.bridges ?? []).filter((b) => !bridgeIds.has(b.id))
      const outcome = db.save({ ...ws, nodes: all, bridges: [...ws.bridges, ...bridges] }, ws.updatedAt)
      if (outcome === 'missing') return { ok: false, code: 'workspace_not_found' }
      if (outcome === 'stale') continue
      const updatedAt = db.get(ws.id)?.updatedAt ?? ws.updatedAt
      deps.broadcast({ t: 'canvas', workspaceId: ws.id, base: ws.updatedAt, updatedAt, nodes, bridges })
      return { ok: true, updatedAt, nodes }
    }
    throw new Error(`canvas add to workspace ${input.workspaceId} lost ${SAVE_ATTEMPTS} save races in a row`)
  }

  const remove = (input: { workspaceId: string; nodeIds: string[] }): CanvasRemoveResult => {
    const ids = [...new Set(input.nodeIds)]
    const doomed = new Set(ids)
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
      const ws = db.get(input.workspaceId)
      if (!ws) return { ok: false, code: 'workspace_not_found' }
      const removed = ws.nodes.filter((n) => doomed.has(n.id))
      if (removed.length !== ids.length) return { ok: false, code: 'node_not_found' }
      if (!removed.length) return { ok: true, workspace: ws, removed }
      const next = {
        ...ws,
        nodes: ws.nodes.filter((n) => !doomed.has(n.id)),
        bridges: ws.bridges.filter((b) => !doomed.has(b.source) && !doomed.has(b.target)),
      }
      const outcome = db.save(next, ws.updatedAt)
      if (outcome === 'missing') return { ok: false, code: 'workspace_not_found' }
      if (outcome === 'stale') continue
      const workspace = db.get(ws.id) ?? next
      deps.broadcast({ t: 'canvas', workspaceId: ws.id, base: ws.updatedAt, updatedAt: workspace.updatedAt, nodes: [], bridges: [], removed: ids })
      try {
        deps.teardown?.(removed)
      } catch (err) {
        // The nodes are already off the board; a session that did not end is logged, never restored.
        log.error('canvas.remove.teardown', 'Ending sessions of removed nodes failed', { ids: { workspaceId: ws.id }, nodeIds: ids, cause: err instanceof Error ? err.message : String(err) })
      }
      return { ok: true, workspace, removed }
    }
    throw new Error(`canvas remove from workspace ${input.workspaceId} lost ${SAVE_ATTEMPTS} save races in a row`)
  }

  const update = (input: CanvasUpdateInput): CanvasUpdateResult => {
    const dropIds = [...new Set(input.bridgesRemove ?? [])]
    const drop = new Set(dropIds)
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
      const ws = db.get(input.workspaceId)
      if (!ws) return { ok: false, code: 'workspace_not_found' }
      const byId = new Map(ws.nodes.map((n) => [n.id, n]))
      const patched = new Map<string, CanvasNode>()
      for (const p of input.patches) {
        const cur = patched.get(p.id) ?? byId.get(p.id)
        if (!cur) return { ok: false, code: 'node_not_found' }
        patched.set(p.id, applyPatch(cur, p))
      }
      const bridgeIds = new Set(ws.bridges.map((b) => b.id))
      if (dropIds.some((id) => !bridgeIds.has(id))) return { ok: false, code: 'bridge_not_found' }
      const bridges: CanvasBridge[] = []
      for (const b of input.bridgesAdd ?? []) {
        if (!byId.has(b.source) || !byId.has(b.target) || b.source === b.target) return { ok: false, code: 'bridge_invalid' }
        if (!bridgeIds.has(b.id) && !bridges.some((x) => x.id === b.id)) bridges.push(b)
      }
      const nodes = [...patched.values()]
      if (!nodes.length && !bridges.length && !dropIds.length) return { ok: true, updatedAt: ws.updatedAt, nodes, bridges, unlinked: [] }
      const next = {
        ...ws,
        nodes: ws.nodes.map((n) => patched.get(n.id) ?? n),
        bridges: [...ws.bridges.filter((b) => !drop.has(b.id)), ...bridges],
      }
      const outcome = db.save(next, ws.updatedAt)
      if (outcome === 'missing') return { ok: false, code: 'workspace_not_found' }
      if (outcome === 'stale') continue
      const updatedAt = db.get(ws.id)?.updatedAt ?? ws.updatedAt
      deps.broadcast({ t: 'canvas', workspaceId: ws.id, base: ws.updatedAt, updatedAt, nodes: [], bridges, updated: nodes, unlinked: dropIds })
      return { ok: true, updatedAt, nodes, bridges, unlinked: dropIds }
    }
    throw new Error(`canvas update of workspace ${input.workspaceId} lost ${SAVE_ATTEMPTS} save races in a row`)
  }

  const groups = (input: { workspaceId: string; op: GroupOp }): CanvasGroupsResult => {
    const newId = `g-${randomUUID()}` // the store's group id shape
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
      const ws = db.get(input.workspaceId)
      if (!ws) return { ok: false, code: 'workspace_not_found' }
      // The stored order may predate nodes no window reconciled yet (one Central just opened): reconcile as the UI would.
      const layout = reconcileTabs(normalizeTabLayout(ws.layout), ws.nodes)
      const res = applyGroupOp(layout.tabs, input.op, newId)
      if (!res.ok) return res
      const groupId = res.groupId ? { groupId: res.groupId } : {}
      if (sameGroups(res.tabs.groups, ws.layout?.tabs.groups ?? [])) return { ok: true, updatedAt: ws.updatedAt, groups: res.tabs.groups, ...groupId }
      const outcome = db.save({ ...ws, layout: { ...layout, tabs: { ...layout.tabs, ...res.tabs } } }, ws.updatedAt)
      if (outcome === 'missing') return { ok: false, code: 'workspace_not_found' }
      if (outcome === 'stale') continue
      const updatedAt = db.get(ws.id)?.updatedAt ?? ws.updatedAt
      deps.broadcast({ t: 'canvas', workspaceId: ws.id, base: ws.updatedAt, updatedAt, nodes: [], bridges: [], groups: res.tabs.groups })
      return { ok: true, updatedAt, groups: res.tabs.groups, ...groupId }
    }
    throw new Error(`canvas groups of workspace ${input.workspaceId} lost ${SAVE_ATTEMPTS} save races in a row`)
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

  return { add, remove, update, groups, workspaceOfNode, workspaceForCwd }
}
