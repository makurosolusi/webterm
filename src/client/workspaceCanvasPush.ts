// Nodes/cables the server added to, nodes it removed from, nodes it patched (position, size, look)
// or cables it unlinked, or its Layers groups, on a stored board (`t:'canvas'`, server `canvas/canvasPush.ts`). The mounted
// board applies them to the live canvas without touching selection, focus or drag state. They are already stored, so nothing is saved here; the save queue (`absorb`)
// keeps unsent saves from dropping added nodes, resurrecting removed ones or 409ing on the push's
// version. A removed node's sessions were already ended by the server, so no `close` is sent: the
// node leaves the canvas directly (not through `onNodesChange`), and only lands in Reopen history.
import { useEffect } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { Edge, Node } from '@xyflow/react'
import type { CanvasMsg } from '../shared/protocol'
import type { Workspace, WsNode } from '../shared/workspace'
import type { ClosedHistory } from './closedHistory'
import { toBridge, toFlow, toFlowEdge, toWsNode } from './store'
import { subscribeCanvas } from './ws'
import { receiveGroups } from './tabLayout.store'

export interface LiveBoard {
  activeWsRef: RefObject<Workspace | null>
  nodesRef: RefObject<Node[]>
  edgesRef: RefObject<Edge[]>
  setNodes: Dispatch<SetStateAction<Node[]>>
  setEdges: Dispatch<SetStateAction<Edge[]>>
  /** Closed-session history: a node the server removed can be reopened like one the user closed. */
  recordClosed: ClosedHistory['record']
}

/** Drop the removed nodes and every cable touching them, recording them for Reopen. */
function applyRemoved(live: LiveBoard, removed: readonly string[]): void {
  const gone = new Set(removed.filter((id) => live.nodesRef.current.some((n) => n.id === id)))
  if (!gone.size) return
  const touches = (e: Edge): boolean => gone.has(e.source) || gone.has(e.target)
  // Snapshot BEFORE the removal, as the human close does (`App.board.ts`): the entry carries the cables.
  live.recordClosed([...gone], live.nodesRef.current.map(toWsNode), live.activeWsRef.current, live.edgesRef.current.map(toBridge))
  live.nodesRef.current = live.nodesRef.current.filter((n) => !gone.has(n.id))
  live.edgesRef.current = live.edgesRef.current.filter((e) => !touches(e))
  live.setNodes((prev) => prev.filter((n) => !gone.has(n.id)))
  live.setEdges((prev) => prev.filter((e) => !touches(e)))
}

/** `n` with the pushed node's position, size, title/color/collapsed/hideLinks and agent chat
 *  session id / config / mode, as `toFlow` maps them; every live-only prop (selected, dragging,
 *  measured, ...) and the rest of `data` kept. */
function patchFlow(n: Node, pushed: WsNode): Node {
  const f = toFlow(pushed)
  const { title, color, collapsed, hideLinks, chatSessionId, chatConfig, permissionMode } = f.data as Partial<WsNode>
  return { ...n, position: f.position, width: f.width, height: f.height, data: { ...n.data, title, color, collapsed, hideLinks, chatSessionId, chatConfig, permissionMode } }
}

/** Patch the updated nodes in place and drop the unlinked cables. */
function applyUpdated(live: LiveBoard, updated: readonly WsNode[], unlinked: readonly string[]): void {
  const byId = new Map(updated.map((n) => [n.id, n]))
  const patch = (nodes: Node[]): Node[] => nodes.map((n) => { const p = byId.get(n.id); return p ? patchFlow(n, p) : n })
  if (byId.size && live.nodesRef.current.some((n) => byId.has(n.id))) {
    live.nodesRef.current = patch(live.nodesRef.current)
    live.setNodes(patch)
  }
  const cut = new Set(unlinked)
  if (cut.size && live.edgesRef.current.some((e) => cut.has(e.id))) {
    live.edgesRef.current = live.edgesRef.current.filter((e) => !cut.has(e.id))
    live.setEdges((prev) => prev.filter((e) => !cut.has(e.id)))
  }
}

/** Apply a push to the mounted board; false (nothing touched) when it is for another board. */
export function applyCanvasPush(live: LiveBoard, msg: CanvasMsg): boolean {
  if (live.activeWsRef.current?.id !== msg.workspaceId) return false
  if (msg.removed?.length) applyRemoved(live, msg.removed)
  applyUpdated(live, msg.updated ?? [], msg.unlinked ?? [])
  if (msg.groups) {
    // The store shows them; the active payload carries them, so the next save does not revert them.
    const layout = receiveGroups(msg.groups)
    const cur = live.activeWsRef.current
    if (cur) live.activeWsRef.current = { ...cur, layout }
  }
  const nodeIds = new Set(live.nodesRef.current.map((n) => n.id))
  const edgeIds = new Set(live.edgesRef.current.map((e) => e.id))
  const nodes = msg.nodes.filter((n) => !nodeIds.has(n.id)).map(toFlow)
  const edges = msg.bridges.filter((b) => !edgeIds.has(b.id)).map(toFlowEdge)
  if (nodes.length) {
    live.nodesRef.current = [...live.nodesRef.current, ...nodes]
    live.setNodes((prev) => [...prev, ...nodes.filter((n) => !prev.some((p) => p.id === n.id))])
  }
  if (edges.length) {
    live.edgesRef.current = [...live.edgesRef.current, ...edges]
    live.setEdges((prev) => [...prev, ...edges.filter((e) => !prev.some((p) => p.id === e.id))])
  }
  return true
}

/** Live-apply pushes to the mounted board for as long as the caller is mounted. */
export function useCanvasPush(live: LiveBoard): void {
  const { activeWsRef, nodesRef, edgesRef, setNodes, setEdges, recordClosed } = live
  useEffect(
    () => subscribeCanvas((msg) => { applyCanvasPush({ activeWsRef, nodesRef, edgesRef, setNodes, setEdges, recordClosed }, msg) }),
    [activeWsRef, nodesRef, edgesRef, setNodes, setEdges, recordClosed],
  )
}
