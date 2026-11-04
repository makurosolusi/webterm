// Token usage out of a Claude Code transcript (`~/.claude/projects/<slug>/<session>.jsonl`). Each
// assistant line carries `message.id`, `message.model` and `message.usage`; one response spans
// several lines (one per content block) with the same id and usage, so entries are keyed by id.
import type { TokenUsage } from './costPricing'

export interface TranscriptUsage extends TokenUsage {
  /** Anthropic message id (`msg_...`), the dedupe key across re-reads. */
  messageId: string
  model: string
  sessionId: string | null
  ts: number
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0)
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** Usage of one JSONL line, or null for non-assistant / synthetic / malformed lines. */
export function parseUsageLine(line: string): TranscriptUsage | null {
  if (!line.includes('"usage"')) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(line) as Record<string, unknown> } catch { return null }
  if (o.type !== 'assistant') return null
  const m = o.message as Record<string, unknown> | undefined
  const u = m?.usage as Record<string, unknown> | undefined
  const messageId = text(m?.id)
  const model = text(m?.model)
  // `<synthetic>` = a message Claude Code made up locally (e.g. an interrupt); nothing was billed.
  if (!u || !messageId || !model || model === '<synthetic>') return null
  const split = u.cache_creation as Record<string, unknown> | undefined
  const total = count(u.cache_creation_input_tokens)
  // Older transcripts have no TTL split: the whole write is the 5m default.
  const write1h = split ? count(split.ephemeral_1h_input_tokens) : 0
  const write5m = split ? count(split.ephemeral_5m_input_tokens) : total
  const ts = Date.parse(String(o.timestamp ?? ''))
  return {
    messageId, model, sessionId: text(o.sessionId), ts: Number.isFinite(ts) ? ts : 0,
    input: count(u.input_tokens), output: count(u.output_tokens), cacheRead: count(u.cache_read_input_tokens),
    write5m, write1h, speed: text(u.speed), geo: text(u.inference_geo),
  }
}

/** All responses in `chunk` (complete lines only), last line per message id wins. */
export function parseTranscriptUsage(chunk: string): TranscriptUsage[] {
  const byId = new Map<string, TranscriptUsage>()
  for (const line of chunk.split('\n')) {
    const entry = parseUsageLine(line)
    if (entry) byId.set(entry.messageId, entry)
  }
  return [...byId.values()]
}
