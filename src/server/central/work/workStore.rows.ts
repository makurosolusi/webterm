// Row mappers of the central work tables (task, assignment, timeline event) and the task select they read.
import type { AssignmentChannel, AssignmentView, TaskView, WorkAcceptance, WorkEventView, WorkStatus } from '../../../shared/centralWork'
import { parseJson, type Row } from '../../ledger/ledgerCore'
import { ownerOf } from './workOwner'

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

export const TASK_SELECT = `SELECT t.*, (SELECT json_group_array(blocked_by_id) FROM central_task_dep d WHERE d.task_id = t.id) AS blocked_by_json FROM central_task t`

/** Maps a `central_task` row (with its `blocked_by_json` column). */
export function toTask(r: Row): TaskView {
  return {
    id: String(r.id), projectId: String(r.project_id), title: String(r.title), objective: String(r.objective), status: r.status as WorkStatus,
    boundaries: parseJson(r.boundaries_json) as string[] | null, acceptance: r.acceptance as WorkAcceptance, dueAt: num(r.due_at),
    createdBy: String(r.created_by), conversationId: str(r.conversation_id), turnId: str(r.turn_id), verification: parseJson(r.verification_json),
    blockedBy: (parseJson(r.blocked_by_json) as string[]).sort(), owner: ownerOf(r.status as WorkStatus), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  }
}

/** Maps a `central_assignment` row. */
export function toAssignment(r: Row): AssignmentView {
  return {
    id: String(r.id), taskId: String(r.task_id), projectId: String(r.project_id), nodeId: String(r.node_id), agentId: str(r.agent_id),
    channel: r.channel as AssignmentChannel, instruction: String(r.instruction), attempt: Number(r.attempt), startedAt: Number(r.started_at),
    lastSignal: str(r.last_signal), lastSignalAt: num(r.last_signal_at), nudgedAt: num(r.nudged_at), leaseUntil: num(r.lease_until), restarts: Number(r.restarts),
    endedAt: num(r.ended_at), endReason: str(r.end_reason), result: parseJson(r.result_json), conversationId: str(r.conversation_id), turnId: str(r.turn_id),
  }
}

/** Maps a ledger `event` row of a task into its timeline entry. */
export function toEvent(r: Row, taskId: string): WorkEventView {
  const p = (parseJson(r.payload_json) ?? {}) as Record<string, unknown>
  return {
    seq: Number(r.seq), at: Number(r.ts), actor: String(r.actor), kind: String(r.kind), taskId, from: str(p.from) as WorkStatus | null, to: str(p.to) as WorkStatus | null,
    reason: str(p.reason), rule: str(p.rule), assignmentId: str(p.assignmentId), nodeId: str(p.nodeId), conversationId: str(p.conversationId), turnId: str(p.turnId),
  }
}
