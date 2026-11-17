// "Write with an agent" / "Ask the agent to revise" of a skill: starts a NEW skill-author conversation in the
// Central chat (the target skill goes into the conversation, the server validates it) and opens the chat on it.
// The author is a Central conversation, never a canvas node.
import { Button } from '@/components/ui/button'
import { useId, useState } from 'react'
import type { SkillAudience } from '../../server/central/contracts/skill.types'
import { chatApi, chatErrorMessage } from '../chatApi'
import { requestOpenConversation } from '../chat/chatFeed'
import type { ChatClient } from '../chat/chatTypes'
import { CL } from './centralLabels'

interface Props {
  /** Existing skill to edit; absent = write a new one. */
  target?: string
  label: string
  /** Section the button sits in (names it for screen readers); the Central author writes both kinds. */
  kind?: SkillAudience
  /** Set while the skill cannot be revised: the button is disabled and this text says why. */
  disabledReason?: string
  /** Test seam; defaults to the live chat API. */
  chat?: Pick<ChatClient, 'createConversation'>
}

export default function CentralSkillAuthorButton({ target, label, kind = 'central', disabledReason, chat = chatApi }: Props) {
  const reasonId = useId()
  const disabled = disabledReason !== undefined
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    chat.createConversation({ mode: 'skill-author', ...(target ? { skillTarget: target } : {}) }).then(
      (row) => { setBusy(false); requestOpenConversation(row) },
      (err: unknown) => { setBusy(false); setError(CL.authorOpenFailed(chatErrorMessage(err))) },
    )
  }
  return (
    <>
      <Button type="button" size="sm" variant="secondary" disabled={busy || disabled} aria-describedby={disabled ? reasonId : undefined} aria-busy={busy || undefined} aria-label={target ? `${label} ${target}` : `${label} (${CL.skillAudienceBadge[kind]})`} onClick={start}>{!target && <span className="codicon codicon-add" aria-hidden="true" />}{busy ? CL.authorOpening : label}</Button>
      {disabled && <small id={reasonId}>{disabledReason}</small>}
      {error && <span role="alert" className="ccp-error">{error}</span>}
    </>
  )
}
