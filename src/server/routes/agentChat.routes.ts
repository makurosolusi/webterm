// Agent chat node surface (/api/agent-chat/:nodeId/*) over the process pool (agentChat.runtime.ts).
// UI-only (route.uiOnly.ts): no agent shell or plain curl drives a chat, answers its permission
// prompts or changes its mode.
import { agentChatRoute } from '../agentChat/agentChat.route'
import { agentChatPool } from '../agentChat/agentChat.runtime'
import type { ApiRoute } from './route.core'
import { uiOnly } from './route.uiOnly'

export const agentChatRoutes: ApiRoute[] = [
  uiOnly({ name: 'agent-chat', match: (c) => c.path.startsWith('/api/agent-chat/'), handle: (c) => agentChatRoute(c, { pool: agentChatPool() }) }),
]
