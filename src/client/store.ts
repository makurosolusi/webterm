// Pure serializers between React Flow nodes and persisted WsNodes.
// The DB (via api.ts) is the source of truth; these functions carry no DOM/IO.
import type { Node, Edge } from '@xyflow/react'
import { isAgentChatPreset, validChatConfig } from '../shared/agentChat.shape'
import { ZOOM_MAX, ZOOM_MIN } from './browser.zoom'
import { SKILLS_IN, SKILL_NODE_SIZE, SKILL_OUT } from '../shared/skillPorts'
import { isPermissionMode, validDiffNotes, validPlanData, type AgentStatus, type WsNode, type BridgeLink } from '../shared/workspace'

export function toFlow(n: WsNode): Node {
  return {
    id: n.id,
    type: n.kind,
    position: { x: n.x, y: n.y },
    width: n.width ?? (n.kind === 'skill' ? SKILL_NODE_SIZE.width : 400),
    height: n.height ?? (n.kind === 'skill' ? SKILL_NODE_SIZE.height : 300),
    data: { id: n.id, kind: n.kind, cmd: n.cmd, cwd: n.cwd, agentId: n.agentId, color: n.color, name: n.name, title: n.title, sessionId: n.sessionId, claudeProfileId: n.claudeProfileId, collapsed: n.collapsed, hideLinks: n.hideLinks, comments: n.comments, dirPath: n.dirPath, filePath: n.filePath, wordWrap: n.wordWrap, viewAs: n.viewAs, viewOpts: n.viewOpts, expanded: n.expanded, panes: n.panes, url: n.url, agentControl: n.agentControl, device: n.device, zoom: n.zoom, diffNotes: n.diffNotes, plan: n.plan, chatSessionId: n.chatSessionId, permissionMode: n.permissionMode, chatConfig: n.chatConfig, preset: isAgentChatPreset(n.preset) ? n.preset : undefined, presetTarget: typeof n.presetTarget === 'string' ? n.presetTarget : undefined, skill: n.skill, seenVersion: n.seenVersion },
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
    name: d.name,
    title: d.title,
    sessionId: d.sessionId,
    claudeProfileId: d.claudeProfileId,
    collapsed: d.collapsed,
    hideLinks: d.hideLinks,
    comments: d.comments,
    dirPath: d.dirPath,
    filePath: d.filePath,
    wordWrap: typeof d.wordWrap === 'boolean' ? d.wordWrap : undefined,
    viewAs: d.viewAs === 'text' ? 'text' : undefined,
    viewOpts: d.viewOpts,
    expanded: d.expanded,
    panes: d.panes,
    url: d.url,
    agentControl: d.agentControl,
    device: d.device,
    zoom: typeof d.zoom === 'number' && d.zoom >= ZOOM_MIN && d.zoom <= ZOOM_MAX ? d.zoom : undefined,
    chatSessionId: d.chatSessionId,
    permissionMode: isPermissionMode(d.permissionMode) ? d.permissionMode : undefined,
    chatConfig: d.chatConfig === undefined ? undefined : validChatConfig(d.chatConfig),
    preset: isAgentChatPreset(d.preset) ? d.preset : undefined,
    presetTarget: typeof d.presetTarget === 'string' ? d.presetTarget : undefined,
    skill: typeof d.skill === 'string' ? d.skill : undefined,
    seenVersion: typeof d.seenVersion === 'string' ? d.seenVersion : undefined,
    // Validated on the way out: node data is written by the Diff node and must not persist junk.
    diffNotes: d.diffNotes === undefined ? undefined : validDiffNotes(d.diffNotes),
    plan: d.plan === undefined ? undefined : validPlanData(d.plan),
  }
}

// Pure serializers between a React Flow Edge and a persisted BridgeLink.
export function toFlowEdge(b: BridgeLink): Edge {
  // A skill cable joins two typed ports, so the handles are named (an agent has more than one target handle).
  if (b.kind === 'skill') return { id: b.id, source: b.source, target: b.target, sourceHandle: SKILL_OUT, targetHandle: SKILLS_IN, type: 'skill', data: { kind: 'skill' } }
  return { id: b.id, source: b.source, target: b.target, type: 'context', data: { kind: b.kind } }
}

export function toBridge(e: Edge): BridgeLink {
  // Kind ikut edge-nya: meng-hardcode 'context' membuat kabel buka-file berubah jenis (dan salah
  // label) begitu workspace dimuat ulang. Edge dari sebelum `kind` ada tidak punya data → 'context'.
  const kind = (e.data as { kind?: BridgeLink['kind'] } | undefined)?.kind
  return { id: e.id, source: e.source, target: e.target, kind: kind === 'file' || kind === 'skill' ? kind : 'context' }
}

export const KANBAN_COLUMNS: AgentStatus[] = ['working', 'waiting', 'blocked', 'done']
/** Statuses with no column of their own: a failed agent needs attention, a stopped one is over. */
const KANBAN_FOLD: Partial<Record<AgentStatus, AgentStatus>> = { failed: 'blocked', stopped: 'done' }

// Group agent nodes by their live status. Nodes without a status are omitted.
export function groupByStatus(
  nodes: { id: string; data: { kind?: string; agentId?: string; title?: string } }[],
  statuses: Record<string, AgentStatus>,
): Record<AgentStatus, { id: string; label: string }[]> {
  const out: Record<AgentStatus, { id: string; label: string }[]> =
    { working: [], waiting: [], blocked: [], done: [], failed: [], stopped: [] }
  for (const n of nodes) {
    if (n.data?.kind !== 'agent' && n.data?.agentId == null) continue
    const s = statuses[n.id]
    if (!s) continue
    out[KANBAN_FOLD[s] ?? s].push({ id: n.id, label: n.data.title ?? n.data.agentId ?? n.id.slice(0, 8) })
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
