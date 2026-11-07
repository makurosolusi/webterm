// One agent chat node's live Claude session (PLAN/AGENT-CHAT.md D4, D6, D7): owns at most one SDK
// `Query` (streaming input), opened lazily on the first send (or `warm()` for the "/" catalog), closed
// after an idle period and reopened with `resume`. Keeps the in-memory event log replayed to
// reconnecting clients. Permission prompts go through agentChat.permission.ts to the injected gate.
import type { CanUseTool, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentChatConfig, AgentChatEvent, AgentChatEventBody, AgentChatImage, AgentChatStatus } from '../../shared/agentChat.wire'
import type { AgentPermissionMode } from '../../shared/workspace'
import { createLogger } from '../logs'
import { capLogImages, userTurn } from './agentChat.attach'
import { AGENT_CHAT_DEFAULT_CONFIG, applyConfigLive, mergeConfig, type AgentChatConfigPatch } from './agentChat.controls'
import { createAgentChatMapper } from './agentChat.events'
import { Inbox } from './agentChat.inbox'
import { agentChatPermissionMode, createStderrTail, type AgentChatOpen } from './agentChat.options'
import { createCanUseTool, type PermissionGate } from './agentChat.permission'

export type { PermissionGate }

const log = createLogger('agent-chat')

export const AGENT_CHAT_IDLE_CLOSE_MS = 10 * 60_000
export const AGENT_CHAT_EVENT_LOG_MAX = 2_000
export interface AgentChatSessionDeps {
  nodeId: string
  /** Opens the Query; production = `agentChatQueryOpener(...)` (agentChat.options.ts), tests inject a fake. */
  open: AgentChatOpen
  gate: PermissionGate
  /** A new session_id (first init, /clear reset): the pool re-locks it, the client persists it. */
  onSessionId(id: string): void
  now?: () => number
  /** Test override of AGENT_CHAT_IDLE_CLOSE_MS. */
  idleMs?: number
}

export class AgentChatSession {
  readonly nodeId: string
  private q?: Query
  private inbox?: Inbox
  private abort?: AbortController
  private st: AgentChatStatus = 'idle'
  private running = false
  private closed = false
  private mode?: AgentPermissionMode
  private config: AgentChatConfig = AGENT_CHAT_DEFAULT_CONFIG
  private seq = 0
  private log: AgentChatEvent[] = []
  private subs = new Set<(e: AgentChatEvent) => void>()
  private pending = new Map<string, AbortController>()
  private mapper = createAgentChatMapper()
  private stderr = createStderrTail()
  private idleTimer?: ReturnType<typeof setTimeout>
  private last: number
  private readonly canUseTool: CanUseTool

  constructor(private readonly deps: AgentChatSessionDeps, private sessionId?: string) {
    this.nodeId = deps.nodeId
    this.last = this.now()
    this.canUseTool = createCanUseTool({
      nodeId: deps.nodeId, gate: deps.gate, pending: this.pending,
      emit: (e) => this.emit(e), denied: (id) => this.mapper.denied(id), fail: (op, err) => this.fail(op, err), running: () => this.running,
    })
  }

  status(): AgentChatStatus { return this.st }
  busy(): boolean { return this.running }
  lastActivity(): number { return this.last }
  /** A Query (one Claude process) is open right now. */
  live(): boolean { return this.q !== undefined }

  /** Close the Query only, as the idle timer does (pool cap eviction); the next send resumes. Never a busy one. */
  suspend(): void {
    if (this.running || this.closed || !this.q) return
    this.closeQuery()
    this.emit({ t: 'status', status: 'idle' })
  }

  /** Append a notice from outside the session (pool cap, session lock). */
  notify(level: 'info' | 'warn' | 'error', text: string): void { this.emit({ t: 'notice', level, text }) }

