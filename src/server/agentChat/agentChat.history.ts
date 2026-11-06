// Transcript history of an agent chat node (PLAN/AGENT-CHAT.md D6): the session's JSONL read through
// the SDK `getSessionMessages()`, mapped by the live mapper into `message` / `tool` bodies, so history
// and live events render the same. Paged newest-first by item index; full tool results on demand.
import { getSessionMessages, type SDKMessage, type SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_CHAT_IMAGE_TYPES, type AgentChatEventBody, type AgentChatImage, type AgentChatPart } from '../../shared/agentChat.wire'
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

interface Block { type?: string; text?: unknown; tool_use_id?: unknown; content?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } }

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

/** The base64 image of a user block, if it is one the client may render. */
function imageOf(b: Block | undefined): AgentChatImage | undefined {
  const src = b?.type === 'image' ? b.source : undefined
  if (src?.type !== 'base64' || typeof src.data !== 'string' || typeof src.media_type !== 'string' || !AGENT_CHAT_IMAGE_TYPES.includes(src.media_type)) return undefined
  return { mediaType: src.media_type, data: src.data }
}

/** Image parts of a user message, by reference (`<uuid>:<block index>`): a page never carries image bytes. */
function userImages(m: SessionMessage): AgentChatPart[] {
  return blocksOf(m).flatMap((b, i) => { const img = imageOf(b); return img ? [{ k: 'image' as const, mediaType: img.mediaType, ref: `${m.uuid}:${i}` }] : [] })
}

/** The image a `ref` of `userImages` names; undefined = no such image in the transcript. */
export function transcriptImage(msgs: SessionMessage[], ref: string): AgentChatImage | undefined {
  const sep = ref.lastIndexOf(':')
  const uuid = ref.slice(0, sep)
  const index = Number(ref.slice(sep + 1))
  if (sep < 1 || !Number.isSafeInteger(index)) return undefined
  const m = msgs.find((x) => x.type === 'user' && x.uuid === uuid)
  return m ? imageOf(blocksOf(m)[index]) : undefined
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
      const images = userImages(m)
      if ((text || images.length) && !text.startsWith(INTERRUPT_MARKER)) {
        put(`u:${m.uuid}`, { t: 'message', messageId: m.uuid, role: 'user', parts: [...images, ...(text ? [{ k: 'text' as const, text }] : [])] })
      }
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
