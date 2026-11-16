// Maps parsed Claude events onto the turn emitter and per-turn state (PLAN CENTRAL-RUNTIME-b 1.2).
// Only `mcp__webterm__*` tools may appear; anything else fails the turn closed. Prompt text and model output are never logged here.
import type { TurnEmitter } from './runtimeEvents'
import { type ClaudeTurnState, failTurn } from './claudeSession'
import { MCP_SERVER_NAME, MCP_USABLE } from '../../mcp/mcp.paths'
import { recordCentralMcpStatus } from '../../mcp/mcp.health'
import { createLogger } from '../../logs'
import { failureKindOfStop, isTransientKind } from '../work/workFailureKind'
import { processRateLimit } from '../work/workRateLimit'
import { WEBTERM_MCP_TOOL_PREFIX } from './claudeOptions'
import { stderrReason } from './runtimeShared'
import type { ClaudeEvent, ClaudeToolResult, ClaudeToolUse } from './claudeEvents.parse'

export interface ApplyContext {
  emitter: TurnEmitter
  state: ClaudeTurnState
  maxTurns: number
  maxTokens?: number
  /** Stops the query (aborts the SDK child). */
  kill: () => void
  /** Clock for tool durations; defaults to `Date.now`. */
  now?: () => number
}

const isWebtermTool = (name: string): boolean => name.startsWith(WEBTERM_MCP_TOOL_PREFIX) && name.length > WEBTERM_MCP_TOOL_PREFIX.length
/** Chat-facing tool name: the MCP server prefix is noise to a human. */
const shortName = (name: string): string => name.slice(WEBTERM_MCP_TOOL_PREFIX.length)

/** Claude Code's marker for an image it saved to disk; a flattened string may lead with it. */
const IMAGE_MARKERS = /^(\s*\[Image: [^\]\n]*\])+\s*/

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text.replace(IMAGE_MARKERS, '')) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // Not JSON: an image marker block or Claude Code's own failure text (e.g. "permission denied").
  }
  return null
}

/** Receipt JSON the webterm MCP server put in a result text block (last wins); anything else is wrapped as plain text. */
function receiptOf(texts: readonly string[]): Record<string, unknown> {
  for (let i = texts.length - 1; i >= 0; i--) {
    const receipt = jsonObject(texts[i])
    if (receipt) return receipt
  }
  return { outcome: 'error', detail: 'tool_failed', text: texts.join('') }
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
    const receipt = receiptOf(r.texts)
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

const log = createLogger('central')

/** User-facing failure for a turn whose webterm tools did not start. */
export const mcpNotStartedReason = (status: string): string =>
  `Central's tools did not start (webterm MCP server: ${status}). Retry, or see Settings › Health.`

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
      const kind = failureKindOfStop(event.error)
      failTurn(emitter, state, { code: 'runtime_error', retryable: isTransientKind(kind), kind, reason })
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
        return
      }
      recordCentralMcpStatus(event.webtermStatus)
      if (!MCP_USABLE.has(event.webtermStatus)) {
        log.error('central.mcp_not_connected', 'webterm MCP server did not start for this turn; turn failed', { status: event.webtermStatus, servers: event.servers })
        failTurn(emitter, state, { code: 'runtime_error', retryable: true, reason: mcpNotStartedReason(event.webtermStatus) })
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
    case 'rateLimit':
      processRateLimit.note(event)
      return
    case 'result':
      state.result = event
      if (event.sessionId !== null) state.sessionRef = event.sessionId
      return
  }
}
