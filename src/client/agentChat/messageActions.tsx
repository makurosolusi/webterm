// Per-message actions in the agent chat timeline (Claude Code VS Code view: Copy on hover/focus).
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
  const note = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''
  return (
    <IconButton
      label={label}
      tooltip={note || label}
      size="icon-xs"
      className="act-copy"
      data-state={state}
      onClick={() => void writeClipboard(text()).then((ok) => setState(ok ? 'copied' : 'failed'))}
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

/** Hover/focus action row of one user or assistant message; nothing when there is no text to copy. */
export function MessageActions({ message }: { message: ChatMessageView }) {
  const text = messageText(message)
  if (!text) return null
  return (
    <div className="act-row" role="toolbar" aria-label="Message actions">
      <CopyButton text={() => text} label="Copy message" />
    </div>
  )
}
