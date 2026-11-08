// Agent chat node surface (/api/agent-chat/:nodeId/*). Builds the process pool on first use with the
// stored node + workspace lookup. UI-only (route.uiOnly.ts): no agent shell or plain curl drives
// a chat, answers its permission prompts or changes its mode.
import { agentChatRoute } from '../agentChat/agentChat.route'
import { activeAgentChatPool, AgentChatPool, agentChatOpenConfig, setAgentChatPool } from '../agentChat/agentChat.pool'
import { agentChatQueryOpener } from '../agentChat/agentChat.options'
import { findWorkspaceFor } from '../contextLinkRoute'
import { db } from '../db'
import { PORT } from '../launchLine'
import type { ApiRoute } from './route.core'
import { uiOnly } from './route.uiOnly'

function productionPool(): AgentChatPool {
  const had = activeAgentChatPool()
  if (had) return had
  const pool = new AgentChatPool({
    lookup: (nodeId) => {
      const ws = findWorkspaceFor(db.list(), nodeId)
      const node = ws?.nodes.find((n) => n.id === nodeId)
      return ws && node ? { ws, node } : undefined
    },
    opener: (t) => {
      const s = db.getSettings()
      return agentChatQueryOpener(agentChatOpenConfig(t, { port: PORT, mode: s.claudePermissionMode, skip: s.skipApprovals }))
    },
  })
  setAgentChatPool(pool)
  return pool
}

export const agentChatRoutes: ApiRoute[] = [
  uiOnly({ name: 'agent-chat', match: (c) => c.path.startsWith('/api/agent-chat/'), handle: (c) => agentChatRoute(c, { pool: productionPool() }) }),
]
