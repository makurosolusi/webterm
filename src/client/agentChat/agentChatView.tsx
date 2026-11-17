// Body of one agent chat node (PLAN/AGENT-CHAT.md W2): live SSE timeline, status line ("Thinking…"),
// usage-limit notice, edit / rewind / regenerate (agentChatBranch), todo and task panels, and the shared
// composer (chat/chatComposer) with "/" and "@" completion whose bottom row holds attach, mode, model,
// effort, context meter and Send/Stop. History goes to the node header (`headerHost`). The controls live in
// useAgentChatControls. One reducer per mounted view; the stream closes on unmount.
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStickToBottom } from '../chat/chatStickToBottom'
import ChatComposer from '../chat/chatComposer'
import { useDisconnected } from '../useConnection'
import type { ComposerImage } from '../chat/chatAttach'
import { agentChatAttach } from './agentChatAttach'
import { IconButton } from '@/components/ui/icon-button'
import { Button } from '@/components/ui/button'
import { isAbortError } from '../chat/chatTransport'
import type { ChatStreamStatus } from '../chat/chatTypes'
import { AGENT_CHAT_TEXT_MAX, type AgentChatEvent } from '../../shared/agentChat.wire'
import type { AgentChatNodeConfig, AgentChatPreset } from '../../shared/agentChat.shape'
import { SKILL_AUTHOR_LOCK_REASON, SKILL_AUTHOR_PLACEHOLDER, SKILL_AUTHOR_PRESET } from './skillAuthor.preset'
import { proposedDraft, SkillAuthorDraftCard, SkillAuthorEmpty, SkillAuthorHeader } from './SkillAuthorChat'
import { useSkillAuthorActivity } from './useSkillAuthorActivity'
import type { AgentPermissionMode } from '../../shared/workspace.capabilities'
import { agentChatReducer, initialAgentChatState, isBusyStatus, runningToolName, type AgentChatState } from './agentChatStore'
import { createAgentChatTransport, type AgentChatTransport } from './agentChatTransport'
import { AgentChatThread, type ThreadActions } from './agentChatThread'
import { ModePicker } from './modePicker'
import { AgentChatHistory, AgentChatToolbar } from './agentChatToolbar'
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
// Owner decision 2026-11-17: a node without a stored mode starts in Bypass (the server launch mode follows Settings).
const DEFAULT_MODE: AgentPermissionMode = 'bypassPermissions'

export type { AgentChatPatch }

export interface AgentChatViewProps {
  nodeId: string
  /** The node's folder (the server resolves it; `init` reports the result). */
  cwd?: string
  chatSessionId?: string
  permissionMode?: AgentPermissionMode
  chatConfig?: AgentChatNodeConfig
  /** Preset the node was born with: the server derives the role and tool lock from it; the client shows the banner. */
  preset?: AgentChatPreset
  /** Persists session id / mode / config into the node's data (rf.updateNodeData). */
  onNodeData: (patch: AgentChatPatch) => void
  /** Told whenever a turn starts or ends (the node chrome disables "Open as terminal" meanwhile). */
  onBusy?: (busy: boolean) => void
  /** Test seam; defaults to the HTTP + SSE transport of `nodeId`. */
  transport?: AgentChatTransport
  /** Slot in the node header for the conversation history button (null until the header mounts). */
  headerHost?: HTMLElement | null
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

/** Why the stream was refused, for "Could not connect to Claude: <reason>". */
export function refusedReason(status: number): string {
  if (status === 403) return 'the server refused this page (403). Reload the page or sign in again.'
  if (status === 404) return 'this chat node is not on the server yet (404). Reload the board.'
  return `the server answered ${status}.`
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

export function AgentChatView({ nodeId, cwd, chatSessionId, permissionMode, chatConfig, preset, onNodeData, onBusy, transport: injected, headerHost }: AgentChatViewProps) {
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

  // A stream the server keeps refusing stops retrying (chatStream.ts) and says why; Retry reopens it.
  const [refused, setRefused] = useState<number | null>(null)
  const [streamRun, setStreamRun] = useState(0)
  useEffect(() => {
    const s = transport.stream({ after: 0, onEvent: batch.push, onStatus: setStream, onRefused: setRefused })
    return () => { s.close(); batch.cancel() }
  }, [transport, batch, streamRun])
  const retryStream = (): void => { setRefused(null); setStream('connecting'); setStreamRun((n) => n + 1) }

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

  // A prepended history page keeps the view still; otherwise pinned to the bottom unless the user scrolled up,
  // also when the composer or a panel under the list grows (useStickToBottom).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || keepFromBottom.current === null) return
    el.scrollTop = el.scrollHeight - keepFromBottom.current
    keepFromBottom.current = null
  }, [state])
  useStickToBottom(scrollRef, atBottom, state)

