// Permission broker (PLAN/AGENT-CHAT.md D7): the session's `PermissionGate`. Holds each open
// `canUseTool` request per node until the client answers it over POST /permission. An abort (SDK
// signal or session close) rejects the request, so the session records it as cancelled/expired;
// the session emits every `permissionResolved`, never this broker.
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { AgentChatPermissionAnswer } from '../../shared/agentChat.wire'
import type { PermissionGate } from './agentChat.session'

export type AgentChatPermissionRequest = Parameters<PermissionGate['request']>[1]
/** An open request as the stream re-sends it (the signal stays server-side). */
export type AgentChatOpenRequest = Omit<AgentChatPermissionRequest, 'signal'>

export type AgentChatAnswerResult = { ok: true } | { ok: false; status: 409; reason: string }

interface Entry { req: AgentChatPermissionRequest; settle(r: PermissionResult): void }

export class AgentChatBroker implements PermissionGate {
  private open = new Map<string, Map<string, Entry>>()

  request(nodeId: string, req: AgentChatPermissionRequest): Promise<PermissionResult> {
    return new Promise((resolve, reject) => {
      const byNode = this.open.get(nodeId) ?? new Map<string, Entry>()
      this.open.set(nodeId, byNode)
      const take = (): boolean => {
        if (byNode.get(req.requestId)?.req !== req) return false
        byNode.delete(req.requestId)
        if (byNode.size === 0 && this.open.get(nodeId) === byNode) this.open.delete(nodeId)
        return true
      }
      byNode.set(req.requestId, { req, settle: (r) => { if (take()) resolve(r) } })
      const abort = (): void => { if (take()) reject(new Error(`permission request ${req.requestId} for node ${nodeId} was aborted`)) }
      if (req.signal.aborted) abort()
      else req.signal.addEventListener('abort', abort, { once: true })
    })
  }

  /** Settle one open request with the client's answer; unknown or already answered = 409, never a throw. */
  answer(nodeId: string, a: AgentChatPermissionAnswer): AgentChatAnswerResult {
    const e = this.open.get(nodeId)?.get(a.requestId)
    if (!e) return { ok: false, status: 409, reason: `No open permission request ${a.requestId} on this node: it is unknown or was already answered.` }
    if (a.behavior === 'deny') {
      e.settle({ behavior: 'deny', message: a.message })
      return { ok: true }
    }
    const suggestions = e.req.suggestions as PermissionUpdate[] | undefined // the SDK handed these to canUseTool as PermissionUpdate[]
    e.settle({
      behavior: 'allow', updatedInput: a.updatedInput ?? e.req.input,
      ...(a.always && suggestions?.length ? { updatedPermissions: suggestions } : {}),
    })
    return { ok: true }
  }

  /** Requests of `nodeId` still waiting for an answer, oldest first. */
  pending(nodeId: string): AgentChatOpenRequest[] {
    return [...(this.open.get(nodeId)?.values() ?? [])].map(({ req: { signal: _signal, ...rest } }) => rest)
  }
}
