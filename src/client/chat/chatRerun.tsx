// Regenerate and Edit of the Central chat's last exchange (Claude.ai, ChatGPT; icons and labels as in the
// Agent Chat view's messageActions). Only the last human message and its reply qualify: the server keeps
// no branch tree, so older messages offer neither. Edit is inline (Save & Send / Cancel), not the composer.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Textarea } from '@/components/ui/textarea'
import type { ChatMessage } from './chatTypes'
import './chatRerun.css'

/** The last human message and its reply, when nothing but notices came after them; else null. */
export function rerunTargets(messages: readonly ChatMessage[]): { humanId: string; replyId: string | null } | null {
  let i = messages.length - 1
  while (i >= 0 && messages[i]!.role !== 'human') i -= 1
  const human = messages[i]
  if (!human || human.optimistic || human.seq === null || human.state === 'failed') return null
  const after = messages.slice(i + 1)
  // An automatic (system) turn after it makes the human message no longer the last exchange.
  if (after.some((m) => m.optimistic || (m.role === 'system' && m.turnId))) return null
  const reply = after.find((m) => m.role === 'assistant' && (!human.turnId || m.turnId === human.turnId))
  return { humanId: human.id, replyId: reply?.id ?? null }
}

export function RegenerateButton({ onClick }: { onClick: () => void }) {
  return (
    <IconButton label="Regenerate reply" tooltip="Ask again (replaces this reply)" size="icon-xs" onClick={onClick}>
      <span className="codicon codicon-refresh" aria-hidden="true" />
    </IconButton>
  )
}

export function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <IconButton label="Edit message" tooltip="Edit and resend (replaces this message and its reply)" size="icon-xs" onClick={onClick}>
      <span className="codicon codicon-edit" aria-hidden="true" />
    </IconButton>
  )
}

/** Inline editor in place of the bubble; `allowEmpty` when the message keeps attachments. */
export function EditBox(props: { initial: string; allowEmpty: boolean; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(props.initial)
  const empty = !props.allowEmpty && text.trim() === ''
  const save = (): void => { if (!empty) props.onSave(text.trim()) }
  return (
    <form className="chat-edit" aria-label="Edit message" onSubmit={(e) => { e.preventDefault(); save() }}>
      <Textarea
        className="chat-edit__input"
        aria-label="Message text"
        value={text}
        autoFocus
        rows={Math.min(8, Math.max(2, text.split('\n').length))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); props.onCancel() }
          else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); save() }
        }}
      />
      <div className="chat-edit__actions">
        <Button type="button" variant="secondary" size="xs" onClick={props.onCancel}>Cancel</Button>
        <Button type="submit" size="xs" disabled={empty}>Save &amp; Send</Button>
      </div>
    </form>
  )
}
