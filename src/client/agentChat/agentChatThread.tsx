// Timeline rendering of the agent chat view: messages (Markdown, collapsed thinking, tool cards with
// nested subagent content), permission / question / plan cards, notices, slash-command output and
// compaction dividers. Pure props -> markup;
// state lives in agentChatStore, requests in the view.
import type { ReactNode } from 'react'
import ChatMarkdown from '../chat/chatMarkdown'
import type { AgentChatPart, AgentChatPermissionAnswer } from '../../shared/agentChat.wire'
import type { AgentPermissionMode } from '../../shared/workspace.capabilities'
import { isBusyStatus, type AgentChatState, type ChatMessageView, type DraftSegment } from './agentChatStore'
import { ToolCard } from './toolCards'
import { PermissionCard } from './permissionCard'
import { QuestionCard } from './questionCard'
import { PlanCard } from './planCard'
import { MessageActions } from './messageActions'
import { CommandOutputBlock, CompactDivider, QueuedBadge } from './timelineBlocks'

export interface ThreadActions {
  answer: (a: AgentChatPermissionAnswer) => Promise<void>
  setMode: (m: AgentPermissionMode) => Promise<void>
  loadFull: (toolUseId: string) => Promise<string>
  /** URL of a transcript image (history `image` part reference). */
  imageUrl: (ref: string) => string
}

interface Ctx { state: AgentChatState; actions: ThreadActions }

function Thinking({ text, live }: { text: string; live?: boolean }) {
  return (
    <details className="agent-chat-thinking">
      <summary>{live ? 'Thinking…' : 'Thinking'}</summary>
      <p className="chat-text">{text}</p>
    </details>
  )
}

/** Messages whose `parentId` is this tool: the subagent run of a Task card. */
function Children({ ctx, parentId }: { ctx: Ctx; parentId: string }) {
  const kids = ctx.state.order.filter((k) => k.startsWith('m:') && ctx.state.messages[k.slice(2)]?.parentId === parentId)
  if (kids.length === 0) return null
  return <>{kids.map((k) => <MessageBody key={k} ctx={ctx} message={ctx.state.messages[k.slice(2)] as ChatMessageView} />)}</>
}

function Tool({ ctx, id }: { ctx: Ctx; id: string }) {
  const tool = ctx.state.tools[id]
  if (!tool) return null
  return (
    <ToolCard tool={tool} loadFull={ctx.actions.loadFull}>
      <Children ctx={ctx} parentId={id} />
    </ToolCard>
  )
}

function Draft({ seg }: { seg: DraftSegment }) {
  return seg.kind === 'thinking' ? <Thinking text={seg.text} live /> : <ChatMarkdown source={seg.text} />
}

type ImagePart = Extract<AgentChatPart, { k: 'image' }>

/** A user image: live bytes, else the transcript copy by reference, else a placeholder (bytes dropped from the replay log). */
function UserImage({ ctx, part }: { ctx: Ctx; part: ImagePart }) {
  const src = part.data ? `data:${part.mediaType};base64,${part.data}` : part.ref ? ctx.actions.imageUrl(part.ref) : undefined
  if (!src) return <span className="agent-chat-muted">[image]</span>
  // Opens full size in a new tab only when it is a server URL (browsers block top-level data: navigation).
  const img = <img className="agent-chat-image" src={src} alt="Attached image" loading="lazy" />
  return part.data ? img : <a href={src} target="_blank" rel="noreferrer" title="Open full size">{img}</a>
}

function MessageBody({ ctx, message }: { ctx: Ctx; message: ChatMessageView }) {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.k === 'text' ? p.text : '')).join('')
    const images = message.parts.filter((p): p is ImagePart => p.k === 'image')
    return (
      <>
        {images.length > 0 && <div className="agent-chat-images">{images.map((p, i) => <UserImage key={`${message.id}-i${i}`} ctx={ctx} part={p} />)}</div>}
        {text && <p className="chat-text chat-text--plain">{text}</p>}
      </>
    )
  }
  const parts: ReactNode[] = message.parts.map((p, i) => {
    const key = `${message.id}-${i}`
    if (p.k === 'text') return <ChatMarkdown key={key} source={p.text} />
    if (p.k === 'thinking') return <Thinking key={key} text={p.text} />
    if (p.k === 'tool') return <Tool key={key} ctx={ctx} id={p.id} />
    return <p key={key} className="agent-chat-muted">[image]</p>
  })
  return <>{parts}{message.draft.map((seg, i) => <Draft key={`${message.id}-d${i}`} seg={seg} />)}</>
}

function MessageRow({ ctx, message }: { ctx: Ctx; message: ChatMessageView }) {
  const user = message.role === 'user'
  // A turn stopped or crashed mid-stream leaves its draft without a final message: live only while busy.
  const streaming = message.draft.length > 0 && isBusyStatus(ctx.state.status)
  return (
    <div className={`chat-message chat-message--${user ? 'human' : 'assistant'}`} aria-label={`${user ? 'user' : 'assistant'} message`}>
      <div className="chat-message__meta">
        <span className={`chat-message__icon codicon codicon-${user ? 'account' : 'sparkle'}`} aria-hidden="true" />
        <span className="chat-message__role">{user ? 'You' : 'Claude'}</span>
        {streaming && <span className="chat-message__live">streaming</span>}
        {user && message.queued && <QueuedBadge />}
      </div>
      <MessageBody ctx={ctx} message={message} />
      {!streaming && <MessageActions message={message} />}
    </div>
  )
}

function Permission({ ctx, id }: { ctx: Ctx; id: string }) {
  const p = ctx.state.permissions[id]
  if (!p) return null
  const props = { request: p.request, outcome: p.outcome, answer: ctx.actions.answer }
  if (p.request.kind === 'question') return <QuestionCard {...props} />
  if (p.request.kind === 'plan') return <PlanCard {...props} setMode={ctx.actions.setMode} />
  return <PermissionCard {...props} />
}

function Notice({ ctx, id }: { ctx: Ctx; id: string }) {
  const n = ctx.state.notices[id]
  if (!n) return null
  const icon = n.level === 'error' ? 'error' : n.level === 'warn' ? 'warning' : 'info'
  return (
    <div className={`agent-chat-notice agent-chat-notice--${n.level}`} role="status">
      <span className={`codicon codicon-${icon}`} aria-hidden="true" />
      <span>{n.text}</span>
    </div>
  )
}

/** Top-level timeline: subagent messages render inside their Task card instead. */
export function AgentChatThread({ state, actions }: Ctx) {
  const ctx = { state, actions }
  return (
    <>
      {state.order.map((key) => {
        const id = key.slice(2)
        if (key.startsWith('p:')) return <Permission key={key} ctx={ctx} id={id} />
        if (key.startsWith('n:')) return <Notice key={key} ctx={ctx} id={id} />
        if (key.startsWith('c:')) {
          const c = state.commandOutputs[id]
          return c ? <CommandOutputBlock key={key} text={c.text} /> : null
        }
        if (key.startsWith('k:')) {
          const k = state.compacts[id]
          return k ? <CompactDivider key={key} trigger={k.trigger} preTokens={k.preTokens} /> : null
        }
        if (!key.startsWith('m:')) return null
        const m = state.messages[id]
        return m && !m.parentId ? <MessageRow key={key} ctx={ctx} message={m} /> : null
      })}
    </>
  )
}
