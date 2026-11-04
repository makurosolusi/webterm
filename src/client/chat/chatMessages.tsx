// Message thread + minimal tool card for the chat panel (RND/11 §3).
//
// `role="log"` announces completed messages, not every token; deltas are visual only. Markdown
// goes through the shared sanitizer (`../markdown`), never raw HTML. Auto-scroll only sticks when
// the reader is already near the bottom (<80px), otherwise a "Jump to bottom" button appears.
import { useEffect, useRef, useState } from 'react'
import ChatMarkdown from './chatMarkdown'
import type { ChatMessage, ChatPart } from './chatTypes'
import { messageText } from './chatTypes'
import { splitProposalBlocks, type LegacyProposal } from './proposalBlocks'

const NEAR_BOTTOM_PX = 80

/** Turn-header icon and display name per role, as in the VS Code Chat view. */
const ROLE_HEADER: Record<ChatMessage['role'], { icon: string; name: string }> = {
  human: { icon: 'account', name: 'You' },
  assistant: { icon: 'sparkle', name: 'Central agent' },
  tool: { icon: 'sparkle', name: 'Central agent' },
  system: { icon: 'info', name: 'System' },
}

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
      <span className="chat-tool__icon codicon codicon-tools" aria-hidden="true" />
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

/** Old history only: Central no longer writes these blocks, and nothing here can run one. */
function LegacyProposalBlock({ proposal }: { proposal: LegacyProposal }) {
  return (
    <div className="chat-proposal" data-tool={proposal.tool}>
      <span className="chat-proposal__icon codicon codicon-history" aria-hidden="true" />
      <details className="chat-tool__detail chat-proposal__detail">
        <summary>{`Legacy proposal · ${proposal.tool} (not run)`}</summary>
        <pre>{proposal.body}</pre>
      </details>
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
      {parsed.visible !== '' && <ChatMarkdown source={parsed.visible} />}
      {parsed.proposals.map((proposal, index) => <LegacyProposalBlock key={`${proposal.tool}-${index}`} proposal={proposal} />)}
    </>
  )
}

function MessageRow(props: { message: ChatMessage }) {
  const { message } = props
  const assistant = message.role === 'assistant' || message.role === 'tool'
  const header = ROLE_HEADER[message.role]
  return (
    <div
      className={`chat-message chat-message--${message.role}${message.optimistic ? ' is-optimistic' : ''}`}
      data-state={message.state}
      aria-label={`${message.role} message`}
    >
      <div className="chat-message__meta">
        <span className={`chat-message__icon codicon codicon-${header.icon}`} aria-hidden="true" />
        <span className="chat-message__role">{header.name}</span>
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
        <button type="button" className="chat-jump" onClick={jump}>
          <span className="codicon codicon-arrow-down" aria-hidden="true" />
          Jump to bottom
        </button>
      )}
    </div>
  )
}

/** Screen-reader text for the newest completed message only; not used per token. */
export function lastMessageLabel(messages: readonly ChatMessage[]): string {
  const last = messages[messages.length - 1]
  return last ? messageText(last) : ''
}
