// Message thread + minimal tool card for the chat panel (RND/11 §3).
//
// `role="log"` announces completed messages, not every token; deltas are visual only. Markdown
// goes through the shared sanitizer (`../markdown`), never raw HTML. Auto-scroll only sticks when
// the reader is already near the bottom (<80px), otherwise a "Jump to bottom" button appears.
import { useEffect, useRef, useState } from 'react'
import { Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { renderMarkdown } from '../markdown'
import type { ChatMessage, ChatPart } from './chatTypes'
import { messageText } from './chatTypes'
import { splitProposalBlocks, type VisibleProposal } from './proposalBlocks'

const NEAR_BOTTOM_PX = 80

function summarize(value: unknown): string {
  if (value === undefined) return ''
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > 240 ? `${text.slice(0, 240)}…` : text
  } catch {
    return '[unreadable]'
  }
}

function ToolCard(props: { part: Extract<ChatPart, { type: 'tool' }> }) {
  const { part } = props
  const summary = summarize(part.result ?? part.args)
  return (
    <div className="chat-tool" data-state={part.state}>
      <span className="chat-tool__icon" aria-hidden="true"><Wrench size={12} /></span>
      <span className="chat-tool__name">{part.name}</span>
      <span className={`chat-tool__state chat-tool__state--${part.state}`}>{part.state.replace('_', ' ')}</span>
      {summary !== '' && (
        <details className="chat-tool__detail">
          <summary>{part.result !== undefined ? 'result' : 'arguments'}</summary>
          <pre>{summary}</pre>
        </details>
      )}
    </div>
  )
}

function proposalGoal(proposal: VisibleProposal): string | undefined {
  try {
    const input = (JSON.parse(proposal.raw.slice('<webterm-proposal>'.length, -'</webterm-proposal>'.length)) as { input?: { goal?: unknown; statement?: unknown } }).input
    const value = input?.goal ?? input?.statement
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

function ProposalCard({ proposal }: { proposal: VisibleProposal }) {
  const label = proposal.tool === 'goal.propose'
    ? 'Goal proposal'
    : proposal.tool === 'plan.propose'
      ? 'Plan proposal'
      : proposal.tool === 'task.assign'
        ? 'Task assignment'
        : proposal.tool === 'approval.request'
          ? 'Approval request'
        : `${proposal.tool} proposal`
  const details = [proposal.projectId, proposal.itemId, proposalGoal(proposal)].filter(Boolean).join(' · ')
  return (
    <div className="chat-proposal" data-tool={proposal.tool}>
      <span className="chat-proposal__icon" aria-hidden="true">•</span>
      <span className="chat-proposal__label">{label}</span>
      {details && <span className="chat-proposal__details">{details}</span>}
    </div>
  )
}

function PartView(props: { part: ChatPart; assistant: boolean }) {
  const { part, assistant } = props
  if (part.type === 'tool') return <ToolCard part={part} />
  if (part.type === 'approval') {
    return <div className="chat-approval-note">Approval requested ({part.state})</div>
  }
  if (part.type === 'error') return <div className="chat-error-inline">{part.message}</div>
  if (part.type !== 'text') return null
  if (!assistant) return <p className="chat-text chat-text--plain">{part.text}</p>
  const parsed = splitProposalBlocks(part.text)
  return (
    <>
      {parsed.visible !== '' && <div className="chat-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.visible) }} />}
      {parsed.proposals.map((proposal, index) => <ProposalCard key={`${proposal.tool}-${index}`} proposal={proposal} />)}
    </>
  )
}

function MessageRow(props: { message: ChatMessage }) {
  const { message } = props
  const assistant = message.role === 'assistant' || message.role === 'tool'
  return (
    <div
      className={`chat-message chat-message--${message.role}${message.optimistic ? ' is-optimistic' : ''}`}
      data-state={message.state}
      aria-label={`${message.role} message`}
    >
      <div className="chat-message__meta">
        <span className="chat-message__role">{message.role}</span>
        {message.state === 'streaming' && <span className="chat-message__live">streaming</span>}
        {message.state === 'failed' && <span className="chat-message__failed">failed</span>}
        {message.state === 'cancelled' && <span className="chat-message__cancelled">cancelled</span>}
      </div>
      {message.parts.map((part, index) => (
        <PartView key={`${message.id}-${index}`} part={part} assistant={assistant} />
      ))}
    </div>
  )
}

export interface ChatMessagesProps {
  messages: ChatMessage[]
  streaming: boolean
}

export default function ChatMessages(props: ChatMessagesProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)

  const nearBottom = (): boolean => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el && atBottom) el.scrollTop = el.scrollHeight
  }, [props.messages, atBottom])

  const jump = (): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setAtBottom(true)
  }

  return (
    <div className="chat-thread-wrap">
      <div
        className="chat-thread"
        role="log"
        aria-live="polite"
        aria-busy={props.streaming}
        ref={scrollRef}
        onScroll={() => setAtBottom(nearBottom())}
      >
        {props.messages.length === 0 ? (
          <p className="chat-empty">No messages yet. Ask the central agent about a project.</p>
        ) : (
          props.messages.map((message) => <MessageRow key={message.id} message={message} />)
        )}
      </div>
      {!atBottom && (
        <Button type="button" variant="outline" size="xs" className="chat-jump" onClick={jump}>Jump to bottom</Button>
      )}
    </div>
  )
}

/** Screen-reader text for the newest completed message only; not used per token. */
export function lastMessageLabel(messages: readonly ChatMessage[]): string {
  const last = messages[messages.length - 1]
  return last ? messageText(last) : ''
}
