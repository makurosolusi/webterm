// One conversation: history load, SSE subscription, send/cancel; the turn status sits inline in the thread. The model picker,
// context meter and permission mode live in the composer's control row (chatComposer), not in a header.
// Split from `../ChatPanel` so both stay small. The stream is opened once per conversation with
// the server's `lastEventSeq` as the cursor; deltas are flushed per animation frame so a burst of
// tokens causes one render, not one per token.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { ChatErrorDock, TurnLiveRegion } from './chatInlineStatus'
import { turnPhase } from './chatTurnPhase'
import ChatComposer from './chatComposer'
import ChatMessages from './chatMessages'
import type {
  ChatClient, ChatConversation, ChatEvent, ChatStream, ChatStreamOptions,
} from './chatTypes'
import { SKILL_AUTHOR_MODE, isActiveTurnStatus, newClientMessageId } from './chatTypes'
import {
  buildOptimisticMessage, chatReducer, initialChatState, orderedMessages,
} from './chatStore'
import { ChatApiError, chatErrorMessage, chatImageUrl, isAbortError } from '../chatApi'
import type { ComposerImage } from './chatAttach'
import { centralChatAttach, centralParts, centralWire } from './chatCentralAttach'
import type { ChatPart } from './chatTypes'
import { type CentralChatHost, useCentralChatCommands } from '../central/centralChatCommands'
import { CentralModelPicker } from '../central/centralModelPicker'
import { useActiveWorkspaceId } from '../activeWorkspace.context'
import { CentralContextMeter } from '../central/centralContextMeter'
import { ApprovalModeChip } from '../ApprovalModeControl'
import { CentralSkillAuthorBanner, CentralSkillAuthorChip } from '../central/CentralSkillAuthorBanner'
import { notifyCentralSkillAuthorActivity } from '../central/centralSkillAuthor.events'

export type StreamFactory = (conversationId: string, opts: ChatStreamOptions) => ChatStream

export interface ChatConversationViewProps {
  conversation: ChatConversation
  client: ChatClient
  streamFactory: StreamFactory
  /** Focus the composer on mount (New chat). */
  focusComposer?: boolean
  /** Enables the `/` command menu (central/centralCommands); absent = plain composer. */
  commands?: CentralChatHost
}

function schedule(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
  return setTimeout(callback, 0) as unknown as number
}

function unschedule(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
  else clearTimeout(id)
}

