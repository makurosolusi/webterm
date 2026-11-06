// State of ONE agent chat node view (PLAN/AGENT-CHAT.md D6/D7), built by a pure reducer from the
// server's events (src/shared/agentChat.wire.ts). Each view owns its reducer instance (useReducer),
// so two nodes never share state; nothing here is module-global.
//
// Cursor rule (server re-sends live state on every connect): an event with `seq > lastSeq` applies
// normally; an `init` / `permission` at or below the cursor applies idempotently and never lowers
// it; anything else at or below the cursor is a duplicate and is dropped.
import type { AgentChatEvent, AgentChatEventBody, AgentChatPart, AgentChatStatus } from '../../shared/agentChat.wire'
import { isPermissionMode, type AgentPermissionMode } from '../../shared/workspace.capabilities'
import type { PermissionEvent, PermissionOutcome, ToolEvent } from './agentChatCards.types'

/** Streamed text not yet folded into a final `message` event. */
export interface DraftSegment { kind: 'text' | 'thinking'; text: string }

export interface ChatMessageView {
  id: string
  role: 'user' | 'assistant'
  parts: AgentChatPart[]
  draft: DraftSegment[]
  parentId?: string
  /** Came from the transcript (history), not the live log. */
  fromHistory?: boolean
  /** Transcript id of the copy this live user message absorbed (dedupe, see `applyHistory`). */
  absorbed?: string
}

export interface SessionInfo { sessionId: string; model: string; commands: string[]; capabilities: string[]; cliVersion: string }

export interface AgentChatState {
  nodeId: string
  lastSeq: number
  /** Timeline keys in render order: `m:<messageId>`, `p:<requestId>`, `n:<id>`. */
  order: string[]
  messages: Record<string, ChatMessageView>
  tools: Record<string, ToolEvent>
  permissions: Record<string, { request: PermissionEvent; outcome: PermissionOutcome }>
  notices: Record<string, { level: 'info' | 'warn' | 'error'; text: string }>
  status: AgentChatStatus
  statusDetail?: string
  session?: SessionInfo
  mode?: AgentPermissionMode
  /** `total_cost_usd` of the LAST result: cumulative per Query on the server, so never summed. */
  costUsd?: number
  /** Input + cache tokens and output tokens of the last turn, when the result carried usage. */
  tokens?: { input: number; output: number }
  /** Cursor of the next older history page; undefined = not loaded yet, null = start reached. */
  historyNext?: number | null
}

/** One transcript item from `GET history` (an event body plus its page cursor). */
export type HistoryItem = AgentChatEventBody & { cursor: number }

export type AgentChatAction =
  | { type: 'events'; events: AgentChatEvent[] }
  | { type: 'history'; items: HistoryItem[]; next: number | null }

const BUSY: readonly AgentChatStatus[] = ['starting', 'thinking', 'tool', 'awaiting', 'retry']
/** Statuses during which Stop makes sense (a turn is running or about to). */
export const isBusyStatus = (s: AgentChatStatus): boolean => BUSY.includes(s)

export function initialAgentChatState(nodeId: string): AgentChatState {
  return { nodeId, lastSeq: 0, order: [], messages: {}, tools: {}, permissions: {}, notices: {}, status: 'idle' }
}

/** SDK permission mode -> node mode ('default' is the node's 'manual'); undefined for modes the node has no name for. */
export function nodeMode(sdkMode: string): AgentPermissionMode | undefined {
  if (sdkMode === 'default') return 'manual'
  return isPermissionMode(sdkMode) ? sdkMode : undefined
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function tokensOf(usage: unknown): AgentChatState['tokens'] {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  return { input: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens), output: num(u.output_tokens) }
}

const userText = (m: ChatMessageView): string => m.parts.map((p) => (p.k === 'text' ? p.text : '')).join('')

function upsertMessage(s: AgentChatState, id: string, patch: (m: ChatMessageView) => ChatMessageView, fresh: () => ChatMessageView): AgentChatState {
  const cur = s.messages[id]
  const order = cur ? s.order : [...s.order, `m:${id}`]
  return { ...s, order, messages: { ...s.messages, [id]: patch(cur ?? fresh()) } }
}

function appendDraft(draft: DraftSegment[], kind: DraftSegment['kind'], text: string): DraftSegment[] {
  const last = draft[draft.length - 1]
  if (last && last.kind === kind) return [...draft.slice(0, -1), { kind, text: last.text + text }]
  return [...draft, { kind, text }]
}

