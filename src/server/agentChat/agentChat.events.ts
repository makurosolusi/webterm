// SDK message -> agent chat events (PLAN/AGENT-CHAT.md §4). Pure and stateful, one mapper per session.
// Order and quirks verified in spike S0 (/tmp/st/agent-chat-s0.md "Message order"):
//  - `system/init` repeats every turn: emitted only when session/model/mode changed.
//  - `assistant` arrives once PER CONTENT BLOCK: parts are merged by message id, the cumulative
//    message is re-emitted. Tool cards come from `tool_use` blocks, not from canUseTool (rule- or
//    mode-approved tools never reach the callback).
//  - `result.total_cost_usd` is cumulative per Query: passed through, never summed.
//  - An interrupted turn ends as `result/error_during_execution`: status 'interrupted', not 'error'.
//  - A queued user message is picked up when a reply frame stamps its uuid (`user_message_uuid(s)`
//    on assistant / stream_event, sdk.d.ts SDKAssistantMessage); a CLI that never stamps clears every
//    queued message at the first `message_start` after a result (the next turn started).
//  - Context use = the last top-level API call's input + cache + output tokens; window from
//    `result.modelUsage[model].contextWindow` (no getContextUsage call: it costs API requests).
// Unknown message types map to nothing (forward-compat with newer CLIs).
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_CHAT_TOOL_RESULT_MAX, type AgentChatEventBody, type AgentChatPart } from '../../shared/agentChat.wire'

const MS_PER_S = 1_000

interface Usage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
/** Reply-frame fields that name the user messages a turn consumed (sdk.d.ts SDKAssistantMessage). */
interface Stamped { user_message_uuid?: string; user_message_uuids?: string[] }

interface ContentBlock { type: string; id?: string; name?: string; input?: unknown; text?: string; thinking?: string; tool_use_id?: string; content?: unknown; is_error?: boolean; source?: { media_type?: string } }

export interface AgentChatMapper {
  map(msg: SDKMessage): AgentChatEventBody[]
  /** The permission gate denied this tool use: its result renders as `denied`, not `error`. */
  denied(toolUseId: string): void
  /** An interrupt was requested: the next error_during_execution result is an interruption. */
  markInterrupt(): void
  /** A user message was pushed while a turn runs: report it picked up when Claude starts it. */
  queue(messageId: string): void
  /** Forget every queued message (the Query closed); returns their ids. */
  dropQueued(): string[]
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const parentOf = (p: string | null | undefined): { parentId?: string } => (p ? { parentId: p } : {})

/** Plain text of a tool_result `content` (string or block array; images are skipped). */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b: ContentBlock) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
}

