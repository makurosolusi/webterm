// Body of one agent chat node (PLAN/AGENT-CHAT.md W2): live SSE timeline, status line with Stop,
// usage-limit notice, edit / rewind (agentChatBranch), todo and task panels, composer with "/" and "@"
// completion, and the footer (mode, model, effort, history, context, cost); the controls live in
// useAgentChatControls. One reducer per mounted view; the stream closes on unmount.
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import ChatComposer from '../chat/chatComposer'
import type { ComposerImage } from '../chat/chatAttach'
import { agentChatAttach } from './agentChatAttach'
import { IconButton } from '@/components/ui/icon-button'
import { Button } from '@/components/ui/button'
import { isAbortError } from '../chat/chatTransport'
import type { ChatStreamStatus } from '../chat/chatTypes'
import { AGENT_CHAT_TEXT_MAX, type AgentChatEvent } from '../../shared/agentChat.wire'
import type { AgentChatNodeConfig } from '../../shared/agentChat.shape'
import type { AgentPermissionMode } from '../../shared/workspace.capabilities'
import { agentChatReducer, initialAgentChatState, isBusyStatus, runningToolName, type AgentChatState } from './agentChatStore'
import { createAgentChatTransport, type AgentChatTransport } from './agentChatTransport'
import { AgentChatThread, type ThreadActions } from './agentChatThread'
import { ModePicker } from './modePicker'
import { AgentChatFooter } from './agentChatFooter'
import { TodoPanel } from './todoPanel'
import { TasksPanel } from './tasksPanel'
import { RateLimitNotice } from './rateLimitNotice'
import { EditBanner, RewindPanel, useAgentChatBranch } from './agentChatBranch'
import { useAgentChatControls, why, type AgentChatPatch } from './useAgentChatControls'
import { useAgentChatAttention } from './useAgentChatAttention'
import '../chat/chat.css'
import './agentChat.css'

/** Distance from the bottom (px) that still counts as "pinned" for auto-scroll. */
const NEAR_BOTTOM_PX = 80
const DEFAULT_MODE: AgentPermissionMode = 'manual'

export type { AgentChatPatch }

