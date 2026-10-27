// Pure serializers between React Flow nodes and persisted WsNodes.
// The DB (via api.ts) is the source of truth; these functions carry no DOM/IO.
import type { Node } from '@xyflow/react'
import type { AgentStatus, WsNode } from '../shared/workspace'

export function toFlow(n: WsNode): Node {
  return {
    id: n.id,
    type: n.kind,
    position: { x: n.x, y: n.y },
    data: { id: n.id, kind: n.kind, cmd: n.cmd, cwd: n.cwd, agentId: n.agentId, color: n.color, title: n.title, sessionId: n.sessionId },
  }
}

export function toWsNode(n: Node): WsNode {
  const d = n.data as Partial<WsNode>
  return {
    id: n.id,
    kind: (n.type as WsNode['kind']) ?? 'terminal',
    x: n.position.x,
    y: n.position.y,
    cmd: d.cmd,
    cwd: d.cwd,
    agentId: d.agentId,
    color: d.color,
    title: d.title,
    sessionId: d.sessionId,
  }
}

export const KANBAN_COLUMNS: AgentStatus[] = ['working', 'waiting', 'blocked', 'done']

// Group agent nodes by their live status. Nodes without a status are omitted.
export function groupByStatus(
  nodes: { id: string; data: { kind?: string; agentId?: string; title?: string } }[],
  statuses: Record<string, AgentStatus>,
): Record<AgentStatus, { id: string; label: string }[]> {
  const out: Record<AgentStatus, { id: string; label: string }[]> =
    { working: [], waiting: [], blocked: [], done: [] }
  for (const n of nodes) {
    if (n.data?.kind !== 'agent' && n.data?.agentId == null) continue
    const s = statuses[n.id]
    if (!s) continue
    out[s].push({ id: n.id, label: n.data.title ?? n.data.agentId ?? n.id.slice(0, 8) })
  }
  return out
}

export function addNode(nodes: WsNode[], n: WsNode): WsNode[] {
  return [...nodes, n]
}

export function removeNode(nodes: WsNode[], id: string): WsNode[] {
  return nodes.filter((n) => n.id !== id)
}

// Default workspace name from a folder path: last non-empty segment, fallback 'project'.
export function workspaceNameFromPath(path: string): string {
  const seg = path.split('/').filter(Boolean).pop()
  return seg || 'project'
}
