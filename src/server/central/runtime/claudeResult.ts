// `result` record parsing for the Claude adapter, split from claudeEvents (Rule 8). Field names
// (`result`.`subtype`/`is_error`/`usage`/`total_cost_usd`/`duration_ms`/`errors`/`result`) follow the
// upstream stream-json docs; the result text of a success is the reply and is never kept here.

export interface ClaudeUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ClaudeResultEvent {
  type: 'result'
  subtype: string
  isError: boolean
  sessionId: string | null
  usage: ClaudeUsage | null
  costUsd: number | null
  durationMs: number | null
  /** Model that did most of the work (`modelUsage` key with the highest cost); null when absent. */
  model: string | null
  /** CLI error text of a failed result (`errors[]` or `result`); never set on success (that text is the reply). */
  errorText: string | null
}

export type Rec = Record<string, unknown>

/** The value as a plain object, else null. */
export function rec(value: unknown): Rec | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null
}
/** The value when it is a string, else null. */
export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Token usage of an `assistant.message` or `result` record (missing or bad counts are 0). */
export function parseUsage(value: unknown): ClaudeUsage | null {
  const u = rec(value)
  if (u === null) return null
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
  }
}

/** The `modelUsage` key with the highest `costUSD` (ties: first); null when there is none. */
export function mainModel(modelUsage: unknown): string | null {
  const m = rec(modelUsage)
  if (m === null) return null
  let best: string | null = null
  let bestCost = -1
  for (const [id, u] of Object.entries(m)) {
    const cost = num(rec(u)?.costUSD)
    if (cost > bestCost) { best = id; bestCost = cost }
  }
  return best
}

/** `error_during_execution` carries `errors: string[]`; an `is_error` success carries the text in `result`. */
function resultErrorText(obj: Rec): string | null {
  const errors = Array.isArray(obj.errors) ? obj.errors.filter((e): e is string => typeof e === 'string') : []
  const text = errors.length > 0 ? errors.join('\n') : str(obj.result)
  return text && text.trim().length > 0 ? text : null
}

/** The `result` record (last line of a turn). */
export function parseClaudeResult(obj: Rec): ClaudeResultEvent {
  return {
    type: 'result', subtype: str(obj.subtype) ?? '', isError: obj.is_error === true,
    sessionId: str(obj.session_id), usage: parseUsage(obj.usage),
    costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
    durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : null,
    model: mainModel(obj.modelUsage),
    errorText: obj.is_error === true || obj.subtype !== 'success' ? resultErrorText(obj) : null,
  }
}
