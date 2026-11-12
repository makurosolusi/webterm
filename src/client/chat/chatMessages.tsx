// Message thread + minimal tool card for the chat panel (RND/11 §3). Replies have no per-message header:
// Copy and the quiet model/tier/memories meta sit in a hover/focus action row (chatMessageActions), and a
// system message is one centered notice line (chatNotice).
//
// `role="log"` announces completed messages, not every token; deltas are visual only. Markdown
// goes through the shared sanitizer (`../markdown`), never raw HTML. Auto-scroll only sticks when
// the reader is already near the bottom (<80px), otherwise a "Jump to bottom" button appears.
import { useRef, useState } from 'react'
import { ChatApprovalCard } from './chatApprovalCard'
import { CopyButton, MessageActionRow } from './chatMessageActions'
import { ChatNotice } from './chatNotice'
import { useStickToBottom } from './chatStickToBottom'
import { ChatCostChip } from './chatCostChip'
import { TurnMemoryChip } from '../central/turnMemoryChip'
import ChatMarkdown from './chatMarkdown'
import type { ChatMessage, ChatPart } from './chatTypes'
import { messageText } from './chatTypes'
import { ToolCard, ToolGroup, threadRows, type Segment } from './chatToolGroup'
import { splitProposalBlocks, type LegacyProposal } from './proposalBlocks'
import { openSettingsAt } from '../settings.link'
import './chatBubbles.css'

const NEAR_BOTTOM_PX = 80

/** A failure reason is a sentence, not a log: anything longer is cut. */
const MAX_REASON = 500
/** A turn stopped by the Claude readiness check: the link opens the card holding Test connection. */
const UNAVAILABLE_LINK = 'Open Settings › Claude › Connection test'

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
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

type ImageUrl = ((ref: string) => string) | undefined

