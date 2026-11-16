// One message row of the chat thread: bubbles, parts (Markdown, tool cards, attachments, errors) and the
// hover/focus action row. Split from chatMessages.tsx, which keeps the list, scrolling and retry/rerun wiring.
import type { ReactNode } from 'react'
import { ChatApprovalCard } from './chatApprovalCard'
import { CopyButton, MessageActionRow } from './chatMessageActions'
import { ChatNotice } from './chatNotice'
import { ChatCostChip } from './chatCostChip'
import { TurnMemoryChip } from '../central/turnMemoryChip'
import ChatMarkdown from './chatMarkdown'
import type { ChatMessage, ChatPart } from './chatTypes'
import { messageText } from './chatTypes'
import { ToolCard, ToolGroup, type Segment } from './chatToolGroup'
import { splitProposalBlocks, type LegacyProposal } from './proposalBlocks'
import { openSettingsAt } from '../settings.link'

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

export type ImageUrl = ((ref: string) => string) | undefined

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
function HumanBubble(props: { message: ChatMessage; onRetry?: (() => void) | undefined; imageUrl?: ImageUrl; rerun?: Rerun }) {
  const { message, rerun } = props
  return (
    <div
      className={`chat-message chat-message--human chat-bubble-row${message.optimistic ? ' is-optimistic' : ''}`}
      data-state={message.state}
      aria-label="human message"
    >
      {rerun?.editor ?? (
        <div className="chat-bubble">
          <span className="sr-only">You said: </span>
          {message.parts.map((part, index) => (
            <PartView key={`${message.id}-${index}`} part={part} assistant={false} imageUrl={props.imageUrl} />
          ))}
        </div>
      )}
      {message.state === 'failed' && <FailedNote onRetry={props.onRetry} text="Not sent" />}
      {message.state !== 'failed' && !rerun?.editor && <Actions message={message} extra={rerun?.button} />}
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

/** Regenerate / Edit of the last exchange (chatRerun): the row's extra button, and the open inline editor. */
export interface Rerun { button?: ReactNode; editor?: ReactNode }

/** Hover/focus row: Copy when there is text, then `extra` (Regenerate / Edit on the last exchange); on a
 *  settled reply the model · tier meta and the memories chip. */
function Actions({ message, extra }: { message: ChatMessage; extra?: ReactNode }) {
  const text = messageText(message)
  const meta = message.role !== 'human' && message.usage && message.state !== 'streaming' && (
    <>
      <ChatCostChip usage={message.usage} />
      {message.turnId && <TurnMemoryChip turnId={message.turnId} />}
    </>
  )
  if (!text && !meta && !extra) return null
  return <MessageActionRow meta={meta || undefined}>{text && <CopyButton text={() => text} label="Copy message" />}{extra}</MessageActionRow>
}

/** One thread row: your bubble, a system notice line, or a reply built from its segments. */
export function MessageRow(props: { message: ChatMessage; segments: Segment[]; onRetry?: (() => void) | undefined; imageUrl?: ImageUrl; rerun?: Rerun }) {
  const { message } = props
  if (message.role === 'human') return <HumanBubble message={message} onRetry={props.onRetry} imageUrl={props.imageUrl} rerun={props.rerun} />
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
      {message.state !== 'streaming' && <Actions message={message} extra={props.rerun?.button} />}
    </div>
  )
}
