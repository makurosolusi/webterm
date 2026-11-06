// One agent chat node's live Claude session (PLAN/AGENT-CHAT.md D4, D6, D7): owns at most one SDK
// `Query` (streaming input), opened lazily on the first send, closed after an idle period and reopened
// with `resume`. Keeps the in-memory event log replayed to reconnecting clients. Permission prompts are
// handed to the injected gate (server-io's broker); this class never answers one itself.
import type { CanUseTool, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import type { AgentChatEvent, AgentChatEventBody, AgentChatStatus } from '../../shared/agentChat.wire'
import type { AgentPermissionMode } from '../../shared/workspace'
import { createLogger } from '../logs'
import { createAgentChatMapper } from './agentChat.events'
import { agentChatPermissionMode, createStderrTail, type AgentChatOpen } from './agentChat.options'

const log = createLogger('agent-chat')

export const AGENT_CHAT_IDLE_CLOSE_MS = 10 * 60_000
export const AGENT_CHAT_EVENT_LOG_MAX = 2_000
const CANCELLED_MESSAGE = 'The permission request was cancelled before an answer arrived.'

export interface PermissionGate {
  request(nodeId: string, req: {
    requestId: string; toolName: string; toolUseId: string; input: Record<string, unknown>
    suggestions?: unknown[]; title?: string; description?: string; signal: AbortSignal
  }): Promise<PermissionResult>
}

export interface AgentChatSessionDeps {
  nodeId: string
  /** Opens the Query; production = `agentChatQueryOpener(...)` (agentChat.options.ts), tests inject a fake. */
  open: AgentChatOpen
  gate: PermissionGate
  /** First init carrying a new session_id: server-io persists it to the node. */
  onSessionId(id: string): void
  now?: () => number
  /** Test override of AGENT_CHAT_IDLE_CLOSE_MS. */
  idleMs?: number
}

/** Pushable async iterable of user turns (the Query's streaming input). */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private q: SDKUserMessage[] = []
  private wake?: () => void
  private done = false
  push(m: SDKUserMessage): void { this.q.push(m); this.wake?.() }
  end(): void { this.done = true; this.wake?.() }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.q.length) yield this.q.shift() as SDKUserMessage
      if (this.done) return
      await new Promise<void>((r) => { this.wake = r })
      this.wake = undefined
    }
  }
}

const permissionKind = (toolName: string): 'tool' | 'question' | 'plan' =>
  toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'tool'

const aborted = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
  const fail = (): void => reject(new Error('permission request aborted'))
  if (signal.aborted) fail()
  else signal.addEventListener('abort', fail, { once: true })
})

export class AgentChatSession {
  readonly nodeId: string
  private q?: Query
  private inbox?: Inbox
  private abort?: AbortController
  private st: AgentChatStatus = 'idle'
  private running = false
  private closed = false
  private mode?: AgentPermissionMode
  private seq = 0
  private log: AgentChatEvent[] = []
  private subs = new Set<(e: AgentChatEvent) => void>()
  private pending = new Map<string, AbortController>()
  private mapper = createAgentChatMapper()
  private stderr = createStderrTail()
  private idleTimer?: ReturnType<typeof setTimeout>
  private last: number

  constructor(private readonly deps: AgentChatSessionDeps, private sessionId?: string) {
    this.nodeId = deps.nodeId
    this.last = this.now()
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
  send(text: string, priority?: 'now' | 'next'): void {
    if (this.closed) throw new Error(`agent chat send: session for node ${this.nodeId} is closed`)
    this.touch()
    const opening = !this.q
    if (opening) this.openQuery()
    const p = this.running ? priority ?? 'next' : priority
    this.inbox?.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, ...(p ? { priority: p } : {}) })
    this.emit({ t: 'message', messageId: randomUUID(), role: 'user', parts: [{ k: 'text', text }] })
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

  private openQuery(): void {
    const abort = new AbortController()
    const inbox = new Inbox()
    this.abort = abort
    this.inbox = inbox
    const q = this.deps.open(this.sessionId, this.canUseTool, abort, {
      prompt: inbox,
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
    if (m.type === 'system' && m.subtype === 'init' && m.session_id !== this.sessionId) {
      this.sessionId = m.session_id
      this.deps.onSessionId(m.session_id)
    }
    if (m.type !== 'result') this.running = true
    else this.running = false
    for (const e of this.mapper.map(m)) {
      // canUseTool runs as soon as the SDK reads the request, often before the tool_use is mapped here: keep 'awaiting'.
      if (e.t === 'status' && this.pending.size > 0 && (e.status === 'tool' || e.status === 'thinking')) continue
      this.emit(e)
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

  private readonly canUseTool: CanUseTool = async (toolName, input, opts) => {
    const requestId = opts.requestId
    const local = new AbortController()
    opts.signal.addEventListener('abort', () => local.abort(), { once: true })
    this.pending.set(requestId, local)
    this.emit({ t: 'status', status: 'awaiting' })
    this.emit({
      t: 'permission', requestId, kind: permissionKind(toolName), toolName, toolUseId: opts.toolUseID, input,
      ...(opts.suggestions ? { suggestions: opts.suggestions } : {}), ...(opts.title ? { title: opts.title } : {}), ...(opts.description ? { description: opts.description } : {}),
    })
    let outcome: 'allow' | 'deny' | 'cancelled' = 'cancelled'
    try {
      const res = await Promise.race([
        this.deps.gate.request(this.nodeId, {
          requestId, toolName, toolUseId: opts.toolUseID, input, ...(opts.suggestions ? { suggestions: opts.suggestions } : {}),
          ...(opts.title ? { title: opts.title } : {}), ...(opts.description ? { description: opts.description } : {}), signal: local.signal,
        }),
        aborted(local.signal),
      ])
      outcome = res.behavior
      if (res.behavior === 'deny') this.mapper.denied(opts.toolUseID)
      // CLIs before v2.1.207 reject an allow without updatedInput, so it is always echoed.
      return res.behavior === 'allow' ? { ...res, updatedInput: res.updatedInput ?? input } : res
    } catch (err) {
      if (!local.signal.aborted) this.fail('permission', err)
      this.mapper.denied(opts.toolUseID)
      return { behavior: 'deny', message: CANCELLED_MESSAGE }
    } finally {
      // close() already reported this request as 'expired' and removed it.
      if (this.pending.delete(requestId)) {
        this.emit({ t: 'permissionResolved', requestId, outcome })
        if (this.pending.size === 0 && this.running) this.emit({ t: 'status', status: outcome === 'allow' ? 'tool' : 'thinking' })
      }
    }
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
    for (const fn of this.subs) fn(e)
  }
}
