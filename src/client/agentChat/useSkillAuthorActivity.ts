// Reports every finished turn of a skill-author chat to the Skills tab's drafts panel. The role itself is
// not sent from here: the server puts it in the system prompt (server/agentChat/agentChat.role.ts).
import { useEffect, useRef } from 'react'
import type { AgentChatPreset } from '../../shared/agentChat.shape'
import { notifySkillAuthorActivity } from './skillAuthor.events'
import { SKILL_AUTHOR_PRESET } from './skillAuthor.preset'

export function useSkillAuthorActivity(nodeId: string, preset: AgentChatPreset | undefined, busy: boolean): void {
  const was = useRef(busy)
  useEffect(() => {
    if (preset === SKILL_AUTHOR_PRESET && was.current && !busy) notifySkillAuthorActivity(nodeId)
    was.current = busy
  }, [preset, busy, nodeId])
}
