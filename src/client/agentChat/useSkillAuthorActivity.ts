// Primes a skill-author chat once: sends the instruction on the first open stream, records that in the node
// (so a reload never re-sends it) and reports every finished turn to the Skills tab's drafts panel.
import { useEffect, useRef } from 'react'
import type { AgentChatPreset } from '../../shared/agentChat.shape'
import type { AgentChatTransport } from './agentChatTransport'
import { notifySkillAuthorActivity } from './skillAuthor.events'
import { SKILL_AUTHOR_PRESET, skillAuthorInstruction } from './skillAuthor.preset'

interface Input {
  nodeId: string
  preset?: AgentChatPreset
  presetTarget?: string
  presetPrimed?: boolean
  chatSessionId?: string
  /** The stream is open, i.e. the server knows this node. */
  ready: boolean
  busy: boolean
  transport: AgentChatTransport
  markPrimed: () => void
}

export function useSkillAuthorPriming({ nodeId, preset, presetTarget, presetPrimed, chatSessionId, ready, busy, transport, markPrimed }: Input): void {
  const sent = useRef(false)
  const author = preset === SKILL_AUTHOR_PRESET
  useEffect(() => {
    if (!author || !ready || presetPrimed || chatSessionId || sent.current) return
    sent.current = true
    transport.send(skillAuthorInstruction(presetTarget)).then(markPrimed, () => { sent.current = false })
  }, [author, ready, presetPrimed, chatSessionId, presetTarget, transport, markPrimed])
  const was = useRef(busy)
  useEffect(() => {
    if (author && was.current && !busy) notifySkillAuthorActivity(nodeId)
    was.current = busy
  }, [author, busy, nodeId])
}
