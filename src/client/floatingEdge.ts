// Pure geometry + edge helpers for floating context-link edges. No React/DOM.
// Position is an enum (value) from @xyflow/react — carries no DOM, safe here.
import { Position } from '@xyflow/react'
import { classifyLink } from '../shared/workspace'
import type { AgentId } from '../shared/workspace'
import { BROWSER_KIND } from '../shared/browser.contract'
import { canSkillLink, skillConnection } from '../shared/skillPorts'

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

/** React Flow type of the Diff node (DiffNode.tsx). */
export const DIFF_KIND = 'diff'
/** React Flow type of the Plan node (PlanNode.tsx). */
export const PLAN_KIND = 'plan'

/** Ujung kabel: jenis node (`kind` React Flow) + agentId-nya bila node agent. */
export interface LinkEnd { id: string; kind?: string; agentId?: AgentId }

/** Kabel boleh terbentuk antara dua node berbeda yang context-capable, ATAU antara node browser dan
 *  node agent (semua sesi agent memegang token node yang dipakai `resolveLinkedBrowser` server).
 *  Browser↔browser dan browser↔terminal biasa ditolak: tak ada pihak yang bisa memakai kabelnya —
 *  pola `classifyLink` (sticky hanya bertaut ke terminal, sticky↔sticky null). */
export function canLink(a: LinkEnd, b: LinkEnd): boolean {
  if (a.id === b.id) return false
  // Skill node: only into a Claude agent's `skills-in` (shared rule, same as the server's canLink).
  const skill = canSkillLink(a, b)
  if (skill !== undefined) return skill
  // Plan node (F4-f): its cables are DAG edges to the workers it dispatched (a Diff node on the worker's
  // worktree) or to an agent node; plan↔plan and plan↔plain node carry nothing.
  const plans = (a.kind === PLAN_KIND ? 1 : 0) + (b.kind === PLAN_KIND ? 1 : 0)
  if (plans === 2) return false
  if (plans === 1) { const other = a.kind === PLAN_KIND ? b : a; return !!other.agentId || other.kind === DIFF_KIND }
  // Diff node: same rule as browser. Its only user is the wired agent (root + notes target).
  const diffs = (a.kind === DIFF_KIND ? 1 : 0) + (b.kind === DIFF_KIND ? 1 : 0)
  if (diffs === 2) return false
  if (diffs === 1) return !!(a.kind === DIFF_KIND ? b : a).agentId
  const browsers = (a.kind === BROWSER_KIND ? 1 : 0) + (b.kind === BROWSER_KIND ? 1 : 0)
  if (browsers === 0) return classifyLink(a.agentId, b.agentId) === 'context'
  if (browsers === 2) return false
  return !!(a.kind === BROWSER_KIND ? b : a).agentId
}

/** A drawn connection's two nodes and handles; the shape React Flow hands to `isValidConnection` / `onConnect`. */
export interface DrawnConnection { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }

/**
 * `isValidConnection` of the canvas: a connection touching a typed skill port is valid only as `skill-out` of a
 * skill node into `skills-in` of a Claude agent / agent chat (shared `skillConnection`); every other connection is left
 * to `onConnect`'s `canLink`, as before.
 */
export function isValidConnection(nodes: ReadonlyArray<{ id: string; type?: string; data?: unknown }>, c: DrawnConnection): boolean {
  const end = (id: string): LinkEnd => {
    const n = nodes.find((x) => x.id === id)
    return { id, kind: n?.type, agentId: (n?.data as { agentId?: AgentId } | undefined)?.agentId }
  }
  return skillConnection(end(c.source), c.sourceHandle, end(c.target), c.targetHandle) ?? true
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