export interface AgentChatViewProps {
  nodeId: string
  /** The node's folder (the server resolves it; `init` reports the result). */
  cwd?: string
  chatSessionId?: string
  permissionMode?: AgentPermissionMode
  chatConfig?: AgentChatNodeConfig
  /** Persists session id / mode / config into the node's data (rf.updateNodeData). */
  onNodeData: (patch: AgentChatPatch) => void
  /** Told whenever a turn starts or ends (the node chrome disables "Open as terminal" meanwhile). */
  onBusy?: (busy: boolean) => void
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

export function AgentChatView({ nodeId, cwd, chatSessionId, permissionMode, chatConfig, onNodeData, onBusy, transport: injected }: AgentChatViewProps) {
  const transport = useMemo(() => injected ?? createAgentChatTransport(nodeId), [injected, nodeId])
  const [state, dispatch] = useReducer(agentChatReducer, nodeId, initialAgentChatState)
  const [stream, setStream] = useState<ChatStreamStatus>('connecting')
  const [sendError, setSendError] = useState<{ text: string; images: ComposerImage[]; message: string } | null>(null)
  const [sending, setSending] = useState(false)
  const attach = useMemo(() => agentChatAttach(transport), [transport])
  const sectionRef = useRef<HTMLElement | null>(null)
  const [stopError, setStopError] = useState<string | null>(null)
  const [history, setHistory] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null })
  const [atBottom, setAtBottom] = useState(true)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const keepFromBottom = useRef<number | null>(null)
  const historyAbort = useRef<AbortController | null>(null)

  const controls = useAgentChatControls({ transport, state, stream, cwd, chatSessionId, permissionMode, chatConfig, onNodeData })
  useAgentChatAttention(nodeId, state)
  const branch = useAgentChatBranch()
  const noteEvents = controls.noteEvents
  const onReset = useRef<() => void>(() => {})
  const apply = useCallback((events: AgentChatEvent[]) => {
    noteEvents(events)
    dispatch({ type: 'events', events })
    // Another conversation (resume, fork): its transcript is the timeline now.
    if (events.some((e) => e.t === 'reset')) onReset.current()
  }, [noteEvents])
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

  onReset.current = () => { branch.cancelEdit(); branch.closeRewind(); loadHistory() }

  // A node added a moment ago is not on the server until the board saves (404 until then); the stream
  // retries until it is, so the first history page waits for the first open stream instead of failing.
  const [opened, setOpened] = useState(false)
  useEffect(() => { if (stream === 'open') setOpened(true) }, [stream])
  useEffect(() => {
    if (opened) loadHistory()
    return () => historyAbort.current?.abort()
  }, [opened, loadHistory])

  // Pinned to the bottom unless the user scrolled up; a prepended history page keeps the view still.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (keepFromBottom.current !== null) { el.scrollTop = el.scrollHeight - keepFromBottom.current; keepFromBottom.current = null }
    else if (atBottom) el.scrollTop = el.scrollHeight
  }, [state, atBottom])

  const busy = isBusyStatus(state.status)
  useEffect(() => { onBusy?.(busy) }, [busy, onBusy])
  const send = (text: string, images: ComposerImage[] = []): void => {
    if (!branch.editing && controls.intercept(text, images.length > 0)) return
    setSendError(null)
    setSending(true)
    const wire = images.map(({ mediaType, data }) => ({ mediaType, data }))
    const edited = branch.editing?.id
    const request = edited ? transport.fork(edited, text, wire) : transport.send(text, busy ? 'next' : undefined, wire)
    request.then(
      () => { setSending(false); if (edited) branch.cancelEdit() },
      (err: unknown) => { setSending(false); setSendError({ text, images, message: why(err) }) },
    )
  }
  const stop = (): void => {
    setStopError(null)
    transport.interrupt().catch((err: unknown) => setStopError(why(err)))
  }
  const actions: ThreadActions = useMemo(() => ({
    answer: (a) => transport.answer(a),
    setMode: (m) => transport.setMode(m),
    loadFull: (id) => transport.toolResult(id),
    imageUrl: (ref) => transport.imageUrl(ref),
    branch: { edit: branch.edit, rewind: branch.rewind },
  }), [transport, branch.edit, branch.rewind])

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
    <section className="agent-chat nodrag nowheel" aria-label="Agent chat" ref={sectionRef}>
      {stream === 'reconnecting' && opened && (
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

      <RateLimitNotice limit={state.rateLimit} />

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
            <p className="chat-empty">{opened ? 'Ask Claude anything about this folder.' : 'Connecting to Claude…'}</p>
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
          <span>{`Not sent${sendError.images.length ? ` (with ${sendError.images.length} image${sendError.images.length === 1 ? '' : 's'})` : ''}: ${sendError.message}`}</span>
          <Button variant="secondary" size="xs" disabled={sending} onClick={() => send(sendError.text, sendError.images)}>Retry</Button>
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

      {controls.error && (
        <div className="chat-error" role="alert">
          <span className="codicon codicon-error" aria-hidden="true" />
          <span>{controls.error}</span>
          <IconButton label="Dismiss error" size="icon-xs" onClick={controls.dismissError}>
            <span className="codicon codicon-close" aria-hidden="true" />
          </IconButton>
        </div>
      )}

      {sending && (
        <div className="agent-chat-sending" role="status">
          <span className="chat-progress" aria-hidden="true" />
          <span>Sending…</span>
        </div>
      )}
      {branch.rewindId && <RewindPanel transport={transport} messageId={branch.rewindId} onClose={branch.closeRewind} />}
      {branch.editing && <EditBanner onCancel={branch.cancelEdit} />}
      <TodoPanel todos={state.todos} />
      <TasksPanel tasks={state.tasks} onStop={(id) => transport.stopTask(id)} />
      <ChatComposer busy={false} seed={branch.editing?.seed} running={busy} onSend={send} onStop={stop} label="Message Claude" attach={attach} dropZone={sectionRef}
        completion={controls.completion} maxLength={AGENT_CHAT_TEXT_MAX}
        placeholder={busy ? 'Claude is working. Your message runs next (Esc stops)…' : 'Ask Claude, / for commands, @ for files…'} />

      <AgentChatFooter modePicker={<ModePicker mode={mode} onChange={(m) => transport.setMode(m)} />} {...controls.footer} />
    </section>
  )
}
