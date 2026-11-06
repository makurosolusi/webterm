// Transcript history of an agent chat node (PLAN/AGENT-CHAT.md D6): the session's JSONL read through
// the SDK `getSessionMessages()`, mapped by the live mapper into `message` / `tool` bodies, so history
// and live events render the same. Paged newest-first by item index; full tool results on demand.
import { getSessionMessages, type SDKMessage, type SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentChatEventBody } from '../../shared/agentChat.wire'
import { createAgentChatMapper, resultText } from './agentChat.events'

export const AGENT_CHAT_HISTORY_DEFAULT_LIMIT = 50
export const AGENT_CHAT_HISTORY_MAX_LIMIT = 200
export const AGENT_CHAT_RESTART_NOTICE = 'Interrupted by server restart'
/** The CLI's own marker for a user interrupt (a turn cut on purpose, not by a restart). */
const INTERRUPT_MARKER = '[Request interrupted'

/** Transcript reader; production searches every project dir (no `dir`: a symlinked cwd would not match). */
export type LoadTranscript = (sessionId: string) => Promise<SessionMessage[]>
export const loadTranscript: LoadTranscript = (sessionId) => getSessionMessages(sessionId)

export type AgentChatHistoryItem = AgentChatEventBody & { cursor: number }
export interface AgentChatHistoryPage { items: AgentChatHistoryItem[]; next: number | null }

interface Block { type?: string; text?: unknown; tool_use_id?: unknown; content?: unknown }

const contentOf = (m: SessionMessage): unknown => (m.message as { content?: unknown } | null)?.content
const blocksOf = (m: SessionMessage): Block[] => {
  const c = contentOf(m)
  return Array.isArray(c) ? (c as Block[]) : []
}

/** Text the user typed (string content or text blocks); '' for tool results. */
function userText(m: SessionMessage): string {
  const c = contentOf(m)
  if (typeof c === 'string') return c
  return blocksOf(m).map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
}

/** Every transcript message as one item per message id / tool id, in first-seen order. */
export function historyItems(msgs: SessionMessage[]): AgentChatEventBody[] {
  const mapper = createAgentChatMapper()
  const out: AgentChatEventBody[] = []
  const at = new Map<string, number>()
  const put = (key: string, body: AgentChatEventBody): void => {
    const i = at.get(key)
    if (i === undefined) { at.set(key, out.length); out.push(body) } else out[i] = body
  }
  for (const m of msgs) {
    if (m.type === 'user') {
      const text = userText(m)
      if (text && !text.startsWith(INTERRUPT_MARKER)) put(`u:${m.uuid}`, { t: 'message', messageId: m.uuid, role: 'user', parts: [{ k: 'text', text }] })
    }
    // A SessionMessage carries the SDK message fields the mapper reads (type, message, parent_tool_use_id).
    for (const e of mapper.map(m as unknown as SDKMessage)) {
      if (e.t === 'message') put(`m:${e.messageId}`, e)
      else if (e.t === 'tool') put(`t:${e.id}`, e)
    }
  }
  return out
}

/** The transcript ends mid-turn: a prompt or tool result with no reply, or a tool call with no result. */
export function cutMidTurn(msgs: SessionMessage[]): boolean {
  const last = msgs.findLast((m) => m.type !== 'system')
  if (!last) return false
  if (last.type === 'user') return !userText(last).startsWith(INTERRUPT_MARKER)
  return blocksOf(last).at(-1)?.type === 'tool_use'
}

export interface HistoryQuery {
  before?: number
  limit?: number
  /** A live turn runs right now: an open-ended transcript is not a restart cut. */
  busy: boolean
}

/** One page of items before `before` (exclusive); `next` = cursor of the older page, null at the start. */
export function historyPage(msgs: SessionMessage[], q: HistoryQuery): AgentChatHistoryPage {
  const all: AgentChatHistoryItem[] = historyItems(msgs).map((e, cursor) => ({ ...e, cursor }))
  const newest = q.before === undefined
  if (newest && !q.busy && cutMidTurn(msgs)) all.push({ t: 'notice', level: 'warn', text: AGENT_CHAT_RESTART_NOTICE, cursor: all.length })
  const end = Math.min(q.before ?? all.length, all.length)
  const limit = Math.min(Math.max(1, q.limit ?? AGENT_CHAT_HISTORY_DEFAULT_LIMIT), AGENT_CHAT_HISTORY_MAX_LIMIT)
  const start = Math.max(0, end - limit)
  return { items: all.slice(start, end), next: start > 0 ? start : null }
}

/** Full, untruncated text of one tool result; undefined = no such result in the transcript. */
export function toolResultText(msgs: SessionMessage[], toolUseId: string): string | undefined {
  for (const m of msgs) {
    if (m.type !== 'user') continue
    const b = blocksOf(m).find((x) => x.type === 'tool_result' && x.tool_use_id === toolUseId)
    if (b) return resultText(b.content)
  }
  return undefined
}
