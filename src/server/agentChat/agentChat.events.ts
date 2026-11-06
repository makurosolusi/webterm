// SDK message -> agent chat events (PLAN/AGENT-CHAT.md §4). Pure and stateful, one mapper per session.
// Order and quirks verified in spike S0 (/tmp/st/agent-chat-s0.md "Message order"):
//  - `system/init` repeats every turn: emitted only when session/model/mode changed.
//  - `assistant` arrives once PER CONTENT BLOCK: parts are merged by message id, the cumulative
//    message is re-emitted. Tool cards come from `tool_use` blocks, not from canUseTool (rule- or
//    mode-approved tools never reach the callback).
//  - `result.total_cost_usd` is cumulative per Query: passed through, never summed.
//  - An interrupted turn ends as `result/error_during_execution`: status 'interrupted', not 'error'.
// Unknown message types map to nothing (forward-compat with newer CLIs).
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_CHAT_TOOL_RESULT_MAX, type AgentChatEventBody, type AgentChatPart } from '../../shared/agentChat.wire'

const MS_PER_S = 1_000

interface ContentBlock { type: string; id?: string; name?: string; input?: unknown; text?: string; thinking?: string; tool_use_id?: string; content?: unknown; is_error?: boolean; source?: { media_type?: string } }

export interface AgentChatMapper {
  map(msg: SDKMessage): AgentChatEventBody[]
  /** The permission gate denied this tool use: its result renders as `denied`, not `error`. */
  denied(toolUseId: string): void
  /** An interrupt was requested: the next error_during_execution result is an interruption. */
  markInterrupt(): void
}

const parentOf = (p: string | null | undefined): { parentId?: string } => (p ? { parentId: p } : {})

/** Plain text of a tool_result `content` (string or block array; images are skipped). */
function resultText(content: unknown): string {
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

  function endTurn(): void {
    messages.clear()
    tools.clear()
    deniedIds.clear()
    streamId = ''
    interruptPending = false
  }

  function system(msg: Extract<SDKMessage, { type: 'system' }>): AgentChatEventBody[] {
    switch (msg.subtype) {
      case 'init': {
        const key = `${msg.session_id}\n${msg.model}\n${msg.permissionMode}`
        if (key === initKey) return []
        initKey = key
        return [{
          t: 'init', sessionId: msg.session_id, model: msg.model, mode: msg.permissionMode,
          commands: msg.slash_commands, capabilities: msg.capabilities ?? [], cliVersion: msg.claude_code_version,
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
      default:
        return []
    }
  }

  function streamEvent(msg: Extract<SDKMessage, { type: 'stream_event' }>): AgentChatEventBody[] {
    const ev = msg.event
    if (ev.type === 'message_start') {
      streamId = ev.message.id
      return []
    }
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
    for (const b of msg.message.content as ContentBlock[]) {
      if (b.type === 'text' && typeof b.text === 'string') parts.push({ k: 'text', text: b.text })
      else if (b.type === 'thinking' && typeof b.thinking === 'string') parts.push({ k: 'thinking', text: b.thinking })
      else if (b.type === 'tool_use' && b.id && !parts.some((p) => p.k === 'tool' && p.id === b.id)) {
        parts.push({ k: 'tool', id: b.id })
        tools.set(b.id, { name: b.name ?? '', input: b.input })
        out.push({ t: 'tool', id: b.id, name: b.name ?? '', input: b.input, state: 'running', ...parent }, { t: 'status', status: 'tool' })
      }
    }
    messages.set(id, parts)
    return [{ t: 'message', messageId: id, role: 'assistant', parts: [...parts], ...parent }, ...out]
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
    endTurn()
    const failed = !interrupted && (msg.subtype !== 'success' || msg.is_error)
    return [
      { t: 'result', costUsd: msg.total_cost_usd, durationMs: msg.duration_ms, isError: msg.is_error, interrupted, usage: msg.usage, denials: msg.permission_denials.length },
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
        default: return []
      }
    },
    denied(toolUseId) { deniedIds.add(toolUseId) },
    markInterrupt() { interruptPending = true },
  }
}
