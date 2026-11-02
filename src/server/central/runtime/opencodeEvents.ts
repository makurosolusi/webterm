// Incremental parser for `opencode run --format json` stdout (RND/13 §3 B2).
// OpenCode emits one JSON object per line; this module turns those records into
// transport-neutral events. It never logs and never touches the child process.
//
// Observed record shapes (v2):
//   { type: 'step_start' | 'step_finish', sessionID, part: {...} }
//   { type: 'text', sessionID, part: { id, text } }
//   { type: 'tool_use', sessionID, part: { callID, tool, state: {...} } }
//   { type: 'error', error: { name, data: { message } } }

export interface OpencodeUsageDelta {
  inputTokens: number
  /** Reasoning tokens are generation tokens; folded into output below. */
  reasoningTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Micro-USD, 0 when the CLI omits a cost. */
  costMicros: number
}

export type OpencodeEvent =
  | { type: 'text'; text: string }
  | { type: 'tool.requested'; toolCallId: string; name: string; input: unknown }
  | {
      type: 'tool.completed'
      toolCallId: string
      name: string
      ok: boolean
      output?: unknown
      errorCode?: string
    }
  | { type: 'usage'; usage: OpencodeUsageDelta }
  | { type: 'error'; code: 'runtime_error'; message: string }

export interface OpencodeStreamParser {
  /** Latest `sessionID` seen; used for resume and `turn.result.sessionRef`. */
  readonly sessionRef: string | null
  /** Feed a raw stdout chunk; returns the events completed by it. */
  push(chunk: string): OpencodeEvent[]
  /** Flush a trailing line without a newline. */
  end(): OpencodeEvent[]
}

/** A single JSONL line larger than this is treated as garbage and skipped. */
const MAX_LINE_CHARS = 4 * 1024 * 1024
const DEFAULT_TOOL_NAME = 'unknown'

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = asString(value)
    if (text !== null) return text
  }
  return null
}

function usageFrom(record: JsonObject, part: JsonObject): OpencodeUsageDelta | null {
  const tokens = asObject(part['tokens']) ?? asObject(record['tokens'])
  if (tokens === null) return null
  const cache = asObject(tokens['cache']) ?? {}
  const costUsd = typeof part['cost'] === 'number' ? part['cost'] : record['cost']
  return {
    inputTokens: asNumber(tokens['input']),
    reasoningTokens: asNumber(tokens['reasoning']),
    outputTokens: asNumber(tokens['output']),
    cacheReadTokens: asNumber(cache['read'] ?? tokens['cache_read']),
    cacheWriteTokens: asNumber(cache['write'] ?? tokens['cache_write']),
    costMicros: Math.round(asNumber(costUsd) * 1_000_000),
  }
}

function toolEvents(record: JsonObject, part: JsonObject, fallbackId: string): OpencodeEvent[] {
  const state = asObject(part['state']) ?? {}
  const metadata = asObject(state['metadata']) ?? {}
  const toolCallId = firstString(part['callID'], part['id'], record['id'], part['callId']) ?? fallbackId
  const name = firstString(part['tool'], part['name'], record['tool']) ?? DEFAULT_TOOL_NAME
  const input = state['input'] ?? part['input'] ?? {}
  const status = (firstString(state['status'], part['status']) ?? 'completed').toLowerCase()
  const requested: OpencodeEvent = { type: 'tool.requested', toolCallId, name, input }
  if (status === 'running' || status === 'pending' || status === 'started') return [requested]
  const ok = status === 'completed' || status === 'success' || status === 'done'
  const output = state['output'] ?? metadata['output'] ?? part['output']
  return [
    requested,
    {
      type: 'tool.completed',
      toolCallId,
      name,
      ok,
      ...(output === undefined ? {} : { output }),
      ...(ok ? {} : { errorCode: 'tool_failed' }),
    },
  ]
}

/** Map one decoded JSONL record; unknown/irrelevant records produce nothing. */
export function mapOpencodeRecord(record: unknown, fallbackToolId = 'opencode-tool'): OpencodeEvent[] {
  const root = asObject(record)
  if (root === null) return []
  const part = asObject(root['part']) ?? {}
  const type = firstString(root['type'])
  if (type === null) return []
  switch (type) {
    case 'text': {
      const text = typeof part['text'] === 'string' ? part['text'] : null
      return text !== null && text.length > 0 ? [{ type: 'text', text }] : []
    }
    case 'tool_use':
    case 'tool':
      return toolEvents(root, part, fallbackToolId)
    case 'step_finish': {
      const usage = usageFrom(root, part)
      return usage === null ? [] : [{ type: 'usage', usage }]
    }
    case 'error': {
      const error = asObject(root['error']) ?? {}
      const data = asObject(error['data']) ?? {}
      const message =
        firstString(data['message'], error['message'], root['message']) ?? 'opencode reported an error'
      return [{ type: 'error', code: 'runtime_error', message }]
    }
    default:
      return []
  }
}

/** Stateful JSONL splitter; IDs are deterministic per parser instance. */
export function createOpencodeStreamParser(): OpencodeStreamParser {
  let buffer = ''
  let sessionRef: string | null = null
  let skippingOversize = false
  let toolSeq = 0
  const seenTextParts = new Set<string>()
  const seenCompletedTools = new Set<string>()

  function handleLine(line: string): OpencodeEvent[] {
    if (line.length > MAX_LINE_CHARS) return []
    const trimmed = line.trim()
    if (trimmed.length === 0) return []
    let decoded: unknown
    try {
      decoded = JSON.parse(trimmed)
    } catch {
      return []
    }
    const root = asObject(decoded)
    if (root === null) return []
    const session = firstString(root['sessionID'], root['sessionId'])
    if (session !== null) sessionRef = session

    const part = asObject(root['part']) ?? {}
    const partId = firstString(part['id'])
    if (firstString(root['type']) === 'text' && partId !== null) {
      if (seenTextParts.has(partId)) return []
      seenTextParts.add(partId)
    }
    const events = mapOpencodeRecord(decoded, `opencode-tool-${++toolSeq}`)
    return events.filter((event) => {
      if (event.type !== 'tool.completed') return true
      const key = `${event.toolCallId}:${event.ok ? 'ok' : 'fail'}`
      if (seenCompletedTools.has(key)) return false
      seenCompletedTools.add(key)
      return true
    })
  }

  function drain(final: boolean): OpencodeEvent[] {
    const events: OpencodeEvent[] = []
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      events.push(...handleLine(line))
      newline = buffer.indexOf('\n')
    }
    if (skippingOversize) {
      // The tail of an oversized line has no newline left; drop it entirely.
      buffer = ''
      skippingOversize = false
    }
    if (buffer.length > MAX_LINE_CHARS) {
      buffer = ''
      skippingOversize = true
    }
    if (final && buffer.length > 0) {
      events.push(...handleLine(buffer))
      buffer = ''
    }
    return events
  }

  return {
    get sessionRef() {
      return sessionRef
    },
    push(chunk: string): OpencodeEvent[] {
      if (typeof chunk !== 'string' || chunk.length === 0) return []
      buffer += chunk
      return drain(false)
    },
    end(): OpencodeEvent[] {
      return drain(true)
    },
  }
}
