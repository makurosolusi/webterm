// One conversation: history load, SSE subscription, send/cancel, status + composer.
// Split from `../ChatPanel` so both stay small. The stream is opened once per conversation with
// the server's `lastEventSeq` as the cursor; deltas are flushed per animation frame so a burst of
// tokens causes one render, not one per token.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { AlertCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import ChatComposer from './chatComposer'
import ChatMessages from './chatMessages'
import type {
  ChatClient, ChatConversation, ChatEvent, ChatStream, ChatStreamOptions, ChatTurnStatus,
} from './chatTypes'
import { isActiveTurnStatus, newClientMessageId } from './chatTypes'
import {
  buildOptimisticMessage, chatReducer, initialChatState, orderedMessages,
} from './chatStore'
import { ChatApiError, chatErrorMessage, isAbortError } from '../chatApi'

export type StreamFactory = (conversationId: string, opts: ChatStreamOptions) => ChatStream

export interface ChatConversationViewProps {
  conversation: ChatConversation
  client: ChatClient
  streamFactory: StreamFactory
}

function schedule(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
  return setTimeout(callback, 0) as unknown as number
}

function unschedule(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
  else clearTimeout(id)
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Streaming',
  awaiting_approval: 'Waiting for approval',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function statusText(
  stream: string,
  turnStatus: ChatTurnStatus | null,
  active: boolean
): { label: string; live: boolean } {
  if (stream === 'reconnecting') return { label: 'Reconnecting…', live: true }
  if (stream === 'connecting') return { label: 'Connecting…', live: true }
  if (turnStatus && STATUS_LABEL[turnStatus]) {
    return { label: STATUS_LABEL[turnStatus], live: active || isActiveTurnStatus(turnStatus) }
  }
  return { label: active ? 'Working…' : 'Ready', live: active }
}

export default function ChatConversationView(props: ChatConversationViewProps) {
  const { conversation } = props
  // The list summary already knows a live turn; seed it so Stop is usable before history settles.
  const [state, dispatch] = useReducer(chatReducer, conversation, (row) => ({
    ...initialChatState(row.id),
    activeTurnId: row.activeTurnId,
  }))
  const [historyError, setHistoryError] = useState<string | null>(null)

  // Refs, not effect deps: an inline client/stream factory must not restart the stream.
  const clientRef = useRef(props.client)
  clientRef.current = props.client
  const streamRef = useRef(props.streamFactory)
  streamRef.current = props.streamFactory

  // rAF coalescing for SSE frames. `enqueuedSeq` dedupes inside a batch before React sees it.
  const queue = useRef<{ events: ChatEvent[]; frame: number | null; seq: number }>({
    events: [],
    frame: null,
    seq: conversation.lastEventSeq,
  })

  const flush = useCallback(() => {
    queue.current.frame = null
    const batch = queue.current.events
    queue.current.events = []
    for (const event of batch) dispatch({ type: 'event', event })
  }, [])

  const enqueue = useCallback((event: ChatEvent) => {
    if (event.seq <= queue.current.seq) return
    queue.current.seq = event.seq
    queue.current.events.push(event)
    if (queue.current.frame === null) queue.current.frame = schedule(flush)
  }, [flush])

  useEffect(() => {
    queue.current = { events: [], frame: null, seq: conversation.lastEventSeq }
    const controller = new AbortController()
    let live = true
    setHistoryError(null)

    clientRef.current.listMessages(conversation.id, { signal: controller.signal }).then(
      (messages) => {
        if (!live) return
        dispatch({ type: 'hydrate', messages, activeTurnId: conversation.activeTurnId })
      },
      (error: unknown) => {
        if (!live || controller.signal.aborted || isAbortError(error)) return
        setHistoryError(chatErrorMessage(error))
      }
    )

    const stream = streamRef.current(conversation.id, {
      after: conversation.lastEventSeq,
      onEvent: enqueue,
      onStatus: (status) => dispatch({ type: 'stream', status }),
    })

    return () => {
      live = false
      controller.abort()
      stream.close()
      if (queue.current.frame !== null) unschedule(queue.current.frame)
      queue.current.frame = null
      queue.current.events = []
    }
  }, [conversation.id, conversation.lastEventSeq, conversation.activeTurnId, enqueue])

  const busy = state.activeTurnId !== null || isActiveTurnStatus(state.turnStatus)
  const status = statusText(state.stream, state.turnStatus, busy)

  const send = (text: string): void => {
    const clientMessageId = newClientMessageId()
    dispatch({ type: 'optimistic', message: buildOptimisticMessage(clientMessageId, text) })
    clientRef.current.sendMessage(conversation.id, { clientMessageId, text }).then(
      (result) => {
        dispatch({
          type: 'send-ok',
          clientMessageId,
          messageId: result.messageId,
          seq: result.seq,
          turnId: result.turnId,
          status: result.status,
        })
      },
      (error: unknown) => {
        const message = chatErrorMessage(error)
        dispatch({ type: 'send-failed', clientMessageId, error: message })
        if (error instanceof ChatApiError && error.code === 'conversation_busy') {
          dispatch({ type: 'busy', activeTurnId: error.activeTurnId, error: message })
        }
      }
    )
  }

  const stop = (): void => {
    const turnId = state.activeTurnId
    if (!turnId) {
      dispatch({ type: 'error', error: 'This turn already finished. Send a new message instead.' })
      return
    }
    clientRef.current.cancelTurn(turnId).then(
      () => dispatch({ type: 'cancel-ok' }),
      (error: unknown) => dispatch({ type: 'error', error: chatErrorMessage(error) })
    )
  }

  const error = state.error ?? historyError

  return (
    <section className="chat-conversation" aria-label="Conversation">
      <header className="chat-conversation__head">
        <span className={`chat-status-dot${status.live ? ' is-live' : ''}`} aria-hidden="true" />
        <span className="chat-conversation__status" aria-live="polite">{status.label}</span>
      </header>

      {error !== null && (
        <div className="chat-error" role="alert">
          <AlertCircle size={13} aria-hidden="true" />
          <span>{error}</span>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Dismiss error"
            onClick={() => dispatch({ type: 'error', error: null })}>
            <X size={13} />
          </Button>
        </div>
      )}

      <ChatMessages messages={orderedMessages(state)} streaming={busy || state.stream === 'reconnecting'} />
      <ChatComposer busy={busy} onSend={send} onStop={stop} />
    </section>
  )
}
