// Nodes/cables the server added to a stored board (`t:'canvas'`, server `canvas/canvasPush.ts`).
// The mounted board merges them into the live canvas without touching selection or focus. They are
// already stored, so nothing is saved here; the save queue (`absorb`) keeps unsent saves from
// dropping them or 409ing on the push's version.
import { useEffect } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { Edge, Node } from '@xyflow/react'
import type { CanvasMsg } from '../shared/protocol'
import type { Workspace } from '../shared/workspace'
import { toFlow, toFlowEdge } from './store'
import { subscribeCanvas } from './ws'

export interface LiveBoard {
  activeWsRef: RefObject<Workspace | null>
  nodesRef: RefObject<Node[]>
  edgesRef: RefObject<Edge[]>
  setNodes: Dispatch<SetStateAction<Node[]>>
  setEdges: Dispatch<SetStateAction<Edge[]>>
}

/** Merge a push into the mounted board; false (nothing touched) when it is for another board. */
export function applyCanvasPush(live: LiveBoard, msg: CanvasMsg): boolean {
  if (live.activeWsRef.current?.id !== msg.workspaceId) return false
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

/** Live-merge pushes into the mounted board for as long as the caller is mounted. */
export function useCanvasPush(live: LiveBoard): void {
  const { activeWsRef, nodesRef, edgesRef, setNodes, setEdges } = live
  useEffect(
    () => subscribeCanvas((msg) => { applyCanvasPush({ activeWsRef, nodesRef, edgesRef, setNodes, setEdges }, msg) }),
    [activeWsRef, nodesRef, edgesRef, setNodes, setEdges],
  )
}
