// SDK message normalization for the Claude adapter (PLAN CENTRAL-RUNTIME-b 1.2).
// The Agent SDK yields the same records the CLI writes as stream-json (SDKMessage in sdk.d.ts).
//
// [BT] Every field name below (`system/init`.`tools`/`mcp_servers`/`session_id`,
// `stream_event`.`event`.`delta`.`text`, `assistant`.`message`.`id`/`content`/`usage`/`error`,
// `result`.`subtype`/`is_error`/`usage`/`total_cost_usd`/`duration_ms`) comes from the upstream
// docs, not from a recording. They stay unconfirmed until GATE-S; unknown shapes are ignored
// and the init check fails closed. Prompt text and model output are never logged here.
// MCP tool calls (PLAN F2-c): `assistant` content `tool_use {id,name,input}` and the following `user`
// content `tool_result {tool_use_id, content, is_error}` were checked against a real Claude Code 2.1.318
// stream-json run (2026-11-04). Only `mcp__webterm__*` tools may appear; anything else fails closed.
import { MCP_SERVER_NAME } from '../../mcp/mcp.paths'
import { type ClaudeResultEvent, type ClaudeUsage, type Rec, parseClaudeResult, parseUsage, rec, str } from './claudeResult'

export interface ClaudeToolUse { id: string; name: string; input: unknown }
/** `texts` keeps each text block apart: an image result is `[Image: source: …]` text plus the receipt JSON. */
export interface ClaudeToolResult { toolUseId: string; isError: boolean; texts: string[] }

export type ClaudeEvent =
  /** `webtermStatus`: Claude's status for the webterm MCP server (`connected`, `failed`, ...), `missing` when not listed. */
  | { type: 'init'; sessionId: string | null; tools: string[]; servers: string[]; webtermStatus: string }
  | { type: 'delta'; text: string }
  | { type: 'assistant'; messageId: string | null; text: string; toolUses: ClaudeToolUse[]; error: string | null; usage: ClaudeUsage | null }
  | { type: 'tool_results'; results: ClaudeToolResult[] }
  | { type: 'retry' }
  /** `rate_limit_event`: the account's limit state; `resetsAt` is in the CLI's unit (normalized by workRateLimit). */
  | { type: 'rateLimit'; status: string; resetsAt?: number }
  | ClaudeResultEvent

/** Names of an init list whose items are strings or `{name}` objects (tools are strings, servers objects). */
function names(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => (typeof item === 'string' ? item : str(rec(item)?.name) ?? ''))
}

/** Status of the webterm entry of `mcp_servers`; `unknown` when it carries no status, `missing` when absent. */
function webtermStatus(value: unknown): string {
  const entry = Array.isArray(value) ? value.map(rec).find((s) => s?.name === MCP_SERVER_NAME) : undefined
  return entry ? str(entry.status) ?? 'unknown' : 'missing'
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

/** `tool_result.content` is a string or a list of blocks; only `{type:'text', text}` blocks carry text. */
function resultTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => (rec(part)?.type === 'text' ? [str(rec(part)?.text) ?? ''] : []))
}

function parseUser(obj: Rec): ClaudeEvent | null {
  const content = rec(obj.message)?.content
  if (!Array.isArray(content)) return null
  const results: ClaudeToolResult[] = []
  for (const block of content) {
    const b = rec(block)
    if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
    results.push({ toolUseId: b.tool_use_id, isError: b.is_error === true, texts: resultTexts(b.content) })
  }
  return results.length > 0 ? { type: 'tool_results', results } : null
}

/** Normalizes one SDK message (SDKMessage, read defensively); unknown shapes yield null (ignored by design). */
export function parseClaudeMessage(message: unknown): ClaudeEvent | null {
  const obj = rec(message)
  if (obj === null) return null
  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init') {
        return { type: 'init', sessionId: str(obj.session_id), tools: names(obj.tools), servers: names(obj.mcp_servers), webtermStatus: webtermStatus(obj.mcp_servers) }
      }
      return obj.subtype === 'api_retry' ? { type: 'retry' } : null
    case 'rate_limit_event': {
      const info = rec(obj.rate_limit_info)
      const status = str(info?.status)
      return status ? { type: 'rateLimit', status, ...(typeof info?.resetsAt === 'number' ? { resetsAt: info.resetsAt } : {}) } : null
    }
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
