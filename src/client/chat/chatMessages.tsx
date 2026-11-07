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
import './chatBubbles.css'

const NEAR_BOTTOM_PX = 80

/** Turn-header icon and display name per role, as in the VS Code Chat view (your own messages are a bubble instead). */
const ROLE_HEADER: Record<Exclude<ChatMessage['role'], 'human'>, { icon: string; name: string }> = {
  assistant: { icon: 'sparkle', name: 'Central agent' },
  tool: { icon: 'sparkle', name: 'Central agent' },
  system: { icon: 'info', name: 'System' },
}

/** A failure reason is a sentence, not a log: anything longer is cut. */
const MAX_REASON = 300

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function summarize(value: unknown): string {
  if (value === undefined) return ''
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return clip(text, 240)
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
  if (part.type === 'error') return <div className="chat-error-inline" role="note">{clip(part.message, MAX_REASON)}</div>
  if (part.type === 'notice') return <div className="chat-notice-inline" role="note">{clip(part.text, MAX_REASON)}</div>
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

/** Your own message: a right-aligned bubble with no header, as in VS Code / Copilot Chat. */
function HumanBubble(props: { message: ChatMessage; onRetry?: (() => void) | undefined }) {
  const { message } = props
  return (
    <div
      className={`chat-message chat-message--human chat-bubble-row${message.optimistic ? ' is-optimistic' : ''}`}
      data-state={message.state}
      aria-label="human message"
    >
      <div className="chat-bubble">
        <span className="sr-only">You said: </span>
        {message.parts.map((part, index) => (
          <PartView key={`${message.id}-${index}`} part={part} assistant={false} />
        ))}
      </div>
      {message.state === 'failed' && <FailedNote onRetry={props.onRetry} text="Not sent" />}
    </div>
  )
}

function FailedNote(props: { text?: string; onRetry?: (() => void) | undefined }) {
  return (
    <div className="chat-failed-note">
      {props.text && <span className="chat-message__failed">{props.text}</span>}
      {props.onRetry && (
        <button type="button" className="chat-retry" onClick={props.onRetry}>
          <span className="codicon codicon-refresh" aria-hidden="true" />
          Retry
        </button>
      )}
    </div>
  )
}

function MessageRow(props: { message: ChatMessage; onRetry?: (() => void) | undefined }) {
  const { message } = props
  if (message.role === 'human') return <HumanBubble message={message} onRetry={props.onRetry} />
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
      {message.state === 'failed' && !message.parts.some((part) => part.type === 'error') && (
        <div className="chat-error-inline">The reply failed before it finished.</div>
      )}
      {message.state === 'failed' && props.onRetry && <FailedNote onRetry={props.onRetry} />}
    </div>
  )
}

/** Text to resend for a failed row: its own text (unsent message), else the message that started the failed reply. */
function retryText(messages: readonly ChatMessage[], index: number): string {
  const message = messages[index]
  if (!message || message.state !== 'failed') return ''
  if (message.role === 'human') return messageText(message)
  for (let i = index - 1; i >= 0; i -= 1) {
    const prior = messages[i]
    if (prior?.role === 'human') return messageText(prior)
  }
  return ''
}

export interface ChatMessagesProps {
  messages: ChatMessage[]
  streaming: boolean
  /** Resends a message; offers Retry on a failed message or reply while no turn runs. */
  onRetry?: (text: string) => void
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
          props.messages.map((message, index) => {
            // Only the newest message: retrying an old failure in the middle of the thread would be out of context.
            const text = props.onRetry && !props.streaming && index === props.messages.length - 1 ? retryText(props.messages, index) : ''
            const retry = props.onRetry
            return <MessageRow key={message.id} message={message} onRetry={text && retry ? () => retry(text) : undefined} />
          })
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
