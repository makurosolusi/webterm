// Pure serializers between React Flow nodes and persisted WsNodes.
// The DB (via api.ts) is the source of truth; these functions carry no DOM/IO.
import type { Node, Edge } from '@xyflow/react'
import { validDiffNotes, validPlanData, type AgentStatus, type WsNode, type BridgeLink } from '../shared/workspace'

export function toFlow(n: WsNode): Node {
  return {
    id: n.id,
    type: n.kind,
    position: { x: n.x, y: n.y },
    width: n.width ?? 400,
    height: n.height ?? 300,
    data: { id: n.id, kind: n.kind, cmd: n.cmd, cwd: n.cwd, agentId: n.agentId, color: n.color, title: n.title, sessionId: n.sessionId, claudeProfileId: n.claudeProfileId, collapsed: n.collapsed, hideLinks: n.hideLinks, comments: n.comments, dirPath: n.dirPath, filePath: n.filePath, viewOpts: n.viewOpts, panes: n.panes, url: n.url, agentControl: n.agentControl, device: n.device, diffNotes: n.diffNotes, plan: n.plan },
  }
}

export function toWsNode(n: Node): WsNode {
  const d = n.data as Partial<WsNode>
  return {
    id: n.id,
    kind: (n.type as WsNode['kind']) ?? 'terminal',
    x: n.position.x,
    y: n.position.y,
    width: typeof n.width === 'number' ? n.width : undefined,
    height: typeof n.height === 'number' ? n.height : undefined,
    cmd: d.cmd,
    cwd: d.cwd,
    agentId: d.agentId,
    color: d.color,
    title: d.title,
    sessionId: d.sessionId,
    claudeProfileId: d.claudeProfileId,
    collapsed: d.collapsed,
    hideLinks: d.hideLinks,
    comments: d.comments,
    dirPath: d.dirPath,
    filePath: d.filePath,
    viewOpts: d.viewOpts,
    panes: d.panes,
    url: d.url,
    agentControl: d.agentControl,
    device: d.device,
    // Validated on the way out: node data is written by the Diff node and must not persist junk.
    diffNotes: d.diffNotes === undefined ? undefined : validDiffNotes(d.diffNotes),
    plan: d.plan === undefined ? undefined : validPlanData(d.plan),
  }
}

// Pure serializers between a React Flow Edge and a persisted BridgeLink.
export function toFlowEdge(b: BridgeLink): Edge {
  return { id: b.id, source: b.source, target: b.target, type: 'context', data: { kind: b.kind } }
}

export function toBridge(e: Edge): BridgeLink {
  // Kind ikut edge-nya: meng-hardcode 'context' membuat kabel buka-file berubah jenis (dan salah
  // label) begitu workspace dimuat ulang. Edge dari sebelum `kind` ada tidak punya data → 'context'.
  const kind = (e.data as { kind?: BridgeLink['kind'] } | undefined)?.kind
  return { id: e.id, source: e.source, target: e.target, kind: kind === 'file' ? 'file' : 'context' }
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