  /** Queue a user turn; opens the Query if needed. While a turn runs the message is queued as 'next'. */
  send(text: string, priority?: 'now' | 'next', images: readonly AgentChatImage[] = []): void {
    if (this.closed) throw new Error(`agent chat send: session for node ${this.nodeId} is closed`)
    this.touch()
    const opening = !this.q
    if (opening) this.openQuery()
    const p = this.running ? priority ?? 'next' : priority
    const turn = userTurn(text, images, p)
    this.inbox?.push(turn.message)
    this.emit({ t: 'message', messageId: turn.id, role: 'user', parts: turn.parts })
    if (this.running) { this.mapper.queue(turn.id); this.emit({ t: 'queued', messageId: turn.id, queued: true }) }
    if (!this.running) this.emit({ t: 'status', status: opening ? 'starting' : 'thinking' })
    this.running = true
  }

  async interrupt(): Promise<void> {
    if (!this.q || !this.running) return
    this.mapper.markInterrupt()
    try {
      await this.q.interrupt()
    } catch (err) {
      this.fail('interrupt', err)
    }
  }

  async setMode(mode: AgentPermissionMode): Promise<void> {
    this.mode = mode
    const sdkMode = agentChatPermissionMode(mode)
    if (this.q) await this.q.setPermissionMode(sdkMode)
    this.emit({ t: 'mode', mode: sdkMode })
  }

  /** Merge a config change: live on an open Query, else stored for the next open. Emits `config`. */
  async setConfig(patch: AgentChatConfigPatch): Promise<void> {
    const next = mergeConfig(this.config, patch)
    if (this.q) await applyConfigLive(this.q, this.config, next)
    this.config = next
    this.emit({ t: 'config', config: next })
  }

  /** Open the Query without a turn (the "/" catalog before the first message); closes on idle as usual. */
  warm(): void {
    if (this.closed) throw new Error(`agent chat warm: session for node ${this.nodeId} is closed`)
    if (this.q) return
    this.openQuery()
    this.armIdle()
  }

