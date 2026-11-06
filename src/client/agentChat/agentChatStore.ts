// State of ONE agent chat node view (PLAN/AGENT-CHAT.md D6/D7), built by a pure reducer from the
// server's events (src/shared/agentChat.wire.ts). Each view owns its reducer instance (useReducer),
// so two nodes never share state; nothing here is module-global.
//
// Cursor rule (server re-sends live state on every connect): an event with `seq > lastSeq` applies
// normally; an `init` / `permission` at or below the cursor applies idempotently and never lowers
// it; anything else at or below the cursor is a duplicate and is dropped.
import type { AgentChatConfig, AgentChatContext, AgentChatEvent, AgentChatEventBody, AgentChatPart, AgentChatStatus, AgentChatTodo } from '../../shared/agentChat.wire'
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
  /** Waiting behind the running turn (server `queued` event). */
  queued?: boolean
}

export interface SessionInfo { sessionId: string; model: string; commands: string[]; capabilities: string[]; cliVersion: string; cwd: string }

export interface AgentChatState {
  nodeId: string
  lastSeq: number
  /** Timeline keys in render order: `m:<messageId>`, `p:<requestId>`, `n:<id>`, `c:<commandOutputId>`, `k:<compactId>`. */
  order: string[]
  messages: Record<string, ChatMessageView>
  tools: Record<string, ToolEvent>
  permissions: Record<string, { request: PermissionEvent; outcome: PermissionOutcome }>
  notices: Record<string, { level: 'info' | 'warn' | 'error'; text: string }>
  commandOutputs: Record<string, { text: string }>
  compacts: Record<string, { trigger: 'manual' | 'auto'; preTokens?: number }>
  /** Items of the latest TodoWrite tool input; [] until Claude writes one. */
  todos: AgentChatTodo[]
  config?: AgentChatConfig
  context?: AgentChatContext
  /** Bumped on `commandsChanged`: the view refetches the "/" catalog when it changes. */
  catalogVersion: number
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
  return { nodeId, lastSeq: 0, order: [], messages: {}, tools: {}, permissions: {}, notices: {}, commandOutputs: {}, compacts: {}, todos: [], catalogVersion: 0, status: 'idle' }
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

const TODO_STATUS = new Set(['pending', 'in_progress', 'completed'])
/** `todos` of a TodoWrite input; undefined when the input is not a todo list (malformed or partial). */
export function todosOf(input: unknown): AgentChatTodo[] | undefined {
  const list = input && typeof input === 'object' ? (input as { todos?: unknown }).todos : undefined
  if (!Array.isArray(list)) return undefined
  return list.filter((t): t is AgentChatTodo => !!t && typeof t === 'object' && typeof t.content === 'string' && TODO_STATUS.has(t.status))
    .map((t) => ({ content: t.content, status: t.status, ...(typeof t.activeForm === 'string' ? { activeForm: t.activeForm } : {}) }))
}

const userText = (m: ChatMessageView): string => m.parts.map((p) => (p.k === 'text' ? p.text : '')).join('')
/** Fallback identity of a user message: its text plus its images' count and types (two image-only messages differ by those). */
const userKey = (m: ChatMessageView): string => `${m.parts.filter((p) => p.k === 'image').map((p) => p.mediaType).join(',')}\n${userText(m)}`
/** A live image whose bytes the server's replay log dropped: the transcript copy can show it by reference. */
const lostImage = (m: ChatMessageView): boolean => m.parts.some((p) => p.k === 'image' && !p.data && !p.ref)

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
      const session = { sessionId: e.sessionId, model: e.model, commands: e.commands, capabilities: e.capabilities, cliVersion: e.cliVersion, cwd: e.cwd }
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
      const todos = e.name === 'TodoWrite' ? todosOf(e.input) : undefined
      return { ...st, tools: { ...st.tools, [e.id]: tool }, ...(todos ? { todos } : {}) }
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
    case 'config':
      return { ...st, config: e.config }
    case 'context':
      return { ...st, context: e.context }
    case 'commandOutput': {
      const known = e.id in st.commandOutputs
      return { ...st, order: known ? st.order : [...st.order, `c:${e.id}`], commandOutputs: { ...st.commandOutputs, [e.id]: { text: e.text } } }
    }
    case 'compact': {
      const known = e.id in st.compacts
      const c = { trigger: e.trigger, ...(e.preTokens !== undefined ? { preTokens: e.preTokens } : {}) }
      return { ...st, order: known ? st.order : [...st.order, `k:${e.id}`], compacts: { ...st.compacts, [e.id]: c } }
    }
    case 'reset': {
      // /clear: a new conversation. Config and mode belong to the node, not the conversation.
      const session = st.session ? { ...st.session, sessionId: e.sessionId } : undefined
      return {
        ...st, order: [], messages: {}, tools: {}, permissions: {}, notices: {}, commandOutputs: {}, compacts: {}, todos: [],
        historyNext: undefined, context: undefined, costUsd: undefined, tokens: undefined, ...(session ? { session } : {}),
      }
    }
    case 'commandsChanged':
      return { ...st, catalogVersion: st.catalogVersion + 1 }
    case 'queued': {
      const m = st.messages[e.messageId]
      return m ? { ...st, messages: { ...st.messages, [e.messageId]: { ...m, queued: e.queued } } } : st
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
      const same = messages[it.messageId]
      // Same id = the live echo of this turn (the server streams its SDK uuid as messageId).
      if (same) { if (it.role === 'user' && lostImage(same)) messages[it.messageId] = { ...same, parts: it.parts }; continue }
      if (Object.values(messages).some((m) => m.absorbed === it.messageId)) continue
      const view: ChatMessageView = { id: it.messageId, role: it.role, parts: it.parts, draft: [], fromHistory: true, ...(it.parentId ? { parentId: it.parentId } : {}) }
      if (it.role === 'user') {
        // Transcripts written before the shared id (or a CLI that ignores the streamed uuid): match by content.
        const key = userKey(view)
        const twin = Object.values(messages).find((m) => m.role === 'user' && !m.fromHistory && !m.absorbed && userKey(m) === key)
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
