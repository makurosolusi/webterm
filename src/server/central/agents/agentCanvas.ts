// Puts a Central-spawned PTY agent on the canvas as the same `agent` node the client creates for a
// Claude node, so the user sees it and can type into it. Placing never fails the spawn.
import { createHash } from 'node:crypto'
import type { CanvasPush } from '../../canvas/canvasPush'
import { createLogger } from '../../logs'
import { agentConfig, mintsSessionId, type AgentId, type WsNode } from '../../../shared/workspace'
import type { AgentRecord } from '../contracts'

const log = createLogger('central.agent.canvas')

/**
 * Session id of an agent's PTY, derived from the agent id (UUID-shaped, as claude's `--session-id`
 * needs), so a crash-adopted node gets back the id the CLI really runs with. Undefined for kinds
 * that take no session id.
 */
export function agentSessionId(agent: Pick<AgentRecord, 'id' | 'kind'>): string | undefined {
  if (!mintsSessionId(agent.kind as AgentId)) return undefined
  const h = createHash('sha256').update(`central-agent:${agent.id}`).digest('hex')
  const variant = ((parseInt(h[16] as string, 16) & 3) | 8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export interface AgentNodeInput { agent: AgentRecord; nodeId: string; cwd: string; cmd: string; title: string }

/** The node the client's new-agent action builds (x/y are placed by `CanvasPush.add`). */
export function agentCanvasNode(i: AgentNodeInput): WsNode {
  const sessionId = agentSessionId(i.agent)
  const color = agentConfig(i.agent.kind as AgentId)?.color
  return { id: i.nodeId, kind: 'agent', x: 0, y: 0, cmd: i.cmd, agentId: i.agent.kind, cwd: i.cwd, title: i.title, ...(color ? { color } : {}), ...(sessionId ? { sessionId } : {}) }
}

/** Adds the agent's node to the board of `repo` unless some board already holds it; refusals only warn. */
export function ensureAgentNode(push: CanvasPush | undefined, repo: string | null, i: AgentNodeInput): void {
  if (!push) return
  try {
    if (push.workspaceOfNode(i.nodeId)) return
    const ws = repo ? push.workspaceForCwd(repo) : null
    if (!ws) { log.warn('agent.canvas.no_board', 'no board for the agent project; agent not placed on the canvas', { agentId: i.agent.id, projectId: i.agent.projectId }); return }
    const res = push.add({ workspaceId: ws.id, nodes: [agentCanvasNode(i)] })
    if (!res.ok) log.warn('agent.canvas.add_refused', 'agent node not placed on the canvas', { agentId: i.agent.id, workspaceId: ws.id, code: res.code })
  } catch (err) {
    log.warn('agent.canvas.add_failed', 'agent node not placed on the canvas', { agentId: i.agent.id, error: err instanceof Error ? err.name : 'unknown' })
  }
}
