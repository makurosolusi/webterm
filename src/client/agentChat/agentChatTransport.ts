// HTTP + SSE client of one agent chat node (`/api/agent-chat/:nodeId/<verb>`, see
// src/server/agentChat/agentChat.route.ts). Reuses the Central chat plumbing: the cookie-carrying
// `requestJson`, its `ChatApiError`, and the SSE opener with cursor + backoff.
import { ChatApiError, chatErrorMessage, isAbortError, requestJson } from '../chat/chatTransport'
import { openSseStream } from '../chat/chatStream'
import type { ChatEventSource, ChatStream, ChatStreamStatus } from '../chat/chatTypes'
import type { AgentChatCommand, AgentChatConfig, AgentChatEvent, AgentChatImage, AgentChatModel, AgentChatPermissionAnswer, AgentChatSessionSummary } from '../../shared/agentChat.wire'
import type { AgentPermissionMode } from '../../shared/workspace.capabilities'
import type { HistoryItem } from './agentChatStore'

export const AGENT_CHAT_PATH = '/api/agent-chat'
/** Mirrors `AGENT_CHAT_SSE_EVENT` in src/server/agentChat/agentChat.route.ts (server module, not importable here). */
export const AGENT_CHAT_SSE_EVENT = 'agent-chat'
/** Items per history page ("Load earlier"). */
export const AGENT_CHAT_HISTORY_PAGE = 50

const EVENT_TYPES = new Set<string>(['status', 'init', 'delta', 'message', 'tool', 'permission', 'permissionResolved', 'result', 'notice', 'mode',
  'config', 'context', 'commandOutput', 'compact', 'reset', 'commandsChanged', 'queued'])

export type AgentChatOperation = 'send' | 'interrupt' | 'permission' | 'mode' | 'history' | 'tool result' | 'upload'
  | 'catalog' | 'models' | 'config' | 'sessions' | 'resume' | 'new conversation'

/** A failed agent chat request: `message` is user-facing; operation, node and status are for code. */
export class AgentChatApiError extends ChatApiError {
  readonly operation: AgentChatOperation
  readonly nodeId: string

  constructor(operation: AgentChatOperation, nodeId: string, status: number, code: string, message: string) {
    super(message, status, code)
    this.name = 'AgentChatApiError'
    this.operation = operation
    this.nodeId = nodeId
  }
}

/** Short user text for one failed request; never echoes a response body. */
export function agentChatErrorMessage(op: AgentChatOperation, error: unknown): string {
  if (!(error instanceof ChatApiError)) return chatErrorMessage(error)
  const s = error.status
  if (s === 401 || s === 403) return 'Not allowed. Reload and sign in again.'
  if (s === 404) return op === 'tool result' ? 'The full output is not in the transcript.' : 'This chat is not on the server yet. Wait for the board to save, then retry.'
  if (s === 409 && error.code === 'busy') return 'Claude is working in this chat. Stop the turn or wait for it to end, then try again.'
  if (s === 409 && op === 'resume') return 'That conversation is open in another chat node. Close it there first.'
  if (s === 409 && (op === 'catalog' || op === 'models')) return 'Too many Claude sessions are open. Send a message or close another chat to load this list.'
  if (s === 503 && (op === 'catalog' || op === 'models')) return 'Claude could not start to list these. Showing built-in commands only.'
  if (s === 400 && op === 'config') return 'That model or effort level is not available.'
  if (s === 409 && op === 'send') return 'This Claude session is open somewhere else. See the notice in the chat.'
  if (s === 409 && op === 'permission') return 'This request was already answered or has expired.'
  if (s === 413) return op === 'upload' ? 'The file is over the upload limit.' : 'The request is too large.'
  if (s === 400 && op === 'send') return 'The message could not be sent (empty, too long, or an image was refused).'
  if (s >= 500) return 'The server could not answer. Try again.'
  return `The ${op} request failed. Try again.`
}

export interface AgentChatHistoryPage { items: HistoryItem[]; next: number | null }

export interface AgentChatStreamOptions {
  after: number
  onEvent: (e: AgentChatEvent) => void
  onStatus: (s: ChatStreamStatus) => void
}

/** Everything the view needs from the server; tests pass a fake. */
export interface AgentChatTransport {
  stream(opts: AgentChatStreamOptions): ChatStream
  send(text: string, priority?: 'now' | 'next', images?: AgentChatImage[]): Promise<void>
  /** Stage a non-image file on the server; resolves to its absolute path there. */
  upload(file: File, name: string): Promise<string>
  /** URL of a transcript image (`ref` of a history `image` part). */
  imageUrl(ref: string): string
  interrupt(): Promise<void>
  answer(a: AgentChatPermissionAnswer): Promise<void>
  setMode(mode: AgentPermissionMode): Promise<void>
  history(q: { before?: number; limit?: number }, signal?: AbortSignal): Promise<AgentChatHistoryPage>
  toolResult(toolUseId: string): Promise<string>
  /** Slash commands of the "/" menu (built-ins, skills, custom and MCP prompts). */
  catalog(): Promise<AgentChatCommand[]>
  models(): Promise<AgentChatModel[]>
  /** Change model / effort / thinking; the server answers with a `config` event. */
  setConfig(patch: Partial<AgentChatConfig>): Promise<void>
  /** Past conversations of this node's working directory, newest first. */
  sessions(): Promise<AgentChatSessionSummary[]>
  /** Switch this node to a past conversation. */
  resume(sessionId: string): Promise<void>
  /** Start a fresh conversation (the old one stays resumable). */
  newConversation(): Promise<void>
}

