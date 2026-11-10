import type { AssignmentChannel, AssignmentView, TaskView, WorkAcceptance, WorkEventView, WorkStatus } from '../../../shared/centralWork'

/** Who caused a change; only `human`, or `system` with `autoDone`, may mark a task done. */
export type WorkActor =
  | { kind: 'human'; id?: string }
  | { kind: 'central' }
  | { kind: 'agent'; id: string }
  | { kind: 'system'; autoDone?: boolean }

export type WorkErrorCode =
  | 'task_not_found' | 'project_not_found' | 'illegal_transition' | 'done_forbidden' | 'concurrent_update' | 'blocked_by_deps'
  | 'deps_locked' | 'deps_unknown' | 'deps_cycle' | 'task_blocked' | 'assignment_open' | 'assignment_not_found' | 'assignment_ended'

/** Refused or lost work operation; `code` is stable. */
export class WorkError extends Error {
  constructor(readonly code: WorkErrorCode, readonly operation: string, readonly id: string, detail?: string) {
    super(`${operation} ${id}: ${code}${detail ? ` (${detail})` : ''}`)
    this.name = 'WorkError'
  }
}

export interface NewTask {
  id?: string
  projectId: string
  title: string
  objective: string
  actor: WorkActor
  boundaries?: string[] | null
  acceptance?: WorkAcceptance
  dueAt?: number | null
  conversationId?: string | null
  turnId?: string | null
}
export interface TaskPatch { title?: string; objective?: string; dueAt?: number | null; boundaries?: string[] | null; acceptance?: WorkAcceptance }
export interface TaskFilter { projectId?: string; statuses?: readonly WorkStatus[]; limit?: number; offset?: number }
export interface Page { limit?: number; offset?: number }
export interface MoveOptions { actor: WorkActor; reason?: string; rule?: string; assignmentId?: string }
export interface NewAssignment {
  taskId: string
  nodeId: string
  channel: AssignmentChannel
  instruction: string
  actor: WorkActor
  agentId?: string | null
  reason?: string
  rule?: string
  conversationId?: string | null
  turnId?: string | null
}
export interface EndOptions { actor?: WorkActor; rule?: string }
export interface NoteOptions { actor?: WorkActor; rule?: string; reason?: string }

/** One committed status change, handed to `onWorkMove` observers. */
export interface WorkMove {
  /** The task after the move. */
  task: TaskView
  from: WorkStatus
  to: WorkStatus
  rule: string | null
  reason: string | null
  /** Route of the attempt this move belongs to, if any. */
  channel: AssignmentChannel | null
  /** Ledger event of this move: unique per state entry. */
  seq: number
}

export interface WorkStore {
  createTask(input: NewTask): TaskView
  updateTask(id: string, patch: TaskPatch): TaskView
  getTask(id: string): TaskView | null
  /** Most recently updated first; paginated (default 50, max 200). */
  listTasks(filter?: TaskFilter): TaskView[]
  /** Replaces the deps of a task that has not started; it ends up `blocked` iff a dep is unfinished (not `done`). */
  setDeps(taskId: string, blockedByIds: readonly string[]): TaskView
  /** Compare-and-set move along a legal edge; throws `WorkError` otherwise. */
  moveTask(id: string, to: WorkStatus, options: MoveOptions): TaskView
  /** Starts a new attempt and moves the task to `assigned`. */
  openAssignment(input: NewAssignment): AssignmentView
  getAssignment(id: string): AssignmentView | null
  openAssignmentOfNode(nodeId: string): AssignmentView | null
  openAssignmentOfTask(taskId: string): AssignmentView | null
  /** Attempts at a task, newest first. */
  assignmentsOfTask(taskId: string, limit?: number): AssignmentView[]
  /** Open assignments of every project, oldest first. */
  openAssignments(limit?: number): AssignmentView[]
  /** Records a liveness signal; false when the assignment is unknown or ended. Writes no event. */
  touchSignal(id: string, signal: string, at: number): boolean
  /** False when the assignment is unknown or ended. */
  markNudged(id: string, at?: number): boolean
  /** False when the assignment is unknown or ended. */
  incrementRestarts(id: string): boolean
  /** Timeline event about an assignment with no state change; false when the assignment is unknown or ended. */
  noteAssignment(id: string, kind: string, options?: NoteOptions): boolean
  /** Stores a task's verification verdict; false when the task is unknown. Writes no event. */
  setVerification(taskId: string, verification: unknown): boolean
  endAssignment(id: string, reason: string, result?: unknown, options?: EndOptions): AssignmentView
  /** Events of a task, newest last; paginated (default 100, max 500). */
  timeline(taskId: string, page?: Page): WorkEventView[]
}
