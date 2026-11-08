// Live agent chat sessions of this server (PLAN/AGENT-CHAT.md D4, D5): `nodeId -> AgentChatSession`,
// created lazily on the first route use. Caps open Claude processes like the browser's `maxLive`:
// over the cap the least recently active idle Query is suspended (resumable), never a busy one.
// Kept free of ./db (bun:sqlite): workspacesApi imports the close hooks under the node-env suite, so
// the production lookup is injected by routes/agentChat.routes.ts.
import type { AgentChatEvent, AgentChatImage } from '../../shared/agentChat.wire'
import { AGENT_CHAT_KIND } from '../../shared/agentChat.shape'
import type { AgentPermissionMode, Workspace, WsNode } from '../../shared/workspace'
import { resolveCwd } from '../ptyShell'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentChatOpen } from './agentChat.options'
import { AGENT_CHAT_CONTROL_TIMEOUT_MS, withTimeout } from './agentChat.controls'
import { AgentChatSession } from './agentChat.session'
import { AgentChatBroker } from './agentChat.broker'
import { AgentChatLock } from './agentChat.lock'
import { agentChatLadderPick } from './agentChat.ladder'

/** Open Claude processes at once (same default as the browser's DEFAULT_MAX_LIVE). */
export const AGENT_CHAT_MAX_LIVE = 3
export const AGENT_CHAT_OVER_CAP_NOTICE = (max: number): string =>
  `All ${max} live agent chats are busy, so this one opened over the limit of ${max}. It will close when it goes idle.`

export const AGENT_CHAT_FULL_REASON = (max: number): string =>
  `All ${max} live agent chats are busy. Send a message or wait for one to finish to load this list.`
export const AGENT_CHAT_BUSY_SWITCH_REASON = 'Claude is working in this chat. Stop it or wait for the turn to end before switching conversations.'

export interface AgentChatTarget { ws: Workspace; node: WsNode }

export interface AgentChatPoolDeps {
  /** The node and its workspace as stored now; undefined = unknown node. */
  lookup(nodeId: string): AgentChatTarget | undefined
  /** Opener for this node's current config (cwd, profile, mode); called on every (re)open. */
  opener(t: AgentChatTarget): AgentChatOpen
  gate?: AgentChatBroker
  lock?: AgentChatLock
  maxLive?: number
  /** Test override of the session idle close. */
  idleMs?: number
  /** Test override of AGENT_CHAT_CONTROL_TIMEOUT_MS. */
  controlTimeoutMs?: number
}

/**
 * Opener config of one node, exactly as a terminal agent node launches: the node's cwd (set from the
 * workspace at creation, workspace cwd as fallback) resolved like the PTY, its launch profile, and its
 * own mode else the settings default.
 */
export function agentChatOpenConfig(t: AgentChatTarget, d: { port: number; mode: AgentPermissionMode }) {
  return { nodeId: t.node.id, port: d.port, cwd: resolveCwd(t.node.cwd ?? t.ws.cwd), profileId: t.node.claudeProfileId, mode: t.node.permissionMode ?? d.mode, workspaceId: t.ws.id }
}

interface Entry { session: AgentChatSession; sessionId?: string; init?: AgentChatEvent; off(): void }

export type AgentChatSendResult = { ok: true } | { ok: false; status: 409; reason: string }
export type AgentChatControlResult<T> = { ok: true; value: T } | { ok: false; status: 409 | 503; reason: string }

export class AgentChatPool {
  readonly gate: AgentChatBroker
  readonly lock: AgentChatLock
  private entries = new Map<string, Entry>()

  constructor(private readonly deps: AgentChatPoolDeps) {
    this.gate = deps.gate ?? new AgentChatBroker()
    this.lock = deps.lock ?? new AgentChatLock()
  }

  /** The node's target when it exists and is an agent chat node. */
  target(nodeId: string): AgentChatTarget | undefined {
    const t = this.deps.lookup(nodeId)
    return t && t.node.kind === AGENT_CHAT_KIND ? t : undefined
  }

  /** Existing session, else a new one resuming the node's `chatSessionId`; undefined = not an agent chat node. */
  session(nodeId: string): AgentChatSession | undefined {
    const had = this.entries.get(nodeId)
    if (had) return had.session
    const t = this.target(nodeId)
    if (!t) return undefined
    const session = new AgentChatSession({
      nodeId,
      open: (resume, canUseTool, abort, input) => this.deps.opener(this.deps.lookup(nodeId) ?? t)(resume, canUseTool, abort, input),
      gate: this.gate,
      ladder: () => agentChatLadderPick((this.deps.lookup(nodeId) ?? t).ws.id),
      onSessionId: (id) => {
        // A fresh id cannot clash; a resumed one was claimed in send(). Old ids of this node are dropped.
        this.lock.release(nodeId)
        this.lock.acquire(id, nodeId)
        entry.sessionId = id
      },
      ...(this.deps.idleMs ? { idleMs: this.deps.idleMs } : {}),
    }, t.node.chatSessionId)
    const entry: Entry = { session, sessionId: t.node.chatSessionId, off: session.subscribe((e) => { if (e.t === 'init') entry.init = e }) }
    this.entries.set(nodeId, entry)
    return session
  }

  /** Session id this node runs or will resume (memory first: the stored node may lag the client save). */
  sessionId(nodeId: string): string | undefined {
    // An entry is seeded from the node and then authoritative: after "new conversation" it holds undefined.
    const e = this.entries.get(nodeId)
    return e ? e.sessionId : this.deps.lookup(nodeId)?.node.chatSessionId
  }

