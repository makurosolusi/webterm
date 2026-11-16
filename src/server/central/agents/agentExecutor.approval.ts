// Approval-card path of an agent spawn (pend, settle, end); the executor injects its store, audit and launch.
import type { Database } from 'bun:sqlite'
import { consumeApproval, getApproval, requestApproval } from '../../ledger/ledgerApproval'
import { execWrite, getRow } from '../../ledger/ledgerCore'
import type { AgentRecord, AgentState, Tier } from '../contracts'
import type { ToolResult } from '../tools/toolTypes'
import type { AgentStore } from './agentStore'
import type { AgentHost } from './agentExecutor.types'

/** What the approval path borrows from the executor closure. */
export interface ApprovalFlowCtx {
  db: Database
  now(): number
  host: AgentHost
  store: AgentStore
  tryMove(id: string, to: AgentState, patch?: Parameters<AgentStore['transition']>[2]): AgentRecord | null
  skip(projectId: string): boolean
  snapshot(a: AgentRecord, extra?: Record<string, unknown>): ToolResult
  audit(a: AgentRecord, phase: string, extra?: Record<string, unknown>): void
  gate(projectId: string, tool: string, tier: Tier, requireApproval?: boolean): Promise<ToolResult | null>
  launch(agent: AgentRecord): Promise<ToolResult>
}

/** Builds the card steps of a spawn over the executor's shared state. */
export function createApprovalFlow(ctx: ApprovalFlowCtx) {
  const { db, now, host, store, tryMove, skip, snapshot, audit, gate, launch } = ctx

  /** Spawn card ids of one agent: `agent-<id>`, then `agent-<id>-2`, ... each time an earlier card expired. */
  function nextCardId(agent: AgentRecord): string {
    const base = `agent-${agent.id}`
    if (!agent.approvalId) return base
    const m = agent.approvalId.match(/-(\d+)$/)
    let n = agent.approvalId === base ? 2 : m ? Number(m[1]) + 1 : 2
    while (getApproval({ db, now }, `${base}-${n}`)) n++
    return `${base}-${n}`
  }

  async function pendApproval(agent: AgentRecord): Promise<ToolResult> {
    const id = nextCardId(agent)
    let challenge: { id: string }
    try {
      // `approval.task_id` references the ledger `task` table; a Central board task id (central_task) stays in the request only.
      const ledgerTask = agent.taskId && getRow(db, 'SELECT 1 AS one FROM task WHERE id = ?', agent.taskId) ? agent.taskId : null
      challenge = requestApproval({ db, now }, { id, projectId: agent.projectId, kind: 'agent.spawn', request: { agentId: agent.id, kind: agent.kind, role: agent.role, runner: agent.runner, taskId: agent.taskId, defHash: host.defHashOf?.(agent.kind) ?? null }, ...(ledgerTask ? { taskId: ledgerTask } : {}) })
    } catch (err) {
      // Without a card the agent must not stay launchable: close the row and surface a code, not the message.
      tryMove(agent.id, 'cancelled', { reason: `approval_request_failed:${err instanceof Error ? err.name : 'unknown'}` })
      return { ok: false, code: 'invalid_request' }
    }
    let pending: AgentRecord
    if (agent.state === 'approval_pending') {
      // Re-pend after an expired card: the state machine has no self edge, so only the card id moves.
      if (execWrite(db, "UPDATE central_agents SET approval_id = ?, last_event_at = ? WHERE id = ? AND state = 'approval_pending'", challenge.id, now(), agent.id) !== 1) {
        return snapshot(store.get(agent.id) ?? agent, { reused: true })
      }
      pending = store.get(agent.id) as AgentRecord
    } else {
      pending = store.transition(agent.id, 'approval_pending', { approvalId: challenge.id })
    }
    audit(pending, 'spawn.approval', { approvalId: challenge.id })
    return { ok: false, code: 'approval_required', data: { agentId: agent.id, approvalId: challenge.id, approvalStatus: 'pending' } }
  }

  const refused = (agent: AgentRecord, status: 'rejected' | 'expired'): ToolResult => ({ ok: false, code: `approval_${status}`, data: { agentId: agent.id, approvalId: agent.approvalId, approvalStatus: status, ...(status === 'expired' ? { hint: 'The approval card expired unanswered and this agent is cancelled; spawn again with a new requestId.' } : {}) } })

  function endPending(agent: AgentRecord, status: 'rejected' | 'expired'): ToolResult {
    const cancelled = tryMove(agent.id, 'cancelled', { reason: `approval_${status}` })
    if (cancelled) audit(cancelled, `spawn.${status}`, { approvalId: agent.approvalId })
    return refused(cancelled ?? agent, status)
  }

  /**
   * A retry of a spawn parked on a card answers from the ledger, never from the stored id alone:
   * pending -> same card; approved -> consume and start; rejected -> cancelled; expired -> a fresh card.
   * An approval whose TTL ran out before it was used counts as expired: the ledger refuses to consume it
   * (consent is bound to its window), so a fresh card is the only way forward.
   */
  async function settlePending(agent: AgentRecord, tier: Tier): Promise<ToolResult> {
    const approval = agent.approvalId ? getApproval({ db, now }, agent.approvalId) : null
    const lapsed = approval?.status === 'approved' && approval.expiresAt !== null && approval.expiresAt <= now()
    const status = !approval || lapsed ? 'expired' : approval.status
    // Skip approvals: an open or lapsed card no longer holds the agent; the guard's denies still do.
    if (skip(agent.projectId) && (status === 'pending' || status === 'expired')) return (await gate(agent.projectId, 'agent.spawn', tier)) ?? launch(agent)
    if (status === 'pending') return { ok: false, code: 'approval_required', data: { agentId: agent.id, approvalId: agent.approvalId, approvalStatus: 'pending' } }
    if (status === 'rejected') return endPending(agent, 'rejected')
    if (status === 'expired') return pendApproval(agent)
    const digest = getRow(db, 'SELECT d.action_digest AS digest FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id = ?', agent.approvalId)?.['digest']
    // Single use: when the resume sweep consumed it first, that sweep starts the agent; report where it is.
    if (typeof digest !== 'string' || !consumeApproval({ db, now }, agent.approvalId as string, { digest })) {
      return snapshot(store.get(agent.id) ?? agent, { reused: true, approvalStatus: 'approved' })
    }
    const started = await launch(agent)
    return { ...started, data: { ...started.data, approvalStatus: 'approved' } }
  }

  return { pendApproval, endPending, settlePending, refused }
}
