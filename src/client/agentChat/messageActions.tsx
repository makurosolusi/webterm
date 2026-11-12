// Per-message actions in the agent chat timeline (Claude Code VS Code view: Copy on hover/focus; on a
// user message Edit and Rewind to here; on the newest reply Regenerate). The row and CopyButton are shared
// with the Central chat (chat/chatMessageActions).
import { IconButton } from '@/components/ui/icon-button'
import { CopyButton, MessageActionRow } from '../chat/chatMessageActions'
import type { ChatMessageView } from './agentChatStore'
import './agentChatTimeline.css'

/** Markdown source of a message's text parts (images, thinking and tool calls are not copied). */
export function messageText(message: ChatMessageView): string {
  return message.parts.map((p) => (p.k === 'text' ? p.text : '')).filter(Boolean).join('\n\n')
}

/** Edit / Rewind of a user message (agentChatBranch.tsx); absent while a turn runs. */
export interface BranchActions { edit: (id: string, text: string) => void; rewind: (id: string) => void }

/** Hover/focus action row of one user or assistant message: Copy, on a user message Edit and Rewind to here,
 *  and Regenerate when the view offers it (the newest reply only). */
export function MessageActions({ message, branch, onRegenerate }: { message: ChatMessageView; branch?: BranchActions; onRegenerate?: () => void }) {
  const text = messageText(message)
  const user = branch && message.role === 'user' && !message.queued
  if (!text && !user && !onRegenerate) return null
  return (
    <MessageActionRow>
      {text && <CopyButton text={() => text} label="Copy message" />}
      {onRegenerate && (
        <IconButton label="Regenerate reply" tooltip="Ask again (starts a new branch from your last message)" size="icon-xs" onClick={onRegenerate}>
          <span className="codicon codicon-refresh" aria-hidden="true" />
        </IconButton>
      )}
      {user && text && (
        <IconButton label="Edit message" tooltip="Edit and resend (starts a new branch)" size="icon-xs" onClick={() => branch.edit(message.id, text)}>
          <span className="codicon codicon-edit" aria-hidden="true" />
        </IconButton>
      )}
      {user && (
        <IconButton label="Rewind files to here" tooltip="Rewind files to before this message" size="icon-xs" onClick={() => branch.rewind(message.id)}>
          <span className="codicon codicon-discard" aria-hidden="true" />
        </IconButton>
      )}
    </MessageActionRow>
  )
}
