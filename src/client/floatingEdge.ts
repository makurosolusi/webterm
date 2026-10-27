// Pure geometry + edge helpers for floating context-link edges. No React/DOM.
// Position is an enum (value) from @xyflow/react — carries no DOM, safe here.
import { Position } from '@xyflow/react'
import { classifyLink } from '../shared/workspace'
import type { AgentId } from '../shared/workspace'

export interface Rect { x: number; y: number; width: number; height: number }

interface InternalNodeLike {
  internals?: { positionAbsolute?: { x: number; y: number } }
  measured?: { width?: number; height?: number }
}

// Reads absolute position + measured size off a React Flow internal node.
// Returns null when unmeasured or zero-sized so the edge draws nothing that frame.
export function rectOf(n: InternalNodeLike | null | undefined): Rect | null {
  const pos = n?.internals?.positionAbsolute
  const w = n?.measured?.width
  const h = n?.measured?.height
  if (!pos || !w || !h) return null
  return { x: pos.x, y: pos.y, width: w, height: h }
}

// Horizontal exit: midpoint of the side facing `toward`.
export function borderExit(from: Rect, toward: Rect): { x: number; y: number; position: Position } {
  const dx = (toward.x + toward.width / 2) - (from.x + from.width / 2)
  const right = dx >= 0
  return {
    x: from.x + (right ? from.width : 0),
    y: from.y + from.height / 2,
    position: right ? Position.Right : Position.Left,
  }
}

export function floatingEdgeParams(a: Rect, b: Rect): {
  sx: number; sy: number; sourcePosition: Position
  tx: number; ty: number; targetPosition: Position
} {
  const s = borderExit(a, b)
  const t = borderExit(b, a)
  return { sx: s.x, sy: s.y, sourcePosition: s.position, tx: t.x, ty: t.y, targetPosition: t.position }
}

// A link may form only between two distinct context-capable nodes.
export function canLink(sourceAgentId: AgentId | undefined, targetAgentId: AgentId | undefined, source: string, target: string): boolean {
  return source !== target && classifyLink(sourceAgentId, targetAgentId) === 'context'
}

// Dedupe: a bridge already connects the pair in either direction.
export function bridgeExists(bridges: { source: string; target: string }[], source: string, target: string): boolean {
  return bridges.some((b) => (b.source === source && b.target === target) || (b.source === target && b.target === source))
}

export function hiddenEdgeNodeIds(nodes: { id: string; data: { hideLinks?: boolean } }[]): Set<string> {
  return new Set(nodes.filter((n) => n.data.hideLinks === true).map((n) => n.id))
}

export function edgeVisible(e: { source: string; target: string }, hidden: Set<string>): boolean {
  return !hidden.has(e.source) && !hidden.has(e.target)
}
