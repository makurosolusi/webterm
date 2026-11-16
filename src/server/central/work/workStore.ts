import type { Database } from 'bun:sqlite'
import { canWorkTransition, type AssignmentChannel, type AssignmentView, type TaskView, type WorkAcceptance, type WorkEventView, type WorkStatus } from '../../../shared/centralWork'
import { allRows, execWrite, getRow, inTransaction, jsonOf, newId, parseJson, requireText, tx, type LedgerContext, type Row } from '../../ledger/ledgerCore'
import { appendEvent, clampLimit, clampOffset } from '../../ledger/ledgerEvent'
import { createLogger } from '../../logs'
import { LEASE_MS, leaseFor, ownerOf } from './workOwner'
import { WorkError, type MoveOptions, type WorkActor, type WorkMove, type WorkStore } from './workModel'

const log = createLogger('central.work')
const LIST_BOUNDS = { def: 50, max: 200, label: 'listTasks' }
const TIMELINE_BOUNDS = { def: 100, max: 500, label: 'timeline' }
const OPEN_ASSIGNMENTS_MAX = 200
const INSTRUCTION_MAX_CHARS = 4000
const DEPS_RULE = 'deps'
const END_RULE = 'assignment.end'
/** Same string as WORK_VERIFY_RULES.autoDone, kept literal so the store does not import the verifier. */
const AUTO_DONE_RULE = 'auto_done'

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

const TASK_SELECT = `SELECT t.*, (SELECT json_group_array(blocked_by_id) FROM central_task_dep d WHERE d.task_id = t.id) AS blocked_by_json FROM central_task t`