  const busy = isBusyStatus(state.status)
  const authoring = preset === SKILL_AUTHOR_PRESET
  const [picked, setPicked] = useState<{ text: string; key: number } | null>(null) // a clicked skill-author starter
  const offline = useDisconnected() // Retry below re-sends; the composer under it says why (OFFLINE_REASON)
  useEffect(() => { onBusy?.(busy) }, [busy, onBusy])
  useSkillAuthorActivity(nodeId, preset, busy)
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
  // Regenerate = fork before the prompt and send it again: a fresh reply on a new branch (same path as Edit).
  const regenerate = useCallback((id: string, text: string): void => {
    setSendError(null)
    setSending(true)
    transport.fork(id, text, []).then(
      () => setSending(false),
      (err: unknown) => { setSending(false); setSendError({ text, images: [], message: why(err) }) },
    )
  }, [transport])
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
    regenerate,
  }), [transport, branch.edit, branch.rewind, regenerate])

  const jump = (): void => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setAtBottom(true)
  }
  const onScroll = (): void => {
    const el = scrollRef.current
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX)
  }

  const label = sending ? 'Sending…' : statusLabel(state, stream)
  const empty = state.order.length === 0
  const mode = state.mode ?? permissionMode ?? DEFAULT_MODE

  return (
    <section className="agent-chat nodrag nowheel" aria-label="Agent chat" ref={sectionRef}>
      {stream === 'reconnecting' && opened && refused === null && (
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

      {authoring && <SkillAuthorHeader />}

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
          {refused !== null && (
            <div className="chat-error" role="alert">
              <span className="codicon codicon-error" aria-hidden="true" />
              <span>{`Could not connect to Claude: ${refusedReason(refused)}`}</span>
              <Button variant="secondary" size="xs" onClick={retryStream}>Retry</Button>
            </div>
          )}
          {empty && !history.loading && refused === null && (
            authoring && opened ? <SkillAuthorEmpty onPick={(text) => setPicked((p) => ({ text, key: (p?.key ?? 0) + 1 }))} />
              : <p className="chat-empty">{opened ? 'Ask Claude anything about this folder.' : 'Connecting to Claude…'}</p>
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

      {authoring && proposedDraft(state) && <SkillAuthorDraftCard />}

      {/* Working indicator; Stop is the composer's primary button while a turn runs. */}
      {label && (
        <div className={`agent-chat-status agent-chat-status--${state.status}`} role="status">
          {busy || sending ? <span className="chat-progress" aria-hidden="true" /> : <span className="chat-status-dot" aria-hidden="true" />}
          <span className="agent-chat-status__label" aria-live="polite">{label}</span>
        </div>
      )}

      {sendError && (
        <div className="chat-error" role="alert">
          <span className="codicon codicon-error" aria-hidden="true" />
          <span>{`Not sent${sendError.images.length ? ` (with ${sendError.images.length} image${sendError.images.length === 1 ? '' : 's'})` : ''}: ${sendError.message}`}</span>
          <Button variant="secondary" size="xs" disabled={sending || offline} onClick={() => send(sendError.text, sendError.images)}>Retry</Button>
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

      {branch.rewindId && <RewindPanel transport={transport} messageId={branch.rewindId} onClose={branch.closeRewind} />}
      {branch.editing && <EditBanner onCancel={branch.cancelEdit} />}
      <TodoPanel todos={state.todos} />
      <TasksPanel tasks={state.tasks} onStop={(id) => transport.stopTask(id)} />
      <ChatComposer busy={false} seed={branch.editing?.seed ?? picked ?? undefined} running={busy} onSend={send} onStop={stop} label="Message Claude" attach={attach} dropZone={sectionRef}
        completion={controls.completion} maxLength={AGENT_CHAT_TEXT_MAX}
        placeholder={busy ? 'Claude is working. Your message runs next (Esc stops)…' : authoring ? SKILL_AUTHOR_PLACEHOLDER : 'Ask Claude, / for commands, @ for files…'}
        toolbar={<AgentChatToolbar modePicker={<ModePicker mode={mode} onChange={(m) => transport.setMode(m)} {...(authoring ? { lockedReason: SKILL_AUTHOR_LOCK_REASON } : {})} />} {...controls.footer} />} />
      {headerHost && createPortal(<AgentChatHistory modePicker={null} {...controls.footer} />, headerHost)}
    </section>
  )
}
