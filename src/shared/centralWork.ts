/** Every status a central task can be in. */
export const WORK_STATUSES = ['todo', 'blocked', 'assigned', 'running', 'waiting_input', 'stalled', 'reported', 'verifying', 'needs_review', 'failed', 'done', 'cancelled'] as const
/** Lifecycle status of a central task. */
export type WorkStatus = (typeof WORK_STATUSES)[number]

/** Legal moves of the task state machine. */
export const WORK_TRANSITIONS: Readonly<Record<WorkStatus, readonly WorkStatus[]>> = {
  todo: ['assigned', 'blocked', 'cancelled'],
  blocked: ['todo', 'cancelled'],
  assigned: ['running', 'stalled', 'failed', 'cancelled', 'todo'],
  running: ['waiting_input', 'stalled', 'reported', 'failed', 'cancelled'],
  waiting_input: ['running', 'reported', 'failed', 'cancelled'],
  stalled: ['running', 'waiting_input', 'reported', 'assigned', 'failed', 'cancelled'],
  reported: ['verifying', 'needs_review', 'running', 'cancelled'],
  verifying: ['needs_review', 'running', 'failed', 'cancelled'],
  needs_review: ['done', 'todo', 'running', 'cancelled'],
  failed: ['todo', 'cancelled'],
  done: [],
  cancelled: [],
}

/** True when `from -> to` is an edge of the task state machine. */
export function canWorkTransition(from: WorkStatus, to: WorkStatus): boolean {
  return WORK_TRANSITIONS[from].includes(to)
}

/** Statuses with no outgoing edge. */
export const WORK_TERMINAL: readonly WorkStatus[] = ['done', 'cancelled']

/** Board column of a task. */
export type BoardColumn = 'todo' | 'in_progress' | 'needs_review' | 'done'

/** Statuses shown in each board column. */
export const BOARD_COLUMNS: Readonly<Record<BoardColumn, readonly WorkStatus[]>> = {
  todo: ['todo', 'blocked'],
  in_progress: ['assigned', 'running', 'waiting_input', 'stalled'],
  needs_review: ['reported', 'verifying', 'needs_review', 'failed'],
  done: ['done', 'cancelled'],
}

/** The board column that shows `status`. */
export function boardColumnOf(status: WorkStatus): BoardColumn {
  return (Object.keys(BOARD_COLUMNS) as BoardColumn[]).find((c) => BOARD_COLUMNS[c].includes(status)) as BoardColumn
}

/** How a reported task gets accepted. */
export type WorkAcceptance = 'project_checks' | 'review'
/** Route the instruction took to reach the agent. */
export type AssignmentChannel = 'chat' | 'terminal' | 'spawn' | 'run'

/** A central task as read by tools and the board. */
export interface TaskView {
  id: string
  projectId: string
  title: string
  objective: string
  status: WorkStatus
  boundaries: string[] | null
  acceptance: WorkAcceptance
  dueAt: number | null
  createdBy: string
  conversationId: string | null
  turnId: string | null
  verification: unknown
  blockedBy: string[]
  createdAt: number
  updatedAt: number
}

/** One attempt at a task by one node. */
export interface AssignmentView {
  id: string
  taskId: string
  projectId: string
  nodeId: string
  agentId: string | null
  channel: AssignmentChannel
  instruction: string
  attempt: number
  startedAt: number
  lastSignal: string | null
  lastSignalAt: number | null
  nudgedAt: number | null
  restarts: number
  endedAt: number | null
  endReason: string | null
  result: unknown
  conversationId: string | null
  turnId: string | null
}

/** One row of a task's timeline. */
export interface WorkEventView {
  seq: number
  at: number
  actor: string
  kind: string
  taskId: string
  from: WorkStatus | null
  to: WorkStatus | null
  reason: string | null
  rule: string | null
  assignmentId: string | null
  nodeId: string | null
  conversationId: string | null
  turnId: string | null
}
