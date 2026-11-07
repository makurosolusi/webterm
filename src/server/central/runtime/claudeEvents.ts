// stream-json parsing and event mapping for the Claude adapter (PLAN CENTRAL-RUNTIME-b 1.2).
//
// [BT] Every field name below (`system/init`.`tools`/`mcp_servers`/`session_id`,
// `stream_event`.`event`.`delta`.`text`, `assistant`.`message`.`id`/`content`/`usage`/`error`,
// `result`.`subtype`/`is_error`/`usage`/`total_cost_usd`/`duration_ms`) comes from the upstream
// docs, not from a recording. They stay unconfirmed until GATE-S; unknown shapes are ignored
// and the init check fails closed. Prompt text and model output are never logged here.
// MCP tool calls (PLAN F2-c): `assistant` content `tool_use {id,name,input}` and the following `user`
// content `tool_result {tool_use_id, content, is_error}` were checked against a real Claude Code 2.1.318
// stream-json run (2026-11-04). Only `mcp__webterm__*` tools may appear; anything else fails closed.
import type { TurnEmitter } from './runtimeEvents'
import { type ClaudeTurnState, failTurn } from './claudeSession'
import { MCP_SERVER_NAME } from '../../mcp/mcp.paths'
import { WEBTERM_MCP_TOOL_PREFIX } from './claudeOptions'
import { stderrReason } from './opencodeSession'
import { type ClaudeResultEvent, type ClaudeUsage, type Rec, parseClaudeResult, parseUsage, rec, str } from './claudeResult'

export interface ClaudeToolUse { id: string; name: string; input: unknown }
export interface ClaudeToolResult { toolUseId: string; isError: boolean; text: string }

export type ClaudeEvent =
  | { type: 'init'; sessionId: string | null; tools: string[]; servers: string[] }
  | { type: 'delta'; text: string }
  | { type: 'assistant'; messageId: string | null; text: string; toolUses: ClaudeToolUse[]; error: string | null; usage: ClaudeUsage | null }
  | { type: 'tool_results'; results: ClaudeToolResult[] }
  | { type: 'retry' }
  | ClaudeResultEvent

/** Names of an init list whose items are strings or `{name}` objects (tools are strings, servers objects). */
function names(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => (typeof item === 'string' ? item : str(rec(item)?.name) ?? ''))
}

function parseAssistant(obj: Rec): ClaudeEvent {
  const message = rec(obj.message)
  const content = Array.isArray(message?.content) ? message.content : []
  let text = ''
  const toolUses: ClaudeToolUse[] = []
  for (const block of content) {
    const b = rec(block)
    if (b?.type === 'text' && typeof b.text === 'string') text += b.text
    // A tool_use without a usable id/name still counts: an empty name fails the allowlist closed.
    else if (b?.type === 'tool_use') toolUses.push({ id: str(b.id) ?? '', name: str(b.name) ?? '', input: b.input ?? null })
  }
  return {
    type: 'assistant', messageId: str(message?.id), text, toolUses,
    error: str(obj.error), usage: parseUsage(message?.usage),
  }
}

/** `tool_result.content` is a string or a list of `{type:'text', text}` blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (rec(part)?.type === 'text' ? str(rec(part)?.text) ?? '' : '')).join('')
}

function parseUser(obj: Rec): ClaudeEvent | null {
  const content = rec(obj.message)?.content
  if (!Array.isArray(content)) return null
  const results: ClaudeToolResult[] = []
  for (const block of content) {
    const b = rec(block)
    if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
    results.push({ toolUseId: b.tool_use_id, isError: b.is_error === true, text: resultText(b.content) })
  }
  return results.length > 0 ? { type: 'tool_results', results } : null
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
        return { type: 'init', sessionId: str(obj.session_id), tools: names(obj.tools), servers: names(obj.mcp_servers) }
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
    case 'user':
      return parseUser(obj)
    case 'result':
      return parseClaudeResult(obj)
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
  /** Clock for tool durations; defaults to `Date.now`. */
  now?: () => number
}

