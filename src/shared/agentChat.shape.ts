// Data carried by an `agentChat` node (PLAN/AGENT-CHAT.md D1). Persisted inside the WsNode blob,
// so this adds no migration.
import { isPermissionMode, type AgentPermissionMode } from './workspace.capabilities'

/** Node kind of the Claude chat node (no terminal). */
export const AGENT_CHAT_KIND = 'agentChat'

/** Model / effort / thinking the user picked for this node; the server forgets them on restart, the node does not. */
export interface AgentChatNodeConfig { model?: string; effort?: string; thinking?: boolean }

/** Fields an agentChat node persists on top of the common WsNode ones. */
export interface AgentChatData {
  agentId: 'claude'
  claudeProfileId?: string
  /** Claude session id, minted by `system/init` on the first turn, never at creation. */
  chatSessionId?: string
  permissionMode?: AgentPermissionMode
  chatConfig?: AgentChatNodeConfig
}

/** Chars of a stored model id (the server refuses longer ones too). */
const MODEL_MAX = 200

/** Rebuilds a stored chat config from untrusted data; undefined when nothing valid is left. */
export function validChatConfig(v: unknown): AgentChatNodeConfig | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const p = v as Record<string, unknown>
  const str = (x: unknown): x is string => typeof x === 'string' && x !== '' && x.length <= MODEL_MAX
  const c: AgentChatNodeConfig = {
    ...(str(p.model) ? { model: p.model } : {}),
    ...(str(p.effort) ? { effort: p.effort } : {}),
    ...(typeof p.thinking === 'boolean' ? { thinking: p.thinking } : {}),
  }
  return Object.keys(c).length ? c : undefined
}

/** Rebuilds AgentChatData from untrusted node data; undefined when it is not a Claude chat node. */
export function validAgentChatData(v: unknown): AgentChatData | undefined {
  if (!v || typeof v !== 'object') return undefined
  const p = v as Record<string, unknown>
  if (p['agentId'] !== 'claude') return undefined
  const text = (k: 'claudeProfileId' | 'chatSessionId') => (typeof p[k] === 'string' && p[k] !== '' ? { [k]: p[k] as string } : {})
  const mode = isPermissionMode(p['permissionMode']) ? { permissionMode: p['permissionMode'] } : {}
  const chatConfig = validChatConfig(p['chatConfig'])
  return { agentId: 'claude', ...text('claudeProfileId'), ...text('chatSessionId'), ...mode, ...(chatConfig ? { chatConfig } : {}) }
}
