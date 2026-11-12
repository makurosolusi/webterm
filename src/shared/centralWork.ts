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
  // Reopen: only a task the system marked done (auto-done) may go back; the store enforces that (workStore.ts).
  done: ['todo'],
  cancelled: [],
}

/** True when `from -> to` is an edge of the task state machine. */
export function canWorkTransition(from: WorkStatus, to: WorkStatus): boolean {
  return WORK_TRANSITIONS[from].includes(to)
}

/** Closed statuses (done can only be reopened when it was automatic). */
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
export type AssignmentChannel = 'chat' | 'terminal' | 'spawn'

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

/** A task as shown on the board. `blockedBy` lists only the dependencies that are not done yet. */
export interface TaskCard extends Omit<TaskView, 'blockedBy'> {
  projectName: string
  column: BoardColumn
  /** The open attempt, else the latest one. */
  assignment: AssignmentView | null
  nodeName: string | null
  nodeExists: boolean
  /** Rule of the latest timeline event that had one. */
  lastRule: string | null
  blockedBy: { id: string; title: string }[]
  verification: unknown | null
  /** Version of the project goal this task was planned under. */
  goalVersion?: number | null
  /** Position in the project's plan; orders the todo column when set. */
  seq?: number | null
}

/** `GET /api/central/tasks`. */
export interface TaskPage {
  items: TaskCard[]
  hasMore: boolean
}

/** `GET /api/central/tasks/:id`. */
export interface TaskDetail {
  task: TaskCard
  assignments: AssignmentView[]
  timeline: WorkEventView[]
  hasMoreTimeline: boolean
}

/** Answer of every `POST /api/central/tasks/:id/*`. */
export type TaskActionResult = { task: TaskCard } | { error: string }

/** Lifecycle status of a project goal. */
export type GoalCardStatus = 'proposed' | 'active' | 'achieved' | 'abandoned' | 'superseded'

/** A project's goal with the board progress of the tasks planned under it. */
export interface GoalCard {
  projectId: string
  projectName: string
  version: number
  statement: string
  status: GoalCardStatus
  horizon: string
  counts: Record<BoardColumn, number>
  total: number
  /** Every linked task is finished and at least one was done; marking the goal achieved stays a human decision. */
  complete: boolean
}

/** `GET /api/central/goals`. */
export interface GoalPage {
  items: GoalCard[]
  hasMore: boolean
}

/** Lifecycle status of a Central reminder. */
export type ReminderStatus = 'pending' | 'fired' | 'cancelled'

/** One row of `GET /api/central/reminders`. */
export interface ReminderCard {
  id: string
  projectId: string | null
  projectName: string | null
  taskId: string | null
  text: string
  dueAt: number
  status: ReminderStatus
}

/** `GET /api/central/reminders`. */
export interface ReminderPage {
  items: ReminderCard[]
  hasMore: boolean
}

/** Allowed values of the daily limit on self-started Central turns. */
export const CHECKIN_DAILY_LIMITS = [5, 10, 20, 50] as const
/** Limit used until the user picks another one. */
export const DEFAULT_CHECKIN_DAILY_LIMIT = 10

/** `GET|POST /api/central/checkin-settings`. */
export interface CheckinSettings {
  enabled: boolean
  dailyLimit: number
  usedToday: number
}

/** `GET /api/central/work-settings`. */
export interface WorkSettings {
  autoDone: boolean
}
