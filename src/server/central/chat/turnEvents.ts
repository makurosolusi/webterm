// Runtime-event projection for one chat turn (RND/08 §7, RND/13 §4 C1).
// Pure: turns normalized `RuntimeEvent`s into ledger event payloads plus the
// in-memory tool/text state the final assistant message needs. No SQL, no stream.
import type { CentralEventType } from '../conversationModel'
import type { RuntimeEvent, RuntimeUsage } from '../runtime/centralRuntime'
import { zeroUsage } from '../runtime/centralRuntime'

export interface ToolRecord {
  toolCallId: string
  name: string
  state: 'succeeded' | 'failed' | 'cancelled' | 'awaiting_approval'
  args?: unknown
  result?: unknown
  /** Ledger approval card the call is waiting on (MCP receipt `approval_required`, mcp/mcp.central.ts). */
  approvalId?: string
}

/** Approval id of a pending-card receipt, else undefined. */
function pendingApproval(output: unknown): string | undefined {
  const r = output && typeof output === 'object' ? output as { detail?: unknown; data?: { approvalId?: unknown } | null } : null
  const id = r?.detail === 'approval_required' ? r.data?.approvalId : undefined
  return typeof id === 'string' && id !== '' ? id : undefined
}

export interface RunState {
  text: string
  usage: RuntimeUsage
  tools: Map<string, ToolRecord>
  /** First runtime `error` of the turn: persisted as the failed reply's `error` part so a reload still shows why. */
  failure?: { code: string; message: string }
  /** Runtime notices of the turn, persisted ahead of the reply text. */
  notices: string[]
  /**
   * Reply body in event order: a text run, then the tool calls that interrupt it, then the next run.
   * Persisted as-is, so a reload shows text → tools → text, never one glued text with the tools after it.
   */
  order: Array<{ kind: 'text'; text: string } | { kind: 'tool'; toolCallId: string }>
}

export interface ProjectedEvent {
  type: CentralEventType
  payload: Record<string, unknown>
}

export function createRunState(): RunState {
  return { text: '', usage: zeroUsage(), tools: new Map(), notices: [], order: [] }
}

/** `usage` only updates state; `turn.result` is consumed by the service, not persisted here. */
export function projectRuntimeEvent(
  state: RunState, messageId: string, event: RuntimeEvent
): ProjectedEvent | null {
  if (event.type === 'text.delta') {
    state.text += event.text
    const last = state.order[state.order.length - 1]
    if (last?.kind === 'text') last.text += event.text
    else state.order.push({ kind: 'text', text: event.text })
    return { type: 'part.delta', payload: { messageId, part: 'text', delta: event.text } }
  }
  if (event.type === 'tool.requested') {
    if (!state.tools.has(event.toolCallId)) state.order.push({ kind: 'tool', toolCallId: event.toolCallId })
    state.tools.set(event.toolCallId, {
      toolCallId: event.toolCallId, name: event.name, state: 'failed', args: event.input,
    })
    return {
      type: 'tool.requested',
      payload: { messageId, toolCallId: event.toolCallId, name: event.name, input: event.input, risk: 'R0' },
    }
  }
  if (event.type === 'tool.completed') {
    const record = state.tools.get(event.toolCallId)
    if (record) {
      const approvalId = event.ok ? undefined : pendingApproval(event.output)
      record.state = event.ok ? 'succeeded' : approvalId ? 'awaiting_approval' : event.errorCode === 'cancelled' ? 'cancelled' : 'failed'
      record.result = event.output
      if (approvalId) record.approvalId = approvalId
    }
    return {
      type: 'tool.completed',
      payload: {
        messageId, toolCallId: event.toolCallId, name: event.name, ok: event.ok,
        output: event.output, errorCode: event.errorCode, durationMs: event.durationMs,
      },
    }
  }
  if (event.type === 'error') {
    state.failure ??= { code: event.code, message: event.message }
    return {
      type: 'error',
      payload: { messageId, code: event.code, message: event.message, retryable: event.retryable },
    }
  }
  if (event.type === 'notice') {
    state.notices.push(event.text)
    return { type: 'notice', payload: { messageId, text: event.text } }
  }
  if (event.type === 'usage') {
    state.usage = event.usage
  }
  return null
}
