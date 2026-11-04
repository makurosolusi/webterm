// Production name lookup for agent notices: node title (or agent label) and workspace name from the
// workspace DB. Required lazily because `../db` opens bun:sqlite, which node-env vitest cannot load.
import type { Workspace } from '../../shared/workspace.shape'
import { AGENTS } from '../../shared/workspace.agents'

/** Null when the workspace or node is gone; the notice then stays generic. */
export function describeAgentNode(nodeId: string, workspaceId: string): { label: string; workspace: string } | null {
  const { db } = require('../db') as { db: { get(id: string): Workspace | null | undefined } }
  const ws = db.get(workspaceId)
  const node = ws?.nodes.find((n) => n.id === nodeId)
  if (!ws || !node) return null
  const agent = node.agentId ? (AGENTS as Record<string, { label: string }>)[node.agentId]?.label : undefined
  return { label: node.title || agent || 'Agent', workspace: ws.name }
}