export default function ChatConversationView(props: ChatConversationViewProps) {
  const { conversation } = props
  // The list summary already knows a live turn; seed it so Stop is usable before history settles.
  const [state, dispatch] = useReducer(chatReducer, conversation, (row) => ({
    ...initialChatState(row.id),
    activeTurnId: row.activeTurnId,
  }))
  const [historyError, setHistoryError] = useState<string | null>(null)
  // Bumped by the error dock's Retry to load the history again.
  const [historyTry, setHistoryTry] = useState(0)
  const section = useRef<HTMLElement | null>(null)

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
  }, [conversation.id, conversation.lastEventSeq, conversation.activeTurnId, enqueue, historyTry])

  const busy = state.activeTurnId !== null || isActiveTurnStatus(state.turnStatus)
  const turn = turnPhase({ stream: state.stream, busy, messages: state.messages })
  const authoring = conversation.mode === SKILL_AUTHOR_MODE
  // A finished turn of a skill-author chat may have proposed a draft: tell the Skills tab (no polling there).
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (authoring && wasBusy.current && !busy) notifyCentralSkillAuthorActivity()
    wasBusy.current = busy
  }, [authoring, busy])

  /** Sends text plus attachments (image/file parts: fresh bytes, or stored refs on a Retry). */
  const send = (text: string, attached: ChatPart[] = []): void => {
    const clientMessageId = newClientMessageId()
    dispatch({ type: 'optimistic', message: buildOptimisticMessage(clientMessageId, text, attached) })
    const wire = centralWire(attached)
    if ('reason' in wire) {
      dispatch({ type: 'send-failed', clientMessageId, error: wire.reason })
      return
    }
    clientRef.current.sendMessage(conversation.id, { clientMessageId, text, ...wire }).then(
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

  // Regenerate / Edit of the last exchange. No optimistic rows: the stream drops the old exchange
  // (`message.superseded`) and brings the new one; `rerunning` hides both actions until the server answers.
  const [rerunning, setRerunning] = useState(false)
  const rerun = (mode: 'regenerate' | 'edit', messageId: string, text?: string): void => {
    const clientMessageId = newClientMessageId()
    const input = { clientMessageId, messageId, ...(text === undefined ? {} : { text }) }
    const client = clientRef.current
    const call = mode === 'edit' ? client.editMessage?.(conversation.id, input) : client.regenerate?.(conversation.id, input)
    if (!call) return
    setRerunning(true)
    call.then(
      (result) => dispatch({
        type: 'send-ok', clientMessageId, messageId: result.messageId, seq: result.seq, turnId: result.turnId, status: result.status,
      }),
      (error: unknown) => {
        const message = chatErrorMessage(error)
        if (error instanceof ChatApiError && error.code === 'conversation_busy') dispatch({ type: 'busy', activeTurnId: error.activeTurnId, error: message })
        else dispatch({ type: 'error', error: message })
      }
    ).finally(() => setRerunning(false))
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

  // A command that sends (a prompt shortcut) keeps the composer's attachments; a UI-action command ignores them.
  const sendComposed = (text: string, items: ComposerImage[]): void => send(text, centralParts(items))
  // The model picker reloads after a `/model` choice and after each settled turn (the session may have switched).
  const [modelKey, setModelKey] = useState(0)
  const modelSet = (): void => setModelKey((k) => k + 1)
  const cmd = useCentralChatCommands(props.commands, sendComposed, (error) => dispatch({ type: 'error', error }), conversation.id, modelSet)
  const error = state.error ?? historyError
  const failed = error !== null
  const workspaceId = useActiveWorkspaceId()
  const settledKey = modelKey + (busy ? 0 : state.lastEventSeq)

  return (
    <section ref={section} className="chat-conversation" aria-label="Conversation">
      {authoring && <CentralSkillAuthorBanner target={conversation.skillTarget ?? null} />}
      <TurnLiveRegion info={turn} failed={failed} />
      <ChatMessages messages={orderedMessages(state)} streaming={busy || rerunning || state.stream === 'reconnecting'} status={turn} onRetry={send}
        imageUrl={(ref) => chatImageUrl(conversation.id, ref)}
        {...(props.client.regenerate ? { onRegenerate: (replyId: string) => rerun('regenerate', replyId) } : {})}
        {...(props.client.editMessage ? { onEdit: (messageId: string, text: string) => rerun('edit', messageId, text) } : {})} />
      {error !== null && (
        <ChatErrorDock message={error}
          onRetry={historyError !== null && state.error === null ? () => setHistoryTry((n) => n + 1) : undefined}
          onDismiss={() => { dispatch({ type: 'error', error: null }); setHistoryError(null) }} />
      )}
      <ChatComposer busy={busy} onSend={cmd.onSend} onStop={stop} autoFocus={props.focusComposer}
        completion={cmd.completion} seed={cmd.seed} attach={centralChatAttach} dropZone={section}
        toolbar={props.commands && (
          <>
            {authoring ? <CentralSkillAuthorChip /> : <ApprovalModeChip workspaceId={workspaceId} />}
            <CentralModelPicker conversationId={conversation.id} refreshKey={settledKey}
              openRequest={cmd.modelPickerRequest} onModelSet={modelSet} />
            <CentralContextMeter conversationId={conversation.id} refreshKey={settledKey} />
          </>
        )} />
    </section>
  )
}
