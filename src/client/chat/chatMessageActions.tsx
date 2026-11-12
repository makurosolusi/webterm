// Per-message hover/focus action row shared by the Central chat and the Agent Chat node (Claude.ai,
// ChatGPT, the Claude Code VS Code view): Copy on every message, plus whatever each chat can really do
// (Retry, Edit, Rewind). The row also carries the quiet meta line (model, tier, memories) that used to sit
// in a per-message header; it only shows on hover or when keyboard focus is inside the message.
import { useEffect, useState, type ReactNode } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { writeClipboard } from '../clipboard'
import './chatMessageActions.css'

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
    <IconButton label={label} tooltip={note || label} size="icon-xs" className="act-copy" data-state={state} onClick={copy}>
      <span className={`codicon codicon-${state === 'copied' ? 'check' : state === 'failed' ? 'error' : 'copy'}`} aria-hidden="true" />
      {note && <span className="act-copy__note" role="status">{note}</span>}
    </IconButton>
  )
}

/** Hover/focus toolbar under one message; `meta` is the muted detail line at its end (Central: model, tier). */
export function MessageActionRow({ children, meta }: { children?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="act-row" role="toolbar" aria-label="Message actions">
      {children}
      {meta && <span className="act-row__meta">{meta}</span>}
    </div>
  )
}
