// Agent chat node surface (/api/agent-chat/:nodeId/*). Builds the process pool on first use with the
// stored node + workspace lookup; root-only via the shared /api/* gate (not a node-token path).
import { agentChatRoute } from '../agentChat/agentChat.route'
import { activeAgentChatPool, AgentChatPool, agentChatOpenConfig, setAgentChatPool } from '../agentChat/agentChat.pool'
import { agentChatQueryOpener } from '../agentChat/agentChat.options'
import { findWorkspaceFor } from '../contextLinkRoute'
import { db } from '../db'
import { PORT } from '../launchLine'
import type { ApiRoute } from './route.core'

function productionPool(): AgentChatPool {
  const had = activeAgentChatPool()
  if (had) return had
  const pool = new AgentChatPool({
    lookup: (nodeId) => {
      const ws = findWorkspaceFor(db.list(), nodeId)
      const node = ws?.nodes.find((n) => n.id === nodeId)
      return ws && node ? { ws, node } : undefined
    },
    opener: (t) => agentChatQueryOpener(agentChatOpenConfig(t, { port: PORT, mode: db.getSettings().claudePermissionMode })),
  })
  setAgentChatPool(pool)
  return pool
}

export const agentChatRoutes: ApiRoute[] = [
  { name: 'agent-chat', match: (c) => c.path.startsWith('/api/agent-chat/'), handle: (c) => agentChatRoute(c, { pool: productionPool() }) },
]
