// Bridge from an agent chat's own event stream to the node status every surface reads (the
// Sessions panel, node headers, Central): the same `AgentStatus` words a Claude Code terminal gets
// from its hooks, so a chat node is never "no status" while it works or waits for you.
import type { AgentChatEvent } from '../../shared/agentChat.wire'
import type { StatusReason } from '../../shared/protocol'
import type { AgentStatus } from '../../shared/workspace'

export interface ChatNodeStatus { status: AgentStatus; reason?: StatusReason }

/**
 * Node status for one chat event; null = the event says nothing new about the node.
 * `hadTurn` = a turn ran since the last turn end, so `idle` means "turn ended", not "just opened".
 *
 * - starting/thinking/tool/retry -> working
 * - permission prompt -> blocked (tool) or waiting with a question (AskUserQuestion); the `awaiting`
 *   status right before it is skipped, the prompt that follows carries the tool name
 * - idle / interrupted after a turn -> waiting (turn ended; the chat stays usable)
 * - error -> failed with the SDK's error subtype
 * - closed -> stopped (the session ended for good)
 */
export function chatNodeStatus(e: AgentChatEvent, hadTurn: boolean): ChatNodeStatus | null {
  if (e.t === 'permission') {
    const question = e.kind === 'question'
    return { status: question ? 'waiting' : 'blocked', reason: { reason: question ? 'question' : 'permission', ...(e.toolName && !question ? { detail: e.toolName } : {}) } }
  }
  if (e.t !== 'status') return null
  switch (e.status) {
    case 'starting': case 'thinking': case 'tool': case 'retry': return { status: 'working' }
    case 'idle': case 'interrupted': return hadTurn ? { status: 'waiting' } : null
    case 'error': return { status: 'failed', reason: { reason: 'error', ...(e.detail ? { detail: e.detail } : {}) } }
    case 'closed': return { status: 'stopped' }
    case 'awaiting': return null
  }
}