  /** Run a control request on the open Query (`warm()` first). */
  control<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    if (!this.q) return Promise.reject(new Error(`agent chat control: no open Query for node ${this.nodeId}`))
    this.touchIdle()
    return fn(this.q)
  }

  /** Follow another conversation (resume) or a fresh one (undefined); the timeline starts over. Never while busy. */
  switchTo(sessionId: string | undefined): void {
    if (this.running) throw new Error(`agent chat switch: node ${this.nodeId} is running a turn`)
    this.closeQuery()
    this.sessionId = sessionId
    this.mapper = createAgentChatMapper()
    this.emit({ t: 'reset', sessionId: sessionId ?? '' })
    this.emit({ t: 'status', status: 'idle' })
  }

  /** A client cursor past this log means the server restarted under an open page: number on after it. */
  resumeAfter(cursor: number): void { if (cursor > this.seq) this.seq = cursor }

  events(after: number): AgentChatEvent[] {
    return this.log.filter((e) => e.seq > after)
  }

  subscribe(fn: (e: AgentChatEvent) => void): () => void {
    this.subs.add(fn)
    return () => { this.subs.delete(fn) }
  }

  /** Abort the Query, expire pending prompts; the session is done for good. */
  close(reason?: string): void {
    if (this.closed) return
    this.closed = true
    this.closeQuery()
    this.emit({ t: 'status', status: 'closed', ...(reason ? { detail: reason } : {}) })
  }

  private now(): number { return (this.deps.now ?? Date.now)() }

  private touch(): void {
    this.last = this.now()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  /** Restart the idle close of a warm (turnless) Query on activity. */
  private touchIdle(): void { if (!this.running) this.armIdle() }

  private openQuery(): void {
    const abort = new AbortController()
    const inbox = new Inbox()
    this.abort = abort
    this.inbox = inbox
    const q = this.deps.open(this.sessionId, this.canUseTool, abort, {
      prompt: inbox,
      config: this.config,
      ...(this.mode ? { mode: this.mode } : {}),
      notice: (text) => this.emit({ t: 'notice', level: 'warn', text }),
      stderr: (chunk) => this.stderr.push(chunk),
    })
    this.q = q
    void this.pump(q, abort)
  }

  private async pump(q: Query, abort: AbortController): Promise<void> {
    try {
      for await (const m of q) {
        if (this.q !== q) return
        this.handle(m)
      }
      if (this.q === q && !abort.signal.aborted && this.running) this.fail('stream', new Error('Claude process ended during a turn'))
      else if (this.q === q) this.dropQuery()
    } catch (err) {
      if (this.q === q && !abort.signal.aborted) this.fail('stream', err)
    }
  }

  private handle(m: SDKMessage): void {
    this.last = this.now()
    // Turn frames only: a warm Query's system frames (commands_changed, ...), a rate-limit update and
    // the echo of a streamed user message (replay-user-messages) are no turn.
    if (m.type === 'result') this.running = false
    else if (m.type !== 'system' && m.type !== 'rate_limit_event' && !(m.type === 'user' && 'isReplay' in m)) this.running = true
    for (const e of this.mapper.map(m)) {
      // canUseTool runs as soon as the SDK reads the request, often before the tool_use is mapped here: keep 'awaiting'.
      if (e.t === 'status' && this.pending.size > 0 && (e.status === 'tool' || e.status === 'thinking')) continue
      if ((e.t === 'init' || e.t === 'reset') && e.sessionId !== this.sessionId) {
        this.sessionId = e.sessionId
        this.deps.onSessionId(e.sessionId)
      }
      this.emit(e)
      if (e.t === 'init') this.emit({ t: 'config', config: this.config })
    }
    if (m.type === 'result') this.armIdle()
  }

  private armIdle(): void {
    this.touch()
    this.idleTimer = setTimeout(() => {
      if (this.running || this.closed || !this.q) return
      this.closeQuery()
      this.emit({ t: 'status', status: 'idle' })
    }, this.deps.idleMs ?? AGENT_CHAT_IDLE_CLOSE_MS)
  }

  /** Query failed: status error + notice with context; the next send reopens with resume. */
  private fail(operation: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    log.error('agent_chat.failed', 'agent chat operation failed', { ids: { nodeId: this.nodeId }, operation, error: err instanceof Error ? err.name : typeof err })
    if (operation !== 'stream') {
      this.emit({ t: 'notice', level: 'error', text: `Agent chat ${operation} failed for node ${this.nodeId}: ${message}` })
      return
    }
    const tail = this.stderr.text()
    this.closeQuery()
    this.emit({ t: 'notice', level: 'error', text: `Agent chat stopped while streaming for node ${this.nodeId}: ${message}${tail ? `\n${tail}` : ''}` })
    this.emit({ t: 'status', status: 'error' })
  }

  /** Forget the Query without aborting it (it already ended). */
  private dropQuery(): void {
    this.q = undefined
    this.inbox = undefined
    this.abort = undefined
    this.running = false
  }

  private closeQuery(): void {
    this.touch()
    for (const [requestId, ctl] of this.pending) {
      this.pending.delete(requestId)
      ctl.abort()
      this.emit({ t: 'permissionResolved', requestId, outcome: 'expired' })
    }
    for (const id of this.mapper.dropQueued()) this.emit({ t: 'queued', messageId: id, queued: false })
    const q = this.q
    this.abort?.abort()
    this.inbox?.end()
    this.dropQuery()
    try {
      q?.close()
    } catch (err) {
      log.warn('agent_chat.close_failed', 'agent chat query close failed', { ids: { nodeId: this.nodeId }, error: err instanceof Error ? err.name : typeof err })
    }
  }

  private emit(body: AgentChatEventBody): void {
    if (body.t === 'status') {
      if (body.status === this.st && body.detail === undefined) return
      this.st = body.status
    }
    const e = { ...body, seq: ++this.seq } as AgentChatEvent
    this.log.push(e)
    if (this.log.length > AGENT_CHAT_EVENT_LOG_MAX) this.log.shift()
    if (e.t === 'message' && e.parts.some((x) => x.k === 'image')) capLogImages(this.log)
    for (const fn of this.subs) fn(e)
  }
}
