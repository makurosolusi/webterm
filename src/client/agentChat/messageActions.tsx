// Per-message actions in the agent chat timeline (Claude Code VS Code view: Copy on hover/focus; on a
// user message Edit and Rewind to here).
// CopyButton is shared with the command output block so every copy control behaves the same.
import { useEffect, useState } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { writeClipboard } from '../clipboard'
import type { ChatMessageView } from './agentChatStore'
import './agentChatTimeline.css'

const FEEDBACK_MS = 1500

/** Quiet icon button that copies `text()` and shows "Copied" (or "Copy failed") for a moment. */
export function CopyButton({ text, label }: { text: () => string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), FEEDBACK_MS)
    return () => clearTimeout(t)
  }, [state])
  // Copying is instant; the result is the Copied / Copy failed note (role=status) and icon.
  const copy = (): void => { void writeClipboard(text()).then((ok) => setState(ok ? 'copied' : 'failed')) }
  const note = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''
  return (
    <IconButton
      label={label}
      tooltip={note || label}
      size="icon-xs"
      className="act-copy"
      data-state={state}
      onClick={copy}
    >
      <span className={`codicon codicon-${state === 'copied' ? 'check' : state === 'failed' ? 'error' : 'copy'}`} aria-hidden="true" />
      {note && <span className="act-copy__note" role="status">{note}</span>}
    </IconButton>
  )
}

/** Markdown source of a message's text parts (images, thinking and tool calls are not copied). */
export function messageText(message: ChatMessageView): string {
  return message.parts.map((p) => (p.k === 'text' ? p.text : '')).filter(Boolean).join('\n\n')
}

/** Edit / Rewind of a user message (agentChatBranch.tsx); absent while a turn runs. */
export interface BranchActions { edit: (id: string, text: string) => void; rewind: (id: string) => void }

/** Hover/focus action row of one user or assistant message: Copy, and on a user message Edit and Rewind to here. */
export function MessageActions({ message, branch }: { message: ChatMessageView; branch?: BranchActions }) {
  const text = messageText(message)
  const user = branch && message.role === 'user' && !message.queued
  if (!text && !user) return null
  return (
    <div className="act-row" role="toolbar" aria-label="Message actions">
      {text && <CopyButton text={() => text} label="Copy message" />}
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
    </div>
  )
}
