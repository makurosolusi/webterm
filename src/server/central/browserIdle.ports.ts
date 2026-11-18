// Production ports of the browser idle classifier (browser/browser.idle.ts): the board's cables and nodes, and the ledger's agents.
import type { Database } from 'bun:sqlite'
import type { AgentOfNode, IdlePorts } from '../browser/browser.idle'
import { getRow } from '../ledger/ledgerCore'
import { AGENT_TERMINAL_STATES } from './contracts/agent.types'
import { resolveProfileId } from '../../shared/browser.profile'
import { lookupWorkspace } from './workspaceLookup'

/** A board as the classifier reads it; both `workspace` records and the canvas push board fit. */
export interface BoardLike { nodes?: unknown; bridges?: unknown }
/** Agent node ids are `c-<agentId>` unless the row stored its own `node_id` (agentExecutor.model `agentNodeId`). */
const AGENT_NODE_PREFIX = 'c-'

/** Cables and node presence of one board; `boardOf` returns null for an unknown workspace (no cables, no nodes). */
export function boardPorts(boardOf: (workspaceId: string) => BoardLike | null): Pick<IdlePorts, 'bridgesOf' | 'hasNode'> {
  return {
    bridgesOf: (id) => {
      const b = boardOf(id)?.bridges
      return Array.isArray(b) ? b.filter((x): x is { source: string; target: string } => typeof x?.source === 'string' && typeof x?.target === 'string') : []
    },
    hasNode: (id, nodeId) => {
      const n = boardOf(id)?.nodes
      return Array.isArray(n) && n.some((x) => (x as { id?: unknown } | null)?.id === nodeId)
    },
  }
}

/** The registered workspace store as a board source. */
export const storedBoards = (): Pick<IdlePorts, 'bridgesOf' | 'hasNode'> => boardPorts((id) => lookupWorkspace(id) as BoardLike | null)

/** Profile a browser node runs in per the STORED board (`resolveProfileId`): its own `profileId`, else the workspace's Default (id = workspace id). A switch the UI has not saved yet is not seen here. */
export function storedProfileOf(workspaceId: string, nodeId: string): string {
  const nodes = (lookupWorkspace(workspaceId) as BoardLike | null)?.nodes
  const node = Array.isArray(nodes) ? (nodes.find((n) => (n as { id?: unknown } | null)?.id === nodeId) as { profileId?: string } | undefined) : undefined
  return resolveProfileId(workspaceId, node)
}

/** The newest agent that ran on `nodeId`; `active` = not terminal and not `candidate_done` (a finished worker no longer drives its browser). */
export function ledgerAgentOfNode(db: Database): IdlePorts['agentOfNode'] {
  return (nodeId): AgentOfNode | null => {
    const derived = nodeId.startsWith(AGENT_NODE_PREFIX) ? nodeId.slice(AGENT_NODE_PREFIX.length) : ''
    const row = getRow(db, 'SELECT id, state FROM central_agents WHERE node_id = ? OR id = ? ORDER BY started_at DESC LIMIT 1', nodeId, derived)
    if (!row) return null
    const state = String(row.state)
    return { id: String(row.id), state, active: state !== 'candidate_done' && !(AGENT_TERMINAL_STATES as readonly string[]).includes(state) }
  }
}
