// Pure serializers between React Flow nodes and persisted WsNodes.
// The DB (via api.ts) is the source of truth; these functions carry no DOM/IO.
import type { Node } from '@xyflow/react'
import type { WsNode } from '../shared/workspace'

export function toFlow(n: WsNode): Node {
  return {
    id: n.id,
    type: n.kind,
    position: { x: n.x, y: n.y },
    data: { id: n.id, kind: n.kind, cmd: n.cmd, cwd: n.cwd, agentId: n.agentId, color: n.color, title: n.title },
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
  }
}

export function addNode(nodes: WsNode[], n: WsNode): WsNode[] {
  return [...nodes, n]
}

export function removeNode(nodes: WsNode[], id: string): WsNode[] {
  return nodes.filter((n) => n.id !== id)
}