  /** The node's working directory, resolved like the PTY (agentChatOpenConfig). */
  cwd(nodeId: string): string | undefined {
    const t = this.target(nodeId)
    return t ? resolveCwd(t.node.cwd ?? t.ws.cwd) : undefined
  }

  /** Last init event (re-sent to a client whose replay lost it to the log cap). */
  lastInit(nodeId: string): AgentChatEvent | undefined { return this.entries.get(nodeId)?.init }

  /** Send a user turn: session lock first, then the live cap. A refusal is also a notice in the log. */
  send(nodeId: string, text: string, priority?: 'now' | 'next', images: readonly AgentChatImage[] = []): AgentChatSendResult | undefined {
    const s = this.session(nodeId)
    const entry = this.entries.get(nodeId)
    if (!s || !entry) return undefined
    const claim = this.claim(nodeId, entry.sessionId)
    if (!claim.ok) {
      s.notify('warn', claim.reason)
      return claim
    }
    if (!s.live() && !this.makeRoom(s)) s.notify('warn', AGENT_CHAT_OVER_CAP_NOTICE(this.deps.maxLive ?? AGENT_CHAT_MAX_LIVE))
    s.send(text, priority, images)
    return { ok: true }
  }

  /**
   * Run a control request (catalog, models) on the node's Query, opening it without a turn when needed.
   * Unlike a send, a full pool refuses (409) instead of opening over the cap: nothing the user typed waits.
   */
  async control<T>(nodeId: string, fn: (q: Query) => Promise<T>): Promise<AgentChatControlResult<T> | undefined> {
    const s = this.session(nodeId)
    const entry = this.entries.get(nodeId)
    if (!s || !entry) return undefined
    if (!s.live()) {
      const claim = this.claim(nodeId, entry.sessionId)
      if (!claim.ok) return claim
      if (!this.makeRoom(s)) return { ok: false, status: 409, reason: AGENT_CHAT_FULL_REASON(this.deps.maxLive ?? AGENT_CHAT_MAX_LIVE) }
    }
    try {
      s.warm()
      return { ok: true, value: await withTimeout(s.control(fn), this.deps.controlTimeoutMs ?? AGENT_CHAT_CONTROL_TIMEOUT_MS, 'Claude') }
    } catch (err) {
      return { ok: false, status: 503, reason: `Claude could not start for node ${nodeId}: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** Switch the node to a past conversation (lock checked) or a fresh one (undefined). */
  switchTo(nodeId: string, sessionId: string | undefined): AgentChatSendResult | undefined {
    const s = this.session(nodeId)
    const entry = this.entries.get(nodeId)
    if (!s || !entry) return undefined
    if (s.busy()) return { ok: false, status: 409, reason: AGENT_CHAT_BUSY_SWITCH_REASON }
    const claim = this.claim(nodeId, sessionId)
    if (!claim.ok) return claim
    if (entry.sessionId && entry.sessionId !== sessionId) this.lock.drop(entry.sessionId, nodeId)
    entry.sessionId = sessionId
    entry.init = undefined
    s.switchTo(sessionId)
    return { ok: true }
  }

  private claim(nodeId: string, sessionId: string | undefined): AgentChatSendResult {
    if (!sessionId) return { ok: true }
    const r = this.lock.acquire(sessionId, nodeId, this.deps.lookup(nodeId)?.ws)
    return r.ok ? r : { ok: false, status: 409, reason: r.reason }
  }

  /** Suspend the least recently active idle Query when the pool is full; false = full of busy ones. */
  private makeRoom(next: AgentChatSession): boolean {
    const max = this.deps.maxLive ?? AGENT_CHAT_MAX_LIVE
    const live = [...this.entries.values()].map((e) => e.session).filter((s) => s !== next && s.live())
    if (live.length < max) return true
    const victim = live.filter((s) => !s.busy()).sort((a, b) => a.lastActivity() - b.lastActivity())[0]
    victim?.suspend()
    return !!victim
  }

  /** Close one node's session for good (idempotent). */
  close(nodeId: string, reason?: string): void {
    const e = this.entries.get(nodeId)
    if (!e) return
    this.entries.delete(nodeId)
    e.off()
    e.session.close(reason)
    this.lock.release(nodeId)
  }

  /** Board save: close the chat nodes `prev` had and `next` no longer has. */
  closeRemoved(prev: Workspace | null | undefined, next: Workspace): void {
    const kept = new Set(next.nodes.map((n) => n.id))
    for (const n of prev?.nodes ?? []) if (!kept.has(n.id)) this.close(n.id, 'node removed')
  }

  closeWorkspace(ws: Workspace | null | undefined): void {
    for (const n of ws?.nodes ?? []) this.close(n.id, 'workspace deleted')
  }

  closeAll(reason = 'server shutdown'): void {
    for (const id of [...this.entries.keys()]) this.close(id, reason)
  }

  /** Node ids with a session (tests, diagnostics). */
  nodeIds(): string[] { return [...this.entries.keys()] }
}

let active: AgentChatPool | undefined

/** Install the process pool (routes/agentChat.routes.ts on first use; tests). */
export function setAgentChatPool(p: AgentChatPool | undefined): void { active = p }
export function activeAgentChatPool(): AgentChatPool | undefined { return active }

/** Lifecycle hooks; no-ops until a chat route has created the pool. */
export function closeRemovedAgentChats(prev: Workspace | null | undefined, next: Workspace): void { active?.closeRemoved(prev, next) }
export function closeWorkspaceAgentChats(ws: Workspace | null | undefined): void { active?.closeWorkspace(ws) }
