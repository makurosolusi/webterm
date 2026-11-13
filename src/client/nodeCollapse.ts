// Collapse to the header for nodes that adopted NodeChrome late (editor, diff, plan, MCP app): the same
// behaviour as Terminal/Files (height shrinks to the header, the previous height comes back on expand).
import { useRef } from 'react'
import { useReactFlow } from '@xyflow/react'

/** Height of a collapsed node: its header. */
export const COLLAPSED_H = 40
const FALLBACK_H = 300

/** Toggle for node `id`'s collapse, stored as `data.collapsed`. */
export function useNodeCollapse(id: string, height: number | undefined, collapsed: boolean): () => void {
  const rf = useReactFlow()
  // ponytail: the expanded height lives in memory, so a reload while collapsed expands to FALLBACK_H (same as TerminalNode).
  const expandedH = useRef(height ?? FALLBACK_H)
  return () => {
    if (!collapsed) { expandedH.current = height ?? FALLBACK_H; rf.updateNode(id, { height: COLLAPSED_H }) }
    else rf.updateNode(id, { height: expandedH.current })
    rf.updateNodeData(id, { collapsed: !collapsed })
  }
}
