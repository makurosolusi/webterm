// Non-message timeline entries of the agent chat: slash-command output (`c:` keys), compaction
// dividers (`k:` keys) and the queued badge of a user message sent while Claude is busy.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '../chat/chatMessageActions'
import './agentChatTimeline.css'

/** Output longer than this many lines (or chars) starts collapsed. */
const LONG_LINES = 16
const LONG_CHARS = 1_500

/** Local slash-command output (/context, /cost, /compact replies): monospace, whitespace kept. */
export function CommandOutputBlock({ text }: { text: string }) {
  const long = text.length > LONG_CHARS || text.split('\n').length > LONG_LINES
  const [open, setOpen] = useState(!long)
  return (
    <section className="act-cmd" aria-label="Command output" data-open={open}>
      <div className="act-cmd__head">
        <span className="codicon codicon-terminal" aria-hidden="true" />
        <span className="act-cmd__title">Command output</span>
        {long && (
          <Button variant="link" size="xs" className="act-cmd__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Show less' : 'Show all'}
          </Button>
        )}
        <CopyButton text={() => text} label="Copy command output" />
      </div>
      <pre className="act-cmd__body">{text}</pre>
    </section>
  )
}

/** "Conversation compacted" rule with how it was triggered and the token count before, when known. */
export function CompactDivider({ trigger, preTokens }: { trigger: 'manual' | 'auto'; preTokens?: number }) {
  const detail = [trigger === 'auto' ? 'automatic' : 'manual', preTokens !== undefined && `${preTokens.toLocaleString('en-US')} tokens before`]
    .filter(Boolean).join(' · ')
  return (
    <div className="act-compact" role="separator" aria-label={`Conversation compacted (${detail})`}>
      <span className="act-compact__label">
        <span className="codicon codicon-fold" aria-hidden="true" />
        Conversation compacted
        <span className="act-compact__detail">{detail}</span>
      </span>
    </div>
  )
}

/** Badge on a user message waiting behind the running turn. */
export function QueuedBadge() {
  return (
    <span className="act-queued" role="status">
      <span className="codicon codicon-clock" aria-hidden="true" />
      Queued — sends when Claude finishes
    </span>
  )
}