export function createAgentChatMapper(): AgentChatMapper {
  let initKey = ''
  let streamId = ''
  let interruptPending = false
  const messages = new Map<string, AgentChatPart[]>()
  const tools = new Map<string, { name: string; input: unknown }>()
  const deniedIds = new Set<string>()
  const queued = new Set<string>()
  let turnOver = false
  let turnOutput = false
  let lastUsage: { model?: string; used: number } | undefined

  function pickedUp(msg: Stamped): AgentChatEventBody[] {
    const ids = [...(msg.user_message_uuids ?? []), ...(msg.user_message_uuid ? [msg.user_message_uuid] : [])].filter((id) => queued.delete(id))
    return [...new Set(ids)].map((id) => ({ t: 'queued', messageId: id, queued: false }))
  }

  function endTurn(): void {
    messages.clear()
    tools.clear()
    deniedIds.clear()
    streamId = ''
    interruptPending = false
    turnOutput = false
  }

  function context(msg: Extract<SDKMessage, { type: 'result' }>): AgentChatEventBody[] {
    const usage = (msg.modelUsage ?? {}) as Record<string, { contextWindow?: number }>
    const window = n(lastUsage?.model ? usage[lastUsage.model]?.contextWindow : 0) || Math.max(0, ...Object.values(usage).map((u) => n(u?.contextWindow)))
    const used = lastUsage?.used ?? 0
    return window > 0 && used > 0 ? [{ t: 'context', context: { used, window } }] : []
  }

  function system(msg: Extract<SDKMessage, { type: 'system' }>): AgentChatEventBody[] {
    switch (msg.subtype) {
      case 'init': {
        const key = `${msg.session_id}\n${msg.model}\n${msg.permissionMode}`
        if (key === initKey) return []
        initKey = key
        return [{
          t: 'init', sessionId: msg.session_id, model: msg.model, mode: msg.permissionMode,
          commands: msg.slash_commands, capabilities: msg.capabilities ?? [], cliVersion: msg.claude_code_version, cwd: msg.cwd,
        }]
      }
      case 'status': {
        const out: AgentChatEventBody[] = []
        if (msg.permissionMode) out.push({ t: 'mode', mode: msg.permissionMode })
        if (msg.status === 'requesting') out.push({ t: 'status', status: 'thinking' })
        if (msg.status === 'compacting') out.push({ t: 'status', status: 'thinking', detail: 'compacting' })
        return out
      }
      case 'api_retry':
        return [{ t: 'status', status: 'retry', detail: `attempt ${msg.attempt}, retrying in ${Math.ceil(msg.retry_delay_ms / MS_PER_S)}s` }]
      case 'permission_denied':
        deniedIds.add(msg.tool_use_id)
        return []
      case 'local_command_output':
        turnOutput = true
        return [{ t: 'commandOutput', id: msg.uuid, text: msg.content }]
      case 'compact_boundary':
        return [{ t: 'compact', id: msg.uuid, trigger: msg.compact_metadata.trigger, ...(typeof msg.compact_metadata.pre_tokens === 'number' ? { preTokens: msg.compact_metadata.pre_tokens } : {}) }]
      case 'commands_changed':
        return [{ t: 'commandsChanged' }]
      default:
        return []
    }
  }

  function streamEvent(msg: Extract<SDKMessage, { type: 'stream_event' }>): AgentChatEventBody[] {
    const ev = msg.event
    const picked = pickedUp(msg as Stamped)
    if (ev.type === 'message_start') {
      streamId = ev.message.id
      if (turnOver && !msg.parent_tool_use_id) {
        turnOver = false
        for (const id of queued) picked.push({ t: 'queued', messageId: id, queued: false })
        queued.clear()
      }
      return picked
    }
    if (picked.length) return picked
    if (ev.type !== 'content_block_delta' || !streamId) return []
    const d = ev.delta
    if (d.type === 'text_delta') return [{ t: 'delta', messageId: streamId, kind: 'text', text: d.text, ...parentOf(msg.parent_tool_use_id) }]
    if (d.type === 'thinking_delta') return [{ t: 'delta', messageId: streamId, kind: 'thinking', text: d.thinking, ...parentOf(msg.parent_tool_use_id) }]
    return []
  }

  function assistant(msg: Extract<SDKMessage, { type: 'assistant' }>): AgentChatEventBody[] {
    const id = msg.message.id
    const parts = messages.get(id) ?? []
    const out: AgentChatEventBody[] = []
    const parent = parentOf(msg.parent_tool_use_id)
    out.push(...pickedUp(msg as Stamped))
    if (!msg.parent_tool_use_id) {
      const u = (msg.message.usage ?? {}) as Usage
      const used = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens) + n(u.output_tokens)
      if (used > 0) lastUsage = { model: (msg.message as { model?: string }).model, used }
    }
    for (const b of msg.message.content as ContentBlock[]) {
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push({ k: 'text', text: b.text })
        if (!msg.parent_tool_use_id) turnOutput = true
      }
      else if (b.type === 'thinking' && typeof b.thinking === 'string') parts.push({ k: 'thinking', text: b.thinking })
      else if (b.type === 'tool_use' && b.id && !parts.some((p) => p.k === 'tool' && p.id === b.id)) {
        parts.push({ k: 'tool', id: b.id })
        tools.set(b.id, { name: b.name ?? '', input: b.input })
        out.push({ t: 'tool', id: b.id, name: b.name ?? '', input: b.input, state: 'running', ...parent }, { t: 'status', status: 'tool' })
      }
    }
    messages.set(id, parts)
    const picked = out.filter((e) => e.t === 'queued')
    return [...picked, { t: 'message', messageId: id, role: 'assistant', parts: [...parts], ...parent }, ...out.filter((e) => e.t !== 'queued')]
  }

  function user(msg: Extract<SDKMessage, { type: 'user' }>): AgentChatEventBody[] {
    const content = msg.message.content
    if (!Array.isArray(content)) return []
    const out: AgentChatEventBody[] = []
    for (const b of content as ContentBlock[]) {
      if (b.type !== 'tool_result' || !b.tool_use_id) continue
      const id = b.tool_use_id
      const text = resultText(b.content)
      const truncated = text.length > AGENT_CHAT_TOOL_RESULT_MAX
      const tool = tools.get(id)
      out.push({
        t: 'tool', id, name: tool?.name ?? '', input: tool?.input, state: deniedIds.has(id) ? 'denied' : b.is_error ? 'error' : 'done',
        result: truncated ? text.slice(0, AGENT_CHAT_TOOL_RESULT_MAX) : text, ...(truncated ? { truncated: true } : {}), ...parentOf(msg.parent_tool_use_id),
      })
    }
    return out
  }

  function result(msg: Extract<SDKMessage, { type: 'result' }>): AgentChatEventBody[] {
    const interrupted = interruptPending && msg.subtype === 'error_during_execution'
    // A turn without assistant text (a slash command such as /cost): its result text is the output.
    const output: AgentChatEventBody[] = !turnOutput && msg.subtype === 'success' && typeof msg.result === 'string' && msg.result.trim() ? [{ t: 'commandOutput', id: msg.uuid, text: msg.result }] : []
    const ctx = context(msg)
    endTurn()
    turnOver = true
    const failed = !interrupted && (msg.subtype !== 'success' || msg.is_error)
    return [
      ...output,
      { t: 'result', costUsd: msg.total_cost_usd, durationMs: msg.duration_ms, isError: msg.is_error, interrupted, usage: msg.usage, denials: msg.permission_denials.length },
      ...ctx,
      interrupted ? { t: 'status', status: 'interrupted' } : failed ? { t: 'status', status: 'error', detail: msg.subtype } : { t: 'status', status: 'idle' },
    ]
  }

  return {
    map(msg) {
      switch (msg.type) {
        case 'system': return system(msg)
        case 'stream_event': return streamEvent(msg)
        case 'assistant': return assistant(msg)
        case 'user': return user(msg)
        case 'result': return result(msg)
        case 'conversation_reset':
          endTurn()
          lastUsage = undefined
          return [{ t: 'reset', sessionId: msg.new_conversation_id }]
        default: return []
      }
    },
    denied(toolUseId) { deniedIds.add(toolUseId) },
    markInterrupt() { interruptPending = true },
    queue(messageId) { queued.add(messageId) },
    dropQueued() { const ids = [...queued]; queued.clear(); return ids },
  }
}
