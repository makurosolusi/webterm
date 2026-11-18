// Evidence parsers: Central ledger messages and Agent Chat SSE events -> the common `Evidence` shape.
// Pure; the shapes mirror src/server/central/conversationModel.ts (MessagePart) and src/shared/agentChat.wire.ts.
import type { Evidence, ToolEvidence, ToolState } from './smoke.capabilities.judge'

const HEAD = 80
const OUTPUT_HEAD = 600
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const CENTRAL_STATE: Record<string, ToolState> = { succeeded: 'ok', failed: 'failed', cancelled: 'failed', awaiting_approval: 'pending' }

/** Central: assistant tool parts (a `denied` receipt outcome is a denial, whatever the card state). */
export function centralEvidence(messages: unknown[]): Evidence {
  const tools: ToolEvidence[] = []
  let text = ''
  for (const m of messages) {
    const msg = rec(m)
    if (msg.role !== 'assistant' || !Array.isArray(msg.parts)) continue
    for (const p of msg.parts) {
      const part = rec(p)
      if (part.type === 'text') text += str(part.text)
      if (part.type !== 'tool') continue
      const result = rec(part.result)
      const denied = result.outcome === 'denied'
      tools.push({
        id: str(part.toolCallId),
        name: str(part.name),
        command: str(rec(part.args).url),
        ...(str(rec(part.args).profile) ? { profile: str(rec(part.args).profile) } : {}),
        state: denied ? 'denied' : (CENTRAL_STATE[str(part.state)] ?? 'failed'),
        code: str(result.detail) === 'ok' ? '' : str(result.detail),
      })
    }
  }
  return { tools, text }
}

/** Chat: last state per tool id, assistant text parts, in event order. */
export function chatEvidence(events: unknown[]): Evidence {
  const byId = new Map<string, ToolEvidence>()
  let text = ''
  for (const e of events) {
    const ev = rec(e)
    if (ev.t === 'tool') {
      const id = str(ev.id)
      const state = str(ev.state)
      byId.set(id, {
        id,
        name: str(ev.name),
        command: str(rec(ev.input).command),
        state: state === 'done' ? 'ok' : state === 'denied' ? 'denied' : state === 'error' ? 'failed' : 'pending',
        code: str(ev.result).replace(/\s+/g, ' ').slice(0, HEAD),
        output: str(ev.result).replace(/\s+/g, ' ').slice(0, OUTPUT_HEAD),
      })
    }
    if (ev.t === 'message' && ev.role === 'assistant' && Array.isArray(ev.parts)) {
      for (const p of ev.parts) if (rec(p).k === 'text') text += `${str(rec(p).text)}\n`
    }
  }
  return { tools: [...byId.values()], text }
}

/** Failures worth one retry: transport/upstream trouble, never a behavior verdict. */
export function isNetworkFailure(detail: string): boolean {
  return /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network|overloaded|\b(502|503|504|529)\b|rate.?limit/i.test(detail)
}