/** One SSE frame -> event; null for anything malformed or of an unknown kind (newer server). */
export function parseAgentChatFrame(data: string): AgentChatEvent | null {
  let v: unknown
  try {
    v = JSON.parse(data)
  } catch (err) {
    if (err instanceof SyntaxError) return null
    throw err
  }
  if (!v || typeof v !== 'object') return null
  const e = v as { seq?: unknown; t?: unknown }
  if (typeof e.seq !== 'number' || !Number.isSafeInteger(e.seq) || typeof e.t !== 'string' || !EVENT_TYPES.has(e.t)) return null
  return v as AgentChatEvent
}

function historyPage(body: unknown): AgentChatHistoryPage {
  const b = body && typeof body === 'object' ? (body as { items?: unknown; next?: unknown }) : {}
  const items = Array.isArray(b.items) ? (b.items as HistoryItem[]).filter((i) => i && typeof i === 'object' && typeof i.t === 'string' && typeof i.cursor === 'number') : []
  return { items, next: typeof b.next === 'number' ? b.next : null }
}

const listOf = <T>(body: unknown, key: string, ok: (v: Record<string, unknown>) => boolean): T[] => {
  const list = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined
  return Array.isArray(list) ? (list.filter((v) => v && typeof v === 'object' && ok(v)) as T[]) : []
}

export function createAgentChatTransport(nodeId: string, createSource?: (url: string) => ChatEventSource): AgentChatTransport {
  const base = `${AGENT_CHAT_PATH}/${encodeURIComponent(nodeId)}`
  async function call<T>(op: AgentChatOperation, path: string, init: RequestInit = {}): Promise<T> {
    try {
      return await requestJson<T>(`${base}/${path}`, init)
    } catch (err) {
      if (isAbortError(err)) throw err
      const status = err instanceof ChatApiError ? err.status : 0
      const code = err instanceof ChatApiError ? err.code : 'network'
      throw new AgentChatApiError(op, nodeId, status, code, agentChatErrorMessage(op, err))
    }
  }
  const post = (op: AgentChatOperation, verb: string, body: unknown): Promise<void> =>
    call<unknown>(op, verb, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(() => undefined)

  return {
    stream: (opts) => openSseStream<AgentChatEvent>({
      path: `${base}/stream`,
      eventTypes: [AGENT_CHAT_SSE_EVENT],
      parse: (_type, data) => parseAgentChatFrame(data),
      reapply: (e) => e.t === 'init' || e.t === 'permission',
    }, { ...opts, ...(createSource ? { createSource } : {}) }),
    send: (text, priority, images) => post('send', 'send', { text, ...(priority ? { priority } : {}), ...(images?.length ? { images } : {}) }),
    upload: async (file, name) => {
      const body = await call<{ path?: unknown }>('upload', `upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
      if (typeof body?.path !== 'string') throw new AgentChatApiError('upload', nodeId, 502, 'bad_response', `The server did not return a path for ${name}.`)
      return body.path
    },
    imageUrl: (ref) => `${base}/history?image=${encodeURIComponent(ref)}`,
    interrupt: () => post('interrupt', 'interrupt', {}),
    answer: (a) => post('permission', 'permission', a),
    setMode: (mode) => post('mode', 'mode', { mode }),
    history: async (q, signal) => {
      const query = new URLSearchParams()
      if (q.before !== undefined) query.set('before', String(q.before))
      query.set('limit', String(q.limit ?? AGENT_CHAT_HISTORY_PAGE))
      return historyPage(await call<unknown>('history', `history?${query}`, { signal }))
    },
    toolResult: async (toolUseId) => {
      const body = await call<{ result?: unknown }>('tool result', `history?tool=${encodeURIComponent(toolUseId)}`)
      return typeof body?.result === 'string' ? body.result : ''
    },
    catalog: async () => listOf<AgentChatCommand>(await call<unknown>('catalog', 'catalog'), 'commands', (c) => typeof c.name === 'string'),
    models: async () => listOf<AgentChatModel>(await call<unknown>('models', 'models'), 'models', (m) => typeof m.value === 'string'),
    setConfig: (patch) => post('config', 'config', patch),
    sessions: async () => listOf<AgentChatSessionSummary>(await call<unknown>('sessions', 'sessions'), 'sessions', (x) => typeof x.sessionId === 'string'),
    resume: (sessionId) => post('resume', 'resume', { sessionId }),
    newConversation: () => post('new conversation', 'new', {}),
  }
}