const isWebtermTool = (name: string): boolean => name.startsWith(WEBTERM_MCP_TOOL_PREFIX) && name.length > WEBTERM_MCP_TOOL_PREFIX.length
/** Chat-facing tool name: the MCP server prefix is noise to a human. */
const shortName = (name: string): string => name.slice(WEBTERM_MCP_TOOL_PREFIX.length)

/** Receipt JSON the webterm MCP server put in the result text; anything else is wrapped as plain text. */
function receiptOf(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // Claude Code's own failure text (e.g. "permission denied") is not JSON; it becomes the detail below.
  }
  return { outcome: 'error', detail: 'tool_failed', text }
}

/** Announces each new `mcp__webterm__*` call; any other tool name fails the turn closed. */
function applyToolUses(uses: readonly ClaudeToolUse[], ctx: ApplyContext): boolean {
  const { emitter, state } = ctx
  for (const use of uses) {
    if (!isWebtermTool(use.name) || use.id === '') {
      failTurn(emitter, state, { code: 'unknown_tool' })
      ctx.kill()
      return false
    }
    if (state.seenTools.has(use.id)) continue
    state.seenTools.add(use.id)
    state.openTools.set(use.id, { name: shortName(use.name), at: (ctx.now ?? Date.now)() })
    emitter.emit({ type: 'tool.requested', toolCallId: use.id, name: shortName(use.name), input: use.input })
  }
  return true
}

/** Each answered call becomes a receipt in the chat (`tool.completed`); unknown ids are ignored. */
function applyToolResults(results: readonly ClaudeToolResult[], ctx: ApplyContext): void {
  for (const r of results) {
    const open = ctx.state.openTools.get(r.toolUseId)
    if (!open) continue
    ctx.state.openTools.delete(r.toolUseId)
    const receipt = receiptOf(r.text)
    const ok = !r.isError && receipt.outcome === 'ok'
    const detail = typeof receipt.detail === 'string' ? receipt.detail : 'tool_failed'
    ctx.emitter.emit({
      type: 'tool.completed', toolCallId: r.toolUseId, name: open.name, ok, output: receipt,
      ...(ok ? {} : { errorCode: detail }), durationMs: Math.max(0, (ctx.now ?? Date.now)() - open.at),
    })
  }
}

/** Init must show the webterm MCP server and its tools only (no built-ins, no foreign server). */
function initAllowed(event: Extract<ClaudeEvent, { type: 'init' }>): boolean {
  return event.tools.every(isWebtermTool) && event.servers.every((name) => name === MCP_SERVER_NAME)
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
  if (!applyToolUses(event.toolUses, ctx)) return
  if (event.error !== null) {
    // The error text arrives as assistant content; it must not become reply text.
    if (event.error === 'authentication_failed') {
      failTurn(emitter, state, { code: 'runtime_unavailable', unavailable: 'claude_not_authenticated' })
    } else {
      // The CLI's own error line (e.g. "API Error: 400 ..."), redacted and capped; never model output.
      const reason = stderrReason(event.text) || `Claude reported "${event.error}"`
      failTurn(emitter, state, { code: 'runtime_error', retryable: RETRYABLE_ASSISTANT_ERRORS.has(event.error), reason })
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
      state.sawInit = true
      if (!initAllowed(event)) {
        const foreign = [...event.tools.filter((t) => !isWebtermTool(t)), ...event.servers.filter((n) => n !== MCP_SERVER_NAME)]
        failTurn(emitter, state, {
          code: 'runtime_error',
          reason: `Claude started with tools or MCP servers webterm does not allow (${foreign.slice(0, 5).join(', ')}); check managed Claude settings or plugins`,
        })
        ctx.kill()
      }
      return
    case 'tool_results':
      applyToolResults(event.results, ctx)
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
