// stream-json parsing and event mapping for the Claude adapter (PLAN CENTRAL-RUNTIME-b 1.2).
//
// [BT] Every field name below (`system/init`.`tools`/`mcp_servers`/`session_id`,
// `stream_event`.`event`.`delta`.`text`, `assistant`.`message`.`id`/`content`/`usage`/`error`,
// `result`.`subtype`/`is_error`/`usage`/`total_cost_usd`/`duration_ms`) comes from the upstream
// docs, not from a recording. They stay unconfirmed until GATE-S; unknown shapes are ignored
// and the init check fails closed. Prompt text and model output are never logged here.
import type { TurnEmitter } from './runtimeEvents'
import { type ClaudeTurnState, failTurn } from './claudeSession'

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
}

export type ClaudeEvent =
  | { type: 'init'; sessionId: string | null; toolCount: number }
  | { type: 'delta'; text: string }
  | { type: 'assistant'; messageId: string | null; text: string; toolUse: boolean; error: string | null; usage: ClaudeUsage | null }
  | { type: 'retry' }
  | ClaudeResultEvent

type Rec = Record<string, unknown>

function rec(value: unknown): Rec | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null
}
function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function parseUsage(value: unknown): ClaudeUsage | null {
  const u = rec(value)
  if (u === null) return null
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
  }
}

function countItems(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function parseAssistant(obj: Rec): ClaudeEvent {
  const message = rec(obj.message)
  const content = Array.isArray(message?.content) ? message.content : []
  let text = ''
  let toolUse = false
  for (const block of content) {
    const b = rec(block)
    if (b?.type === 'text' && typeof b.text === 'string') text += b.text
    else if (b?.type === 'tool_use') toolUse = true
  }
  return {
    type: 'assistant', messageId: str(message?.id), text, toolUse,
    error: str(obj.error), usage: parseUsage(message?.usage),
  }
}

/** Parses one stdout line; non-JSON or unknown shapes yield null (they are ignored by design). */
export function parseClaudeLine(line: string): ClaudeEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    // CLI banners or truncated lines are not events; dropping them is the documented behaviour.
    return null
  }
  const obj = rec(raw)
  if (obj === null) return null
  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init') {
        return { type: 'init', sessionId: str(obj.session_id), toolCount: countItems(obj.tools) + countItems(obj.mcp_servers) }
      }
      return obj.subtype === 'api_retry' ? { type: 'retry' } : null
    case 'stream_event': {
      const event = rec(obj.event)
      const delta = rec(event?.delta)
      if (event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
        return { type: 'delta', text: delta.text }
      }
      return null
    }
    case 'assistant':
      return parseAssistant(obj)
    case 'result':
      return {
        type: 'result', subtype: str(obj.subtype) ?? '', isError: obj.is_error === true,
        sessionId: str(obj.session_id), usage: parseUsage(obj.usage),
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
        durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : null,
      }
    default:
      return null
  }
}

export interface ApplyContext {
  emitter: TurnEmitter
  state: ClaudeTurnState
  maxTurns: number
  maxTokens?: number
  /** Starts the kill ladder on the child. */
  kill: () => void
}

const RETRYABLE_ASSISTANT_ERRORS: ReadonlySet<string> = new Set(['rate_limit', 'overloaded', 'server_error'])

function checkLimits(ctx: ApplyContext): void {
  const { state } = ctx
  if (state.messages.size > ctx.maxTurns) {
    failTurn(ctx.emitter, state, { code: 'max_turns' })
    ctx.kill()
    return
  }
  if (ctx.maxTokens === undefined) return
  let tokens = 0
  for (const usage of state.messages.values()) tokens += usage.inputTokens + usage.outputTokens
  if (tokens > ctx.maxTokens) {
    failTurn(ctx.emitter, state, { code: 'budget_exhausted' })
    ctx.kill()
  }
}

function applyAssistant(event: Extract<ClaudeEvent, { type: 'assistant' }>, ctx: ApplyContext): void {
  const { emitter, state } = ctx
  if (event.toolUse) {
    failTurn(emitter, state, { code: 'unknown_tool' })
    ctx.kill()
    return
  }
  if (event.error !== null) {
    // The error text arrives as assistant content; it must not become reply text.
    if (event.error === 'authentication_failed') {
      failTurn(emitter, state, { code: 'runtime_unavailable', unavailable: 'claude_not_authenticated' })
    } else {
      failTurn(emitter, state, { code: 'runtime_error', retryable: RETRYABLE_ASSISTANT_ERRORS.has(event.error) })
    }
    return
  }
  if (event.messageId !== null && event.usage !== null) state.messages.set(event.messageId, event.usage)
  else if (event.messageId !== null && !state.messages.has(event.messageId)) {
    state.messages.set(event.messageId, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  }
  // Partial mode already streamed this text; only use the full block when no delta was seen.
  if (!state.sawDelta && event.text.length > 0) {
    emitter.textDelta(event.text)
    state.sawDelta = true
  }
  checkLimits(ctx)
}

/** Maps one parsed event onto the turn emitter and per-turn state. */
export function applyClaudeEvent(event: ClaudeEvent, ctx: ApplyContext): void {
  const { emitter, state } = ctx
  switch (event.type) {
    case 'init':
      if (event.sessionId !== null) state.sessionRef = event.sessionId
      if (event.toolCount > 0) {
        failTurn(emitter, state, { code: 'runtime_error' })
        ctx.kill()
      }
      return
    case 'delta':
      state.sawDelta = true
      emitter.textDelta(event.text)
      return
    case 'assistant':
      applyAssistant(event, ctx)
      return
    case 'retry':
      state.retries += 1
      return
    case 'result':
      state.result = event
      if (event.sessionId !== null) state.sessionRef = event.sessionId
      return
  }
}
