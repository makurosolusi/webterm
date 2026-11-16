// Which task moves wake Central at once, and how the wake reads.
import type { WorkMove } from './workModel'
import type { ReasonKind } from './workCheckin.queue'

// A failed send is in Central's own tool receipt first, so its wake waits `escalate.graceMs` for that turn to act.
export const DELEGATION_RULE = 'delegation'
/**
 * Rule of an agent's `webterm report --blocked` (workAgentReport.ts). The board's `blocked` status means waiting on
 * dependencies and has no edge from `running`, so the task waits for input under this rule and the wake says blocked.
 */
export const AGENT_BLOCKED_RULE = 'agent_blocked'
/** Where a Central-started attempt lands that Central must hear about at once (push, not a poll), and the reason kind it queues. */
export const WAKE_KINDS: Partial<Record<WorkMove['to'], ReasonKind>> = {
  reported: 'task_report', needs_review: 'task_report', failed: 'task_failed', stalled: 'task_stalled', waiting_input: 'task_input', blocked: 'task_blocked',
}
export const WAKE_WHAT: Partial<Record<WorkMove['to'], string>> = {
  reported: 'reported back', needs_review: 'finished and is ready for review', failed: 'failed', stalled: 'went quiet and is stalled',
  waiting_input: 'is waiting for input (a question or a permission prompt)', blocked: 'is blocked',
}
