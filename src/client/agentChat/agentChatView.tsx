// Body of one agent chat node (PLAN/AGENT-CHAT.md W2): live SSE timeline, status line with Stop,
// composer, mode / cost / context footer. One reducer per mounted view; the stream closes on unmount.
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import ChatComposer from '../chat/chatComposer'
import { IconButton } from '@/components/ui/icon-button'
import { Button } from '@/components/ui/button'
import { chatErrorMessage, isAbortError } from '../chat/chatTransport'
import type { ChatStreamStatus } from '../chat/chatTypes'
import { AGENT_CHAT_TEXT_MAX, type AgentChatEvent } from '../../shared/agentChat.wire'
import type { AgentPermissionMode } from '../../shared/workspace.capabilities'
import { agentChatReducer, initialAgentChatState, isBusyStatus, runningToolName, type AgentChatState } from './agentChatStore'
import { AgentChatApiError, createAgentChatTransport, type AgentChatTransport } from './agentChatTransport'
import { AgentChatThread, type ThreadActions } from './agentChatThread'
import { ModePicker } from './modePicker'
import '../chat/chat.css'
import './agentChat.css'

/** Distance from the bottom (px) that still counts as "pinned" for auto-scroll. */
const NEAR_BOTTOM_PX = 80
const DEFAULT_MODE: AgentPermissionMode = 'manual'
const COST_DIGITS = 4

/** User text of a failed request (agent chat errors carry their own; anything else gets the shared text). */
const why = (err: unknown): string => (err instanceof AgentChatApiError ? err.message : chatErrorMessage(err))

export type AgentChatPatch = { chatSessionId?: string; permissionMode?: AgentPermissionMode }

export interface AgentChatViewProps {
  nodeId: string
  chatSessionId?: string
  permissionMode?: AgentPermissionMode
  /** Persists session id / mode into the node's data (rf.updateNodeData). */
  onNodeData: (patch: AgentChatPatch) => void
  /** Test seam; defaults to the HTTP + SSE transport of `nodeId`. */
  transport?: AgentChatTransport
}

/** Status line text, or null when there is nothing to say. */
export function statusLabel(s: AgentChatState, stream: ChatStreamStatus): string | null {
  if (stream === 'connecting' && s.lastSeq === 0) return 'Connecting…'
  switch (s.status) {
    case 'starting': return 'Starting Claude…'
    case 'thinking': return 'Thinking…'
    case 'tool': { const name = runningToolName(s); return name ? `Running ${name}…` : 'Running a tool…' }
    case 'awaiting': return 'Waiting for you'
    case 'retry': return s.statusDetail ? `Retrying: ${s.statusDetail}` : 'Retrying…'
    case 'error': return s.statusDetail ? `Error: ${s.statusDetail}` : 'Error'
    case 'interrupted': return 'Stopped'
    default: return null
  }
}

/** Collects SSE events and applies them once per animation frame (a token burst = one render). */
function useBatchedEvents(apply: (events: AgentChatEvent[]) => void) {
  const queue = useRef<AgentChatEvent[]>([])
  const timer = useRef<(() => void) | null>(null)
  const flush = useCallback(() => {
    timer.current = null
    const events = queue.current
    queue.current = []
    if (events.length > 0) apply(events)
  }, [apply])
  const push = useCallback((e: AgentChatEvent) => {
    queue.current.push(e)
    if (timer.current) return
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(flush)
      timer.current = () => cancelAnimationFrame(id)
    } else {
      const id = setTimeout(flush, 0)
      timer.current = () => clearTimeout(id)
    }
  }, [flush])
  const cancel = useCallback(() => { timer.current?.(); timer.current = null; queue.current = [] }, [])
  return useMemo(() => ({ push, cancel }), [push, cancel])
}

