// Attention of an Agent Chat node through the same path as terminal agent nodes (`unread#noteStatus`):
// the unread mark in the sidebar, plus an OS notification / chime when the user is not looking
// (`osNotify`: tab hidden or unfocused, node neither selected nor on screen, workspace not muted).
import { useEffect, useRef } from 'react'
import type { AgentStatus } from '../../shared/workspace'
import type { AgentChatStatus } from '../../shared/agentChat.wire'
import { noteStatus } from '../unread'
import type { AgentChatState } from './agentChatStore'

const ATTENTION: Partial<Record<AgentChatStatus, AgentStatus>> = {
  starting: 'working', thinking: 'working', tool: 'working', retry: 'working',
  awaiting: 'waiting', idle: 'done', error: 'failed', interrupted: 'stopped',
}

/** Agent status of a chat status; undefined for `closed` (the node is gone, nothing to tell). */
export const attentionOf = (s: AgentChatStatus): AgentStatus | undefined => ATTENTION[s]

/** Subagent tools of Claude Code (`Task`, renamed `Agent`). */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent'])

/**
 * The quiet rule (`fanoutStillWorking`): a turn that ends
 * while a subagent this chat positively holds as running is not "finished, wants you", so no chime.
 */
export function subagentsRunning(s: Pick<AgentChatState, 'tools'>): boolean {
  return Object.values(s.tools).some((t) => t.state === 'running' && SUBAGENT_TOOLS.has(t.name))
}

/**
 * Feeds status changes of this view to `noteStatus`. The first status a view sees is where the chat
 * already stands (the replay on connect), not news: it is recorded, not reported.
 * ponytail: a replay split across two animation frames can still report an old turn's end once;
 * a server "replay done" marker would make this exact.
 */
export function useAgentChatAttention(nodeId: string, state: AgentChatState): void {
  const last = useRef<AgentStatus | undefined>(undefined)
  const status = attentionOf(state.status)
  const quiet = status === 'done' && subagentsRunning(state)
  useEffect(() => {
    if (!status || status === last.current) return
    const first = last.current === undefined
    last.current = status
    if (first && status !== 'working') return
    noteStatus(nodeId, status, { quiet })
  }, [nodeId, status, quiet])
}