function applyOne(s: AgentChatState, e: AgentChatEvent): AgentChatState {
  if (e.seq <= s.lastSeq && e.t !== 'init' && e.t !== 'permission') return s
  const st: AgentChatState = e.seq > s.lastSeq ? { ...s, lastSeq: e.seq } : s
  switch (e.t) {
    case 'status':
      return { ...st, status: e.status, statusDetail: e.detail }
    case 'init': {
      const mode = nodeMode(e.mode)
      const session = { sessionId: e.sessionId, model: e.model, commands: e.commands, capabilities: e.capabilities, cliVersion: e.cliVersion }
      return { ...st, session, ...(mode ? { mode } : {}) }
    }
    case 'mode': {
      const mode = nodeMode(e.mode)
      return mode ? { ...st, mode } : st
    }
    case 'delta':
      return upsertMessage(st, e.messageId, (m) => ({ ...m, draft: appendDraft(m.draft, e.kind, e.text) }),
        () => ({ id: e.messageId, role: 'assistant', parts: [], draft: [], ...(e.parentId ? { parentId: e.parentId } : {}) }))
    case 'message':
      // The server re-emits the cumulative message per content block: replace parts, drop the draft they cover.
      return upsertMessage(st, e.messageId, (m) => ({ ...m, role: e.role, parts: e.parts, draft: [] }),
        () => ({ id: e.messageId, role: e.role, parts: [], draft: [], ...(e.parentId ? { parentId: e.parentId } : {}) }))
    case 'tool': {
      const { seq: _seq, ...tool } = e
      return { ...st, tools: { ...st.tools, [e.id]: tool } }
    }
    case 'permission': {
      if (st.permissions[e.requestId]) return st // replayed on reconnect: already known
      const { seq: _seq, ...request } = e
      return { ...st, order: [...st.order, `p:${e.requestId}`], permissions: { ...st.permissions, [e.requestId]: { request, outcome: 'open' } } }
    }
    case 'permissionResolved': {
      const cur = st.permissions[e.requestId]
      return cur ? { ...st, permissions: { ...st.permissions, [e.requestId]: { ...cur, outcome: e.outcome } } } : st
    }
    case 'result':
      return { ...st, costUsd: e.costUsd, tokens: tokensOf(e.usage) ?? st.tokens }
    case 'notice': {
      const id = `s${e.seq}`
      return { ...st, order: [...st.order, `n:${id}`], notices: { ...st.notices, [id]: { level: e.level, text: e.text } } }
    }
    default:
      return st
  }
}

/**
 * Prepends one older transcript page. Items already known by id (assistant messages, tools) are
 * skipped. A transcript user message has another id than its live echo, so it is matched by text
 * against a live user message that has not absorbed a copy yet.
 * ponytail: text match, so the same prompt typed before AND after the live log started can drop the
 * older copy; a server-side shared message id would make this exact.
 */
function applyHistory(s: AgentChatState, items: HistoryItem[], next: number | null): AgentChatState {
  const messages = { ...s.messages }
  const tools = { ...s.tools }
  const notices = { ...s.notices }
  const keys: string[] = []
  for (const it of items) {
    if (it.t === 'message') {
      if (messages[it.messageId] || Object.values(messages).some((m) => m.absorbed === it.messageId)) continue
      const view: ChatMessageView = { id: it.messageId, role: it.role, parts: it.parts, draft: [], fromHistory: true, ...(it.parentId ? { parentId: it.parentId } : {}) }
      if (it.role === 'user') {
        const text = userText(view)
        const twin = Object.values(messages).find((m) => m.role === 'user' && !m.fromHistory && !m.absorbed && userText(m) === text)
        if (twin) { messages[twin.id] = { ...twin, absorbed: it.messageId }; continue }
      }
      messages[it.messageId] = view
      keys.push(`m:${it.messageId}`)
    } else if (it.t === 'tool') {
      const { cursor: _cursor, ...tool } = it
      if (!tools[it.id]) tools[it.id] = tool
    } else if (it.t === 'notice') {
      const id = `h${it.cursor}`
      if (notices[id]) continue
      notices[id] = { level: it.level, text: it.text }
      keys.push(`n:${id}`)
    }
  }
  return { ...s, messages, tools, notices, order: [...keys, ...s.order], historyNext: next }
}

export function agentChatReducer(s: AgentChatState, a: AgentChatAction): AgentChatState {
  if (a.type === 'history') return applyHistory(s, a.items, a.next)
  return a.events.reduce(applyOne, s)
}

/** Name of the newest running tool, for the "Running X…" status line. */
export function runningToolName(s: AgentChatState): string | undefined {
  return Object.values(s.tools).filter((t) => t.state === 'running').at(-1)?.name
}
