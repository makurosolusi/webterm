// The SDK `canUseTool` of one agent chat session: every permission prompt becomes a `permission`
// event plus a request to the injected gate (server-io's broker); this code never answers one itself.
// Split from agentChat.session.ts so the session stays a lifecycle owner.
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentChatEventBody } from '../../shared/agentChat.wire'

const CANCELLED_MESSAGE = 'The permission request was cancelled before an answer arrived.'

export interface PermissionGate {
  request(nodeId: string, req: {
    requestId: string; toolName: string; toolUseId: string; input: Record<string, unknown>
    suggestions?: unknown[]; title?: string; description?: string; signal: AbortSignal
  }): Promise<PermissionResult>
}

/** What the callback needs from its session. */
export interface PermissionHost {
  nodeId: string
  gate: PermissionGate
  /** requestId -> abort of the open prompt; the session expires them on close. */
  pending: Map<string, AbortController>
  emit(body: AgentChatEventBody): void
  /** The gate denied (or the prompt was cancelled for) this tool use. */
  denied(toolUseId: string): void
  fail(operation: string, err: unknown): void
  running(): boolean
}

const permissionKind = (toolName: string): 'tool' | 'question' | 'plan' =>
  toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'tool'

const aborted = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
  const fail = (): void => reject(new Error('permission request aborted'))
  if (signal.aborted) fail()
  else signal.addEventListener('abort', fail, { once: true })
})

export function createCanUseTool(h: PermissionHost): CanUseTool {
  return async (toolName, input, opts) => {
    const requestId = opts.requestId
    const local = new AbortController()
    opts.signal.addEventListener('abort', () => local.abort(), { once: true })
    h.pending.set(requestId, local)
    const extra = { ...(opts.suggestions ? { suggestions: opts.suggestions } : {}), ...(opts.title ? { title: opts.title } : {}), ...(opts.description ? { description: opts.description } : {}) }
    h.emit({ t: 'status', status: 'awaiting' })
    h.emit({ t: 'permission', requestId, kind: permissionKind(toolName), toolName, toolUseId: opts.toolUseID, input, ...extra })
    let outcome: 'allow' | 'deny' | 'cancelled' = 'cancelled'
    try {
      const res = await Promise.race([
        h.gate.request(h.nodeId, { requestId, toolName, toolUseId: opts.toolUseID, input, ...extra, signal: local.signal }),
        aborted(local.signal),
      ])
      outcome = res.behavior
      if (res.behavior === 'deny') h.denied(opts.toolUseID)
      // CLIs before v2.1.207 reject an allow without updatedInput, so it is always echoed.
      return res.behavior === 'allow' ? { ...res, updatedInput: res.updatedInput ?? input } : res
    } catch (err) {
      if (!local.signal.aborted) h.fail('permission', err)
      h.denied(opts.toolUseID)
      return { behavior: 'deny', message: CANCELLED_MESSAGE }
    } finally {
      // close() already reported this request as 'expired' and removed it.
      if (h.pending.delete(requestId)) {
        h.emit({ t: 'permissionResolved', requestId, outcome })
        if (h.pending.size === 0 && h.running()) h.emit({ t: 'status', status: outcome === 'allow' ? 'tool' : 'thinking' })
      }
    }
  }
}
