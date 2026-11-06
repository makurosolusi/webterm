// Data carried by an `agentChat` node (PLAN/AGENT-CHAT.md D1). Persisted inside the WsNode blob,
// so this adds no migration.
import { isPermissionMode, type AgentPermissionMode } from './workspace.capabilities'

/** Node kind of the Claude chat node (no terminal). */
export const AGENT_CHAT_KIND = 'agentChat'

/** Fields an agentChat node persists on top of the common WsNode ones. */
export interface AgentChatData {
  agentId: 'claude'
  claudeProfileId?: string
  /** Claude session id, minted by `system/init` on the first turn, never at creation. */
  chatSessionId?: string
  permissionMode?: AgentPermissionMode
}

/** Rebuilds AgentChatData from untrusted node data; undefined when it is not a Claude chat node. */
export function validAgentChatData(v: unknown): AgentChatData | undefined {
  if (!v || typeof v !== 'object') return undefined
  const p = v as Record<string, unknown>
  if (p['agentId'] !== 'claude') return undefined
  const text = (k: 'claudeProfileId' | 'chatSessionId') => (typeof p[k] === 'string' && p[k] !== '' ? { [k]: p[k] as string } : {})
  const mode = isPermissionMode(p['permissionMode']) ? { permissionMode: p['permissionMode'] } : {}
  return { agentId: 'claude', ...text('claudeProfileId'), ...text('chatSessionId'), ...mode }
}
