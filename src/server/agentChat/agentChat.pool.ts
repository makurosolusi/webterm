// Live agent chat sessions of this server (PLAN/AGENT-CHAT.md D4, D5): `nodeId -> AgentChatSession`,
// created lazily on the first route use. Caps open Claude processes like the browser's `maxLive`:
// over the cap the least recently active idle Query is suspended (resumable), never a busy one.
// Kept free of ./db (bun:sqlite): workspacesApi imports the close hooks under the node-env suite, so
// the production lookup is injected by routes/agentChat.routes.ts.
import type { AgentChatEvent, AgentChatImage } from '../../shared/agentChat.wire'
import { AGENT_CHAT_KIND } from '../../shared/agentChat.shape'
import type { AgentPermissionMode, Workspace, WsNode } from '../../shared/workspace'
import { resolveCwd } from '../ptyShell'
import type { AgentChatOpen } from './agentChat.options'
import { AgentChatSession } from './agentChat.session'
import { AgentChatBroker } from './agentChat.broker'
import { AgentChatLock } from './agentChat.lock'

/** Open Claude processes at once (same default as the browser's DEFAULT_MAX_LIVE). */
export const AGENT_CHAT_MAX_LIVE = 3
export const AGENT_CHAT_OVER_CAP_NOTICE = (max: number): string =>
  `All ${max} live agent chats are busy, so this one opened over the limit of ${max}. It will close when it goes idle.`

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
}

/**
 * Opener config of one node, exactly as a terminal agent node launches: the node's cwd (set from the
 * workspace at creation, workspace cwd as fallback) resolved like the PTY, its launch profile, and its
 * own mode else the settings default.
 */
export function agentChatOpenConfig(t: AgentChatTarget, d: { port: number; mode: AgentPermissionMode }) {
  return { nodeId: t.node.id, port: d.port, cwd: resolveCwd(t.node.cwd ?? t.ws.cwd), profileId: t.node.claudeProfileId, mode: t.node.permissionMode ?? d.mode }
}

interface Entry { session: AgentChatSession; sessionId?: string; init?: AgentChatEvent; off(): void }

export type AgentChatSendResult = { ok: true } | { ok: false; status: 409; reason: string }

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
    return this.entries.get(nodeId)?.sessionId ?? this.deps.lookup(nodeId)?.node.chatSessionId
  }

  /** Last init event (re-sent to a client whose replay lost it to the log cap). */
  lastInit(nodeId: string): AgentChatEvent | undefined { return this.entries.get(nodeId)?.init }

  /** Send a user turn: session lock first, then the live cap. A refusal is also a notice in the log. */
  send(nodeId: string, text: string, priority?: 'now' | 'next', images: readonly AgentChatImage[] = []): AgentChatSendResult | undefined {
    const s = this.session(nodeId)
    const entry = this.entries.get(nodeId)
    if (!s || !entry) return undefined
    const resume = entry.sessionId
    if (resume) {
      const claim = this.lock.acquire(resume, nodeId, this.deps.lookup(nodeId)?.ws)
      if (!claim.ok) {
        s.notify('warn', claim.reason)
        return { ok: false, status: 409, reason: claim.reason }
      }
    }
    if (!s.live()) this.makeRoom(s)
    s.send(text, priority, images)
    return { ok: true }
  }

  private makeRoom(next: AgentChatSession): void {
    const max = this.deps.maxLive ?? AGENT_CHAT_MAX_LIVE
    const live = [...this.entries.values()].map((e) => e.session).filter((s) => s !== next && s.live())
    if (live.length < max) return
    const victim = live.filter((s) => !s.busy()).sort((a, b) => a.lastActivity() - b.lastActivity())[0]
    if (victim) victim.suspend()
    else next.notify('warn', AGENT_CHAT_OVER_CAP_NOTICE(max))
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
