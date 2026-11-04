// Canvas Undo = layout undo (`./layoutHistory`) plus "Recently closed" (`./closedHistory`), so
// closing a node is forgivable with its cables, and still after a reload (F3-d, acceptance A6).
//
// - Layout stack has a step: undo it, then put back the cables of any node that came back (the
//   layout stack holds nodes only; React Flow dropped the edges when the node was deleted).
// - Layout stack is empty (fresh load, or everything undone): reopen the most recently closed node
//   of the ACTIVE workspace from the persisted closed history, cables included.
import { useCallback } from 'react'
import type { RefObject } from 'react'
import type { Node } from '@xyflow/react'
import type { ClosedEntry, ClosedHistory, ReopenDeps } from './closedHistory'
import type { BridgeLink } from '../shared/workspace'

export interface CanvasUndoDeps {
  nodesRef: RefObject<Node[]>
  layout: { onUndo: () => void; canUndo: boolean }
  /** Visible closed entries, newest first (`useClosedHistory().entries`). */
  closed: readonly ClosedEntry[]
  bridgesOf: ClosedHistory['bridgesOf']
  reopen: ClosedHistory['reopen']
  reopenDeps: ReopenDeps
  restoreBridges: (bridges: readonly BridgeLink[]) => void
}

export function useCanvasUndo(d: CanvasUndoDeps): { onUndo: () => void; canUndo: boolean } {
  const { nodesRef, layout, closed, bridgesOf, reopen, reopenDeps, restoreBridges } = d
  const latest = closed.find((e) => e.workspaceId === reopenDeps.activeId)

  const onUndo = useCallback(() => {
    if (!layout.canUndo) {
      if (latest) void reopen(latest.node.id, reopenDeps)
      return
    }
    const before = new Set(nodesRef.current.map((n) => n.id))
    layout.onUndo() // writes nodesRef synchronously
    const back = nodesRef.current.filter((n) => !before.has(n.id)).map((n) => n.id)
    if (back.length) restoreBridges(bridgesOf(back))
  }, [layout, latest, reopen, reopenDeps, nodesRef, bridgesOf, restoreBridges])

  return { onUndo, canUndo: layout.canUndo || !!latest }
}
