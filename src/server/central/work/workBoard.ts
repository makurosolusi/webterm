// Read model of the task board: one query per concern over a page of tasks, never one per row.
import type { Database } from 'bun:sqlite'
import { boardColumnOf, type AssignmentView, type TaskCard, type TaskView, type WorkEventView } from '../../../shared/centralWork'
import { withNodeNames } from '../../../shared/nodeNames'
import { allRows, type Row } from '../../ledger/ledgerCore'
import { PERSIST_LIMITS, redactSecrets, redactValue } from '../../redactSecrets'
import { listWorkspaces } from '../workspaceLookup'
import { toAssignment } from './workStore.rows'

const IN_LIST = 'IN (SELECT value FROM json_each(?))'
const orNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))
const clean = (value: unknown): unknown => redactValue(value, PERSIST_LIMITS)
const group = <T>(rows: Row[], key: string, of: (r: Row) => T): Map<string, T[]> => {
  const out = new Map<string, T[]>()
  for (const r of rows) out.set(String(r[key]), [...(out.get(String(r[key])) ?? []), of(r)])
  return out
}

/** An assignment safe to send to the page. */
export const cleanAssignment = (a: AssignmentView): AssignmentView => ({ ...a, instruction: redactSecrets(a.instruction), result: clean(a.result) })
/** A timeline event safe to send to the page. */
export const cleanEvent = (e: WorkEventView): WorkEventView => ({ ...e, reason: e.reason === null ? null : redactSecrets(e.reason) })

/** node id -> display name, for each workspace in `ids`. */
function nodeNamesOf(ids: ReadonlySet<string>): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  if (ids.size === 0) return out
  for (const w of listWorkspaces() ?? []) {
    if (!w.id || !ids.has(w.id) || !Array.isArray(w.nodes)) continue
    const nodes = (w.nodes as Array<{ id?: unknown; name?: unknown }>).map((n) => ({ id: String(n.id), name: typeof n.name === 'string' ? n.name : undefined }))
    out.set(w.id, new Map(withNodeNames(nodes).map((n) => [n.id, n.name])))
  }
  return out
}

const isPlannedTodo = (card: TaskCard): boolean => card.column === 'todo' && card.seq !== null && card.seq !== undefined

/** Planned todo cards take the page slots those cards held, in plan order; every other card stays put. */
function inPlanOrder(cards: TaskCard[]): TaskCard[] {
  const planned = cards.filter(isPlannedTodo).sort((a, b) => (a.seq as number) - (b.seq as number))
  let next = 0
  return cards.map((card) => (isPlannedTodo(card) ? planned[next++] as TaskCard : card))
}

/** Board cards of `tasks`, in the same order except that planned todo cards follow their plan. */
export function taskCards(db: Database, tasks: readonly TaskView[]): TaskCard[] {
  if (tasks.length === 0) return []
  const ids = JSON.stringify(tasks.map((t) => t.id))
  const projects = new Map(allRows(db, `SELECT id, name, workspace_id FROM project WHERE id ${IN_LIST}`, JSON.stringify([...new Set(tasks.map((t) => t.projectId))]))
    .map((r) => [String(r.id), { name: String(r.name), workspaceId: String(r.workspace_id) }]))
  const assignments = new Map(allRows(db, `SELECT a.* FROM central_assignment a WHERE a.task_id ${IN_LIST}
    AND a.id = (SELECT b.id FROM central_assignment b WHERE b.task_id = a.task_id ORDER BY b.ended_at IS NULL DESC, b.attempt DESC LIMIT 1)`, ids)
    .map((r) => { const a = toAssignment(r); return [a.taskId, a] as const }))
  // SQLite takes the bare `rule` from the row that holds MAX(seq).
  const rules = new Map(allRows(db, `SELECT correlation_id, json_extract(payload_json, '$.rule') AS rule, MAX(seq) AS last FROM event
    WHERE correlation_id ${IN_LIST} AND json_extract(payload_json, '$.rule') IS NOT NULL GROUP BY correlation_id`, ids).map((r) => [String(r.correlation_id), String(r.rule)]))
  const blockers = group(allRows(db, `SELECT d.task_id, b.id, b.title FROM central_task_dep d JOIN central_task b ON b.id = d.blocked_by_id
    WHERE d.task_id ${IN_LIST} AND b.status != 'done' ORDER BY b.id`, ids), 'task_id', (r) => ({ id: String(r.id), title: redactSecrets(String(r.title)) }))
  const plan = new Map(allRows(db, `SELECT id, goal_version, seq FROM central_task WHERE id ${IN_LIST}`, ids).map((r) => [String(r.id), r]))
  const names = nodeNamesOf(new Set(tasks.flatMap((t) => (assignments.has(t.id) ? [projects.get(t.projectId)?.workspaceId ?? ''] : []))))
  return inPlanOrder(tasks.map((task) => {
    const assignment = assignments.get(task.id) ?? null
    const project = projects.get(task.projectId)
    const nodeName = assignment ? names.get(project?.workspaceId ?? '')?.get(assignment.nodeId) ?? null : null
    return {
      ...task, title: redactSecrets(task.title), objective: redactSecrets(task.objective), verification: clean(task.verification),
      projectName: redactSecrets(project?.name ?? task.projectId), column: boardColumnOf(task.status), assignment: assignment && cleanAssignment(assignment),
      nodeName, nodeExists: nodeName !== null, lastRule: rules.get(task.id) ?? null, blockedBy: blockers.get(task.id) ?? [],
      goalVersion: orNull(plan.get(task.id)?.goal_version), seq: orNull(plan.get(task.id)?.seq),
    }
  }))
}
