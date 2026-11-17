// The node a new Agent Chat starts as, shared by the board (client/agentChat.add.ts) and Central's
// canvas.open, so both open the same node. The caller mints the id and resolves the profile.
import { AGENT_CHAT_KIND, type AgentChatPreset } from './agentChat.shape'
import { agentConfig, type WsNode } from './workspace'

/** Default title, so the node reads the same in its chrome, the sidebar and Recently closed. */
export const AGENT_CHAT_TITLE = 'Agent Chat'

/** Claude, the given cwd, the default launch profile recorded (none when the id is empty). */
export function buildAgentChatNode(id: string, cwd: string | undefined, claudeProfileId: string, preset?: { preset: AgentChatPreset; presetTarget?: string }): Omit<WsNode, 'x' | 'y'> {
  // No `chatSessionId`: it is minted by the first turn's `system/init`, the same reason AgentNode
  // is born without a `sessionId` (a pre-minted id would be resumed before it exists on disk).
  return {
    id, kind: AGENT_CHAT_KIND, agentId: 'claude', cwd, title: AGENT_CHAT_TITLE,
    color: agentConfig('claude')?.color, ...(claudeProfileId ? { claudeProfileId } : {}),
    ...(preset ? { preset: preset.preset, ...(preset.presetTarget ? { presetTarget: preset.presetTarget } : {}) } : {}),
  }
}