/** Byte size as the file chip shows it. */
function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`
}

/** An attached image (bytes on the optimistic echo, else by reference) or a text file chip. */
function AttachmentView(props: { part: Extract<ChatPart, { type: 'image' | 'file' }>; imageUrl: ImageUrl }) {
  const { part } = props
  if (part.type === 'file') {
    return (
      <span className="chat-file-chip" title={part.name}>
        <span className="codicon codicon-file" aria-hidden="true" />
        <span className="chat-file-chip__name">{part.name}</span>
        <span className="chat-file-chip__size">{fileSize(part.size)}</span>
      </span>
    )
  }
  const src = part.data ? `data:${part.mediaType};base64,${part.data}` : part.ref && props.imageUrl ? props.imageUrl(part.ref) : undefined
  if (!src) return <span className="chat-file-chip">[image]</span>
  return (
    <a href={src} target="_blank" rel="noreferrer">
      <img className="chat-image" src={src} alt="Attached image" loading="lazy" />
    </a>
  )
}

function PartView(props: { part: ChatPart; assistant: boolean; imageUrl?: ImageUrl }) {
  const { part, assistant } = props
  if (part.type === 'image' || part.type === 'file') return <AttachmentView part={part} imageUrl={props.imageUrl} />
  if (part.type === 'tool') return <ToolCard part={part} />
  if (part.type === 'approval') return <ChatApprovalCard approvalId={part.approvalId} partState={part.state} />
  if (part.type === 'error') {
    return (
      <div className="chat-error-inline" role="note">
        {clip(part.message, MAX_REASON)}
        {part.code === 'runtime_unavailable' && (
          <> <button type="button" className="chat-retry" onClick={() => openSettingsAt('claude', 'claude-provider')}>{UNAVAILABLE_LINK}</button></>
        )}
      </div>
    )
  }
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
function HumanBubble(props: { message: ChatMessage; onRetry?: (() => void) | undefined; imageUrl?: ImageUrl }) {
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
          <PartView key={`${message.id}-${index}`} part={part} assistant={false} imageUrl={props.imageUrl} />
        ))}
      </div>
      {message.state === 'failed' && <FailedNote onRetry={props.onRetry} text="Not sent" />}
      {message.state !== 'failed' && <Actions message={message} />}
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

/** Hover/focus row: Copy when there is text; on a settled reply the model · tier meta and the memories chip.
 *  No Regenerate or Edit: the Central API has no endpoint to replay or edit a turn (only send and cancel). */
function Actions({ message }: { message: ChatMessage }) {
  const text = messageText(message)
  const meta = message.role !== 'human' && message.usage && message.state !== 'streaming' && (
    <>
      <ChatCostChip usage={message.usage} />
      {message.turnId && <TurnMemoryChip turnId={message.turnId} />}
    </>
  )
  if (!text && !meta) return null
  return <MessageActionRow meta={meta || undefined}>{text && <CopyButton text={() => text} label="Copy message" />}</MessageActionRow>
}

function MessageRow(props: { message: ChatMessage; segments: Segment[]; onRetry?: (() => void) | undefined; imageUrl?: ImageUrl }) {
  const { message } = props
  if (message.role === 'human') return <HumanBubble message={message} onRetry={props.onRetry} imageUrl={props.imageUrl} />
  // A plain-text system message is a notice line; one carrying a card or an error keeps the full row below.
  if (message.role === 'system' && message.parts.length > 0 && message.parts.every((p) => p.type === 'text' || p.type === 'notice')) {
    const text = message.parts.map((p) => ('text' in p ? p.text : '')).filter(Boolean).join(' ')
    return <ChatNotice text={clip(text, MAX_REASON)} time={message.createdAt} />
  }
  return (
    <div
      className={`chat-message chat-message--${message.role}${message.optimistic ? ' is-optimistic' : ''}`}
      data-state={message.state}
      aria-label={`${message.role} message`}
    >
      {props.segments.map((seg, index) =>
        seg.kind === 'tools'
          ? <ToolGroup key={`group-${seg.tools[0]?.toolCallId ?? index}`} tools={seg.tools} />
          : <PartView key={`${message.id}-${index}`} part={seg.part} assistant />,
      )}
      {message.state === 'failed' && !message.parts.some((part) => part.type === 'error') && (
        <div className="chat-error-inline">The reply failed before it finished.</div>
      )}
      {message.state === 'cancelled' && <span className="chat-message__cancelled">Cancelled</span>}
      {message.state === 'failed' && props.onRetry && <FailedNote onRetry={props.onRetry} />}
      {message.state !== 'streaming' && <Actions message={message} />}
    </div>
  )
}

/** Message to resend for a failed row: itself (unsent message), else the message that started the failed reply. */
function retrySource(messages: readonly ChatMessage[], index: number): ChatMessage | undefined {
  const message = messages[index]
  if (!message || message.state !== 'failed') return undefined
  if (message.role === 'human') return message
  for (let i = index - 1; i >= 0; i -= 1) {
    const prior = messages[i]
    if (prior?.role === 'human') return prior
  }
  return undefined
}

/** Text and attachments (image/file parts, by bytes or stored ref) a Retry resends. */
function retryPayload(message: ChatMessage | undefined): { text: string; attached: ChatPart[] } | null {
  if (!message) return null
  const attached = message.parts.filter((p) => p.type === 'image' || p.type === 'file')
  const text = messageText(message)
  return text || attached.length ? { text, attached } : null
}

export interface ChatMessagesProps {
  messages: ChatMessage[]
  streaming: boolean
  /** Resends a message; offers Retry on a failed message or reply while no turn runs. */
  onRetry?: (text: string, attached: ChatPart[]) => void
  /** URL of a stored image (history `image` part reference). */
  imageUrl?: (ref: string) => string
}

export default function ChatMessages(props: ChatMessagesProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)

  const nearBottom = (): boolean => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }

  useStickToBottom(scrollRef, atBottom, props.messages)

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
          threadRows(props.messages).map(({ message, segments }) => {
            const last = props.messages.length - 1
            // Only the newest message: retrying an old failure in the middle of the thread would be out of context.
            const again = props.onRetry && !props.streaming && message === props.messages[last] ? retryPayload(retrySource(props.messages, last)) : null
            const retry = props.onRetry
            return <MessageRow key={message.id} message={message} segments={segments} onRetry={again && retry ? () => retry(again.text, again.attached) : undefined} imageUrl={props.imageUrl} />
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