function toTask(r: Row): TaskView {
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

function toEvent(r: Row, taskId: string): WorkEventView {
  const p = (parseJson(r.payload_json) ?? {}) as Record<string, unknown>
  return {
    seq: Number(r.seq), at: Number(r.ts), actor: String(r.actor), kind: String(r.kind), taskId, from: str(p.from) as WorkStatus | null, to: str(p.to) as WorkStatus | null,
    reason: str(p.reason), rule: str(p.rule), assignmentId: str(p.assignmentId), nodeId: str(p.nodeId), conversationId: str(p.conversationId), turnId: str(p.turnId),
  }
}

function actorName(actor: WorkActor, rule?: string): string {
  if (actor.kind === 'central') return 'central'
  if (actor.kind === 'human') return `human:${actor.id ?? 'ui'}`
  if (actor.kind === 'agent') return `agent:${actor.id}`
  return rule ? `system:${rule}` : 'system'
}

function mayMarkDone(actor: WorkActor): boolean {
  return actor.kind === 'human' || (actor.kind === 'system' && actor.autoDone === true)
}

// Keyed by database, not by store: tools build a store per call, and each of them must be observed.
const moveObservers = new WeakMap<Database, Set<(move: WorkMove) => void>>()

/** Calls `fn` after the commit of every task move on `db`, whichever store made it; a throw is logged and never reaches the mover. */
export function onWorkMove(db: Database, fn: (move: WorkMove) => void): void {
  const observers = moveObservers.get(db) ?? new Set()
  moveObservers.set(db, observers.add(fn))
}

function publishMoves(db: Database, moves: readonly WorkMove[]): void {
  for (const fn of moveObservers.get(db) ?? []) {
    for (const move of moves) {
      try {
        fn(move)
      } catch (err) {
        log.error('work.move_observer_failed', `observer of task ${move.task.id} moving to ${move.to} failed`, { taskId: move.task.id, seq: move.seq, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
}

/** Repository over the central work tables; every state change commits with its ledger event. */
export function createWorkStore(db: Database, now: () => number): WorkStore {
  const ctx: LedgerContext = { db, now }

  const getTask = (id: string): TaskView | null => { const r = getRow(db, `${TASK_SELECT} WHERE t.id = ?`, id); return r ? toTask(r) : null }
  const getAssignment = (id: string): AssignmentView | null => { const r = getRow(db, 'SELECT * FROM central_assignment WHERE id = ?', id); return r ? toAssignment(r) : null }
  const openOfTask = (taskId: string): AssignmentView | null => { const r = getRow(db, 'SELECT * FROM central_assignment WHERE task_id = ? AND ended_at IS NULL', taskId); return r ? toAssignment(r) : null }
  const requireTask = (id: string, operation: string): TaskView => {
    const task = getTask(id)
    if (!task) throw new WorkError('task_not_found', operation, id)
    return task
  }
  const hasUnfinishedDeps = (taskId: string): boolean => getRow(db,
    `SELECT 1 AS one FROM central_task_dep d JOIN central_task b ON b.id = d.blocked_by_id WHERE d.task_id = ? AND b.status != 'done' LIMIT 1`, taskId) !== null

  /** The latest move into done was the auto-done rule (a pruned history reads as "not automatic"). */
  const doneAutomatically = (taskId: string): boolean => {
    const row = getRow(db, "SELECT payload_json FROM event WHERE correlation_id = ? AND kind = 'work.task.done' ORDER BY seq DESC LIMIT 1", taskId)
    return row !== null && (parseJson(row.payload_json) as { rule?: unknown } | null)?.rule === AUTO_DONE_RULE
  }

  interface EventInput {
    kind: string; actor: WorkActor; task: TaskView; assignment?: AssignmentView | null
    from?: WorkStatus; to?: WorkStatus; reason?: string; rule?: string
  }
  const record = ({ kind, actor, task, assignment, from, to, reason, rule }: EventInput): number => {
    return appendEvent(ctx, {
      kind, actor: actorName(actor, rule), projectId: task.projectId, correlationId: task.id,
      payload: {
        from: from ?? null, to: to ?? null, reason: reason ?? null, rule: rule ?? null, assignmentId: assignment?.id ?? null, nodeId: assignment?.nodeId ?? null,
        conversationId: assignment?.conversationId ?? task.conversationId, turnId: assignment?.turnId ?? task.turnId,
      },
    }).seq
  }

  let batch: WorkMove[] = []
  /** Runs `fn` in a transaction, then tells the observers what it moved; a rollback tells them nothing. */
  const moving = <T>(fn: () => T): T => {
    const joined = inTransaction(db)
    const outer = batch
    const moves: WorkMove[] = []
    batch = moves
    let result: T
    try {
      result = tx(ctx, fn)
    } finally {
      batch = outer
    }
    // Joined a caller's transaction: it ends before any microtask runs, and a rollback takes the event row with it.
    if (joined) queueMicrotask(() => publishMoves(db, moves.filter((m) => getRow(db, 'SELECT 1 AS one FROM event WHERE seq = ?', m.seq))))
    else publishMoves(db, moves)
    return result
  }

  const assignmentOfMove = (task: TaskView, assignmentId?: string): AssignmentView | null => {
    if (!assignmentId) return openOfTask(task.id)
    const assignment = getAssignment(assignmentId)
    if (assignment?.taskId !== task.id) throw new WorkError('assignment_not_found', 'moveTask', assignmentId, `task ${task.id}`)
    return assignment
  }

  const applyMove = (cur: TaskView, to: WorkStatus, options: MoveOptions): TaskView => {
    const edge = `${cur.status} -> ${to}`
    if (!canWorkTransition(cur.status, to)) throw new WorkError('illegal_transition', 'moveTask', cur.id, edge)
    if (to === 'done' && !mayMarkDone(options.actor)) throw new WorkError('done_forbidden', 'moveTask', cur.id, actorName(options.actor, options.rule))
    if (cur.status === 'done' && !doneAutomatically(cur.id)) throw new WorkError('illegal_transition', 'moveTask', cur.id, `${edge} (only an auto-done task can be reopened)`)
    if (to === 'todo' && hasUnfinishedDeps(cur.id)) throw new WorkError('blocked_by_deps', 'moveTask', cur.id, edge)
    const assignment = assignmentOfMove(cur, options.assignmentId)
    if (execWrite(db, 'UPDATE central_task SET status = ?, updated_at = ? WHERE id = ? AND status = ?', to, now(), cur.id, cur.status) !== 1) {
      throw new WorkError('concurrent_update', 'moveTask', cur.id, edge)
    }
    // Every move hands the task to the owner of its new status with a fresh lease (workOwner.ts).
    if (assignment) execWrite(db, 'UPDATE central_assignment SET lease_until = ? WHERE id = ?', leaseFor(to, now()), assignment.id)
    const seq = record({ kind: `work.task.${to}`, actor: options.actor, task: cur, assignment, from: cur.status, to, reason: options.reason, rule: options.rule })
    const moved = requireTask(cur.id, 'moveTask')
    batch.push({ task: moved, from: cur.status, to, rule: options.rule ?? null, reason: options.reason ?? null, channel: assignment?.channel ?? null, seq })
    return moved
  }

  const unblockDependents = (doneId: string): void => {
    const ready = allRows(db, `${TASK_SELECT} WHERE t.status = 'blocked' AND t.id IN (SELECT task_id FROM central_task_dep WHERE blocked_by_id = ?)
      AND NOT EXISTS (SELECT 1 FROM central_task_dep d JOIN central_task b ON b.id = d.blocked_by_id WHERE d.task_id = t.id AND b.status != 'done')`, doneId)
    for (const row of ready) applyMove(toTask(row), 'todo', { actor: { kind: 'system' }, rule: DEPS_RULE, reason: `dependency ${doneId} done` })
  }

  const live = (sql: string, ...args: unknown[]): boolean => execWrite(db, `UPDATE central_assignment SET ${sql} AND ended_at IS NULL`, ...args) === 1

  return {
    createTask(input) {
      return tx(ctx, () => {
        if (!getRow(db, 'SELECT 1 AS one FROM project WHERE id = ?', input.projectId)) throw new WorkError('project_not_found', 'createTask', input.projectId)
        const id = input.id ?? newId()
        const at = now()
        execWrite(db,
          `INSERT INTO central_task (id, project_id, title, objective, status, boundaries_json, acceptance, due_at, created_by, conversation_id, turn_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, input.projectId, requireText(input.title, 'task.title'), requireText(input.objective, 'task.objective'), jsonOf(input.boundaries, 'task.boundaries'),
          input.acceptance ?? 'review', input.dueAt ?? null, actorName(input.actor), input.conversationId ?? null, input.turnId ?? null, at, at)
        const task = requireTask(id, 'createTask')
        record({ kind: 'work.task.todo', actor: input.actor, task, to: 'todo' })
        return task
      })
    },
    updateTask(id, patch) {
      return tx(ctx, () => {
        const cur = requireTask(id, 'updateTask')
        execWrite(db, 'UPDATE central_task SET title = ?, objective = ?, due_at = ?, boundaries_json = ?, acceptance = ?, updated_at = ? WHERE id = ?',
          patch.title === undefined ? cur.title : requireText(patch.title, 'task.title'),
          patch.objective === undefined ? cur.objective : requireText(patch.objective, 'task.objective'),
          patch.dueAt === undefined ? cur.dueAt : patch.dueAt,
          jsonOf(patch.boundaries === undefined ? cur.boundaries : patch.boundaries, 'task.boundaries'),
          patch.acceptance ?? cur.acceptance, now(), id)
        return requireTask(id, 'updateTask')
      })
    },
    getTask,
    listTasks({ projectId, statuses, limit, offset } = {}) {
      const where: string[] = []
      const args: unknown[] = []
      if (projectId) { where.push('t.project_id = ?'); args.push(projectId) }
      if (statuses?.length) { where.push(`t.status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses) }
      const clause = where.length ? ` WHERE ${where.join(' AND ')}` : ''
      return allRows(db, `${TASK_SELECT}${clause} ORDER BY t.updated_at DESC, t.id LIMIT ? OFFSET ?`, ...args, clampLimit(limit, LIST_BOUNDS), clampOffset(offset, LIST_BOUNDS.label)).map(toTask)
    },
    setDeps(taskId, blockedByIds) {
      return moving(() => {
        const cur = requireTask(taskId, 'setDeps')
        if (cur.status !== 'todo' && cur.status !== 'blocked') throw new WorkError('deps_locked', 'setDeps', taskId, cur.status)
        const ids = JSON.stringify([...new Set(blockedByIds)])
        const unknown = getRow(db, 'SELECT value FROM json_each(?) WHERE value NOT IN (SELECT id FROM central_task) LIMIT 1', ids)
        if (unknown) throw new WorkError('deps_unknown', 'setDeps', taskId, String(unknown.value))
        const cycle = getRow(db, `WITH RECURSIVE up(id) AS (SELECT value FROM json_each(?) UNION SELECT d.blocked_by_id FROM central_task_dep d JOIN up ON d.task_id = up.id)
          SELECT 1 AS one FROM up WHERE id = ? LIMIT 1`, ids, taskId)
        if (cycle) throw new WorkError('deps_cycle', 'setDeps', taskId)
        execWrite(db, 'DELETE FROM central_task_dep WHERE task_id = ?', taskId)
        execWrite(db, 'INSERT INTO central_task_dep (task_id, blocked_by_id) SELECT ?, value FROM json_each(?)', taskId, ids)
        const unfinished = hasUnfinishedDeps(taskId)
        const options: MoveOptions = { actor: { kind: 'system' }, rule: DEPS_RULE }
        if (unfinished && cur.status === 'todo') return applyMove(cur, 'blocked', options)
        if (!unfinished && cur.status === 'blocked') return applyMove(cur, 'todo', options)
        return requireTask(taskId, 'setDeps')
      })
    },
    moveTask(id, to, options) {
      return moving(() => {
        const moved = applyMove(requireTask(id, 'moveTask'), to, options)
        if (to === 'done') unblockDependents(id)
        return moved
      })
    },
    openAssignment(input) {
      return moving(() => {
        const task = requireTask(input.taskId, 'openAssignment')
        if (task.status === 'blocked') throw new WorkError('task_blocked', 'openAssignment', task.id)
        if (openOfTask(task.id)) throw new WorkError('assignment_open', 'openAssignment', task.id)
        const id = newId()
        const attempt = Number(getRow(db, 'SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM central_assignment WHERE task_id = ?', task.id)?.n)
        execWrite(db,
          `INSERT INTO central_assignment (id, task_id, project_id, node_id, agent_id, channel, instruction, attempt, started_at, conversation_id, turn_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, task.id, task.projectId, requireText(input.nodeId, 'assignment.nodeId'), input.agentId ?? null, input.channel,
          requireText(input.instruction, 'assignment.instruction').slice(0, INSTRUCTION_MAX_CHARS), attempt, now(), input.conversationId ?? task.conversationId, input.turnId ?? task.turnId)
        const assignment = getAssignment(id) as AssignmentView
        record({ kind: 'work.assignment.open', actor: input.actor, task, assignment, reason: input.reason, rule: input.rule })
        applyMove(task, 'assigned', { actor: input.actor, reason: input.reason, rule: input.rule, assignmentId: id })
        return assignment
      })
    },
    getAssignment,
    openAssignmentOfNode(nodeId) {
      const r = getRow(db, 'SELECT * FROM central_assignment WHERE node_id = ? AND ended_at IS NULL ORDER BY started_at DESC, id LIMIT 1', nodeId)
      return r ? toAssignment(r) : null
    },
    assignmentsOfTask: (taskId, limit = OPEN_ASSIGNMENTS_MAX) => allRows(db, 'SELECT * FROM central_assignment WHERE task_id = ? ORDER BY attempt DESC LIMIT ?', taskId, limit).map(toAssignment),
    openAssignmentOfTask: openOfTask,
    openAssignments: (limit = OPEN_ASSIGNMENTS_MAX) => allRows(db, 'SELECT * FROM central_assignment WHERE ended_at IS NULL ORDER BY started_at, id LIMIT ?', limit).map(toAssignment),
    // Only an agent-owned task (assigned/running) renews its lease from a signal; a reviewed or Central-owned one keeps its own clock.
    touchSignal: (id, signal, at) => live(`last_signal = ?, last_signal_at = ?,
      lease_until = CASE WHEN (SELECT status FROM central_task WHERE id = task_id) IN ('assigned', 'running') THEN ? ELSE lease_until END WHERE id = ?`, signal, at, at + LEASE_MS.agentActive, id),
    holdLeases: (until) => execWrite(db, 'UPDATE central_assignment SET lease_until = ? WHERE ended_at IS NULL AND (lease_until IS NULL OR lease_until < ?)', until, until),
    markNudged: (id, at = now()) => live('nudged_at = ? WHERE id = ?', at, id),
    incrementRestarts: (id) => live('restarts = restarts + 1 WHERE id = ?', id),
    noteAssignment(id, kind, { actor, rule, reason } = {}) {
      return tx(ctx, () => {
        const assignment = getAssignment(id)
        if (!assignment || assignment.endedAt !== null) return false
        record({ kind, actor: actor ?? { kind: 'system' }, task: requireTask(assignment.taskId, 'noteAssignment'), assignment, ...(rule ? { rule } : {}), ...(reason ? { reason } : {}) })
        return true
      })
    },
    setVerification: (taskId, verification) => execWrite(db, 'UPDATE central_task SET verification_json = ?, updated_at = ? WHERE id = ?', jsonOf(verification, 'task.verification'), now(), taskId) === 1,
    recordResult(id, result) {
      const cur = getRow(db, 'SELECT result_json FROM central_assignment WHERE id = ? AND ended_at IS NULL', id)
      if (!cur) return false
      if ((parseJson(cur.result_json) as { hash?: unknown } | null)?.hash === result.hash) return false
      return live('result_json = ? WHERE id = ?', jsonOf(result, 'assignment.result'), id)
    },
    endAssignment(id, reason, result, options = {}) {
      const actor: WorkActor = options.actor ?? { kind: 'system' }
      const rule = options.rule ?? END_RULE
      return tx(ctx, () => {
        const open = getAssignment(id)
        if (!open) throw new WorkError('assignment_not_found', 'endAssignment', id)
        const ended = execWrite(db, 'UPDATE central_assignment SET ended_at = ?, end_reason = ?, result_json = COALESCE(?, result_json) WHERE id = ? AND ended_at IS NULL', now(), reason, jsonOf(result, 'assignment.result'), id)
        if (ended !== 1) throw new WorkError('assignment_ended', 'endAssignment', id)
        record({ kind: 'work.assignment.end', actor, task: requireTask(open.taskId, 'endAssignment'), assignment: open, reason, rule })
        return getAssignment(id) as AssignmentView
      })
    },
    timeline(taskId, { limit, offset } = {}) {
      return allRows(db, 'SELECT * FROM event WHERE correlation_id = ? ORDER BY seq LIMIT ? OFFSET ?', taskId, clampLimit(limit, TIMELINE_BOUNDS), clampOffset(offset, TIMELINE_BOUNDS.label))
        .map((r) => toEvent(r, taskId))
    },
  }
}
