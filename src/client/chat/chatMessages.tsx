// Message thread + minimal tool card for the chat panel (RND/11 §3). Replies have no per-message header:
// Copy and the quiet model/tier/memories meta sit in a hover/focus action row (chatMessageActions), and a
// system message is one centered notice line (chatNotice).
//
// `role="log"` announces completed messages, not every token; deltas are visual only. Markdown
// goes through the shared sanitizer (`../markdown`), never raw HTML. Auto-scroll only sticks when
// the reader is already near the bottom (<80px); a reader who scrolled up keeps their place and gets a
// "Jump to latest" pill (labelled "New messages" once something arrived meanwhile).
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ChatInlineStatus } from './chatInlineStatus'
import type { TurnPhaseInfo } from './chatTurnPhase'
import { useStickToBottom } from './chatStickToBottom'
import type { ChatMessage, ChatPart } from './chatTypes'
import { messageText } from './chatTypes'
import { threadRows } from './chatToolGroup'
import { EditBox, EditButton, RegenerateButton, rerunTargets } from './chatRerun'
import { MessageRow, type Rerun } from './chatMessageRow'
import './chatBubbles.css'

const NEAR_BOTTOM_PX = 80
const IDLE: TurnPhaseInfo = { phase: 'idle' }

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
  /** Re-runs the last human message; offered on its settled (not failed) reply while no turn runs. */
  onRegenerate?: (replyId: string) => void
  /** Replaces the last human message's text and re-runs it; offered on that message while no turn runs. */
  onEdit?: (messageId: string, text: string) => void
  /** What the running turn is doing; shown as the last row of the thread. */
  status?: TurnPhaseInfo
}

export default function ChatMessages(props: ChatMessagesProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const targets = props.streaming ? null : rerunTargets(props.messages)
  const { onRegenerate, onEdit } = props
  /** Regenerate on the last reply, Edit (or the open editor) on the last human message. */
  const rerunOf = (message: ChatMessage): Rerun | undefined => {
    if (onRegenerate && message.id === targets?.replyId && message.state !== 'failed') {
      return { button: <RegenerateButton onClick={() => onRegenerate(message.id)} /> }
    }
    if (!onEdit || message.id !== targets?.humanId) return undefined
    if (editing !== message.id) return { button: <EditButton onClick={() => setEditing(message.id)} /> }
    const attached = message.parts.some((p) => p.type === 'image' || p.type === 'file')
    return {
      editor: <EditBox initial={messageText(message)} allowEmpty={attached} onCancel={() => setEditing(null)}
        onSave={(text) => { setEditing(null); onEdit(message.id, text) }} />,
    }
  }

  const nearBottom = (): boolean => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }

  useStickToBottom(scrollRef, atBottom, props.messages)
  // Content that lands while the reader is above the bottom is "new"; reaching the bottom clears it.
  useEffect(() => { setUnseen(!atBottom) }, [props.messages]) // eslint-disable-line react-hooks/exhaustive-deps -- only new content, not the scroll position, marks messages unseen
  useEffect(() => { if (atBottom) setUnseen(false) }, [atBottom])

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
            return <MessageRow key={message.id} message={message} segments={segments} onRetry={again && retry ? () => retry(again.text, again.attached) : undefined} imageUrl={props.imageUrl} rerun={rerunOf(message)} />
          })
        )}
        <ChatInlineStatus info={props.status ?? IDLE} />
      </div>
      {!atBottom && (
        <Button variant="secondary" size="xs" className="chat-jump" onClick={jump}>
          <span className="codicon codicon-arrow-down" aria-hidden="true" />
          {unseen ? 'New messages' : 'Jump to latest'}
        </Button>
      )}
    </div>
  )
}

/** Screen-reader text for the newest completed message only; not used per token. */
export function lastMessageLabel(messages: readonly ChatMessage[]): string {
  const last = messages[messages.length - 1]
  return last ? messageText(last) : ''
}