export function AgentChatView({ nodeId, chatSessionId, permissionMode, onNodeData, transport: injected }: AgentChatViewProps) {
  const transport = useMemo(() => injected ?? createAgentChatTransport(nodeId), [injected, nodeId])
  const [state, dispatch] = useReducer(agentChatReducer, nodeId, initialAgentChatState)
  const [stream, setStream] = useState<ChatStreamStatus>('connecting')
  const [sendError, setSendError] = useState<{ text: string; message: string } | null>(null)
  const [stopError, setStopError] = useState<string | null>(null)
  const [history, setHistory] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null })
  const [atBottom, setAtBottom] = useState(true)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const keepFromBottom = useRef<number | null>(null)
  const historyAbort = useRef<AbortController | null>(null)

  const apply = useCallback((events: AgentChatEvent[]) => dispatch({ type: 'events', events }), [])
  const batch = useBatchedEvents(apply)

  useEffect(() => {
    const s = transport.stream({ after: 0, onEvent: batch.push, onStatus: setStream })
    return () => { s.close(); batch.cancel() }
  }, [transport, batch])

  const loadHistory = useCallback((before?: number) => {
    historyAbort.current?.abort()
    const ctl = new AbortController()
    historyAbort.current = ctl
    setHistory({ loading: true, error: null })
    const el = scrollRef.current
    transport.history(before === undefined ? {} : { before }, ctl.signal).then(
      (page) => {
        if (el) keepFromBottom.current = el.scrollHeight - el.scrollTop
        dispatch({ type: 'history', items: page.items, next: page.next })
        setHistory({ loading: false, error: null })
      },
      (err: unknown) => { if (!isAbortError(err)) setHistory({ loading: false, error: why(err) }) },
    )
  }, [transport])

  useEffect(() => {
    loadHistory()
    return () => historyAbort.current?.abort()
  }, [loadHistory])

  // Persist what the server told us, once per change, so a reload resumes the same session and mode.
  const sessionId = state.session?.sessionId
  useEffect(() => { if (sessionId && sessionId !== chatSessionId) onNodeData({ chatSessionId: sessionId }) }, [sessionId, chatSessionId, onNodeData])
  useEffect(() => { if (state.mode && state.mode !== permissionMode) onNodeData({ permissionMode: state.mode }) }, [state.mode, permissionMode, onNodeData])

  // Pinned to the bottom unless the user scrolled up; a prepended history page keeps the view still.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (keepFromBottom.current !== null) { el.scrollTop = el.scrollHeight - keepFromBottom.current; keepFromBottom.current = null }
    else if (atBottom) el.scrollTop = el.scrollHeight
  }, [state, atBottom])

  const busy = isBusyStatus(state.status)
  const send = (text: string): void => {
    setSendError(null)
    transport.send(text, busy ? 'next' : undefined).catch((err: unknown) => setSendError({ text, message: why(err) }))
  }
  const stop = (): void => {
    setStopError(null)
    transport.interrupt().catch((err: unknown) => setStopError(why(err)))
  }
  const actions: ThreadActions = useMemo(() => ({
    answer: (a) => transport.answer(a),
    setMode: (m) => transport.setMode(m),
    loadFull: (id) => transport.toolResult(id),
  }), [transport])

  const jump = (): void => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setAtBottom(true)
  }
  const onScroll = (): void => {
    const el = scrollRef.current
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX)
  }

  const label = statusLabel(state, stream)
  const empty = state.order.length === 0
  const mode = state.mode ?? permissionMode ?? DEFAULT_MODE

  return (
    <section className="agent-chat nodrag nowheel" aria-label="Agent chat">
      {stream === 'reconnecting' && (
        <div className="agent-chat-banner" role="status">
          <span className="chat-progress" aria-hidden="true" />
          <span>Connection lost. Reconnecting…</span>
        </div>
      )}
      {(state.status === 'closed' || stream === 'closed') && (
        <div className="agent-chat-banner" role="status">
          <span className="codicon codicon-debug-disconnect" aria-hidden="true" />
          <span>{state.status === 'closed' ? 'This Claude session has ended. Send a message to start a new turn.' : 'Live updates stopped. Reload the board to reconnect.'}</span>
        </div>
      )}

      <div className="chat-thread-wrap">
        <div className="chat-thread agent-chat-thread" role="log" aria-live="polite" aria-busy={busy} ref={scrollRef} onScroll={onScroll}>
          {typeof state.historyNext === 'number' && (
            <Button variant="outline" size="xs" className="agent-chat-earlier" disabled={history.loading} onClick={() => loadHistory(state.historyNext ?? undefined)}>
              {history.loading ? 'Loading…' : 'Load earlier'}
            </Button>
          )}
          {history.error && (
            <div className="chat-error" role="alert">
              <span className="codicon codicon-error" aria-hidden="true" />
              <span>{`Earlier messages could not be loaded. ${history.error}`}</span>
              <Button variant="secondary" size="xs" onClick={() => loadHistory(state.historyNext ?? undefined)}>Retry</Button>
            </div>
          )}
          {empty && !history.loading && (
            <p className="chat-empty">{stream === 'connecting' ? 'Connecting to Claude…' : 'Ask Claude anything about this folder.'}</p>
          )}
          <AgentChatThread state={state} actions={actions} />
        </div>
        {!atBottom && (
          <Button variant="secondary" size="xs" className="chat-jump" onClick={jump}>
            <span className="codicon codicon-arrow-down" aria-hidden="true" />
            Jump to bottom
          </Button>
        )}
      </div>

      {label && (
        <div className={`agent-chat-status agent-chat-status--${state.status}`}>
          {busy ? <span className="chat-progress" aria-hidden="true" /> : <span className="chat-status-dot" aria-hidden="true" />}
          <span className="agent-chat-status__label" aria-live="polite">{label}</span>
          {busy && <IconButton label="Stop" tooltip="Stop the running turn" size="icon-xs" onClick={stop}><span className="codicon codicon-debug-stop" aria-hidden="true" /></IconButton>}
        </div>
      )}

      {sendError && (
        <div className="chat-error" role="alert">
          <span className="codicon codicon-error" aria-hidden="true" />
          <span>{`Not sent: ${sendError.message}`}</span>
          <Button variant="secondary" size="xs" onClick={() => send(sendError.text)}>Retry</Button>
          <IconButton label="Dismiss error" size="icon-xs" onClick={() => setSendError(null)}>
            <span className="codicon codicon-close" aria-hidden="true" />
          </IconButton>
        </div>
      )}
      {stopError && (
        <div className="chat-error" role="alert">
          <span className="codicon codicon-error" aria-hidden="true" />
          <span>{`Could not stop: ${stopError}`}</span>
          <IconButton label="Dismiss stop error" size="icon-xs" onClick={() => setStopError(null)}>
            <span className="codicon codicon-close" aria-hidden="true" />
          </IconButton>
        </div>
      )}

      <ChatComposer busy={false} onSend={send} onStop={stop} label="Message Claude"
        placeholder={busy ? 'Claude is working. Your message runs next…' : 'Ask Claude…'} maxLength={AGENT_CHAT_TEXT_MAX} />

      <footer className="agent-chat-footer">
        <ModePicker mode={mode} onChange={(m) => transport.setMode(m)} />
        {state.session?.model && <span className="agent-chat-footer__item" title="Model">{state.session.model}</span>}
        {state.costUsd !== undefined && <span className="agent-chat-footer__item" title="Session cost">{`$${state.costUsd.toFixed(COST_DIGITS)}`}</span>}
        {state.tokens && (
          <span className="agent-chat-footer__item" title="Tokens of the last turn (input incl. cache / output)">
            {`${state.tokens.input.toLocaleString('en-US')} in · ${state.tokens.output.toLocaleString('en-US')} out`}
          </span>
        )}
      </footer>
    </section>
  )
}
