// Open-work section of the state header: one grouped query per concern, never one per project.
import type { Database } from 'bun:sqlite'
import { BOARD_COLUMNS, WORK_STATUSES, WORK_TERMINAL, boardColumnOf, type BoardColumn, type WorkStatus } from '../../../shared/centralWork'
import { allRows } from '../../ledger/ledgerCore'
import { redactSecrets } from '../../redactSecrets'
import { createHealthStore } from '../health/healthStore'
import { taskCards } from '../work/workBoard'
import { listDuties } from '../work/workDuties'
import { createWorkStore } from '../work/workStore'
import { AGENT_REPORT_EVENT } from '../work/workLifecycle'

/** Open assignments listed per project before the shrink. */
export const MAX_OPEN_ASSIGNMENTS = 8
const MAX_WORK_PROJECTS = 20
const TASK_FETCH_LIMIT = 200
const MAX_TITLE = 60
const MAX_NODE = 40
const MAX_GOAL = 120
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Open duties in the header, newest first; the section is never shrunk. */
export const MAX_DUTIES = 5
const MAX_REASON = 60
const MAX_REPORT = 120
/** Projects named in the global health line. */
const MAX_HEALTH_PROJECTS = 5
const LIVE_GOALS = ['active', 'proposed']
const OPEN_STATUSES = WORK_STATUSES.filter((s) => !WORK_TERMINAL.includes(s))

export interface NeedsYou { waiting_input: number; needs_review: number; stalled: number; failed: number }
/** `report` = the agent's latest `webterm report` on this attempt's task (any kind), so progress shows without a wake. */
export interface OpenAssignment { task: string; node: string; status: WorkStatus; quietMin: number; report?: string }
export interface ProjectWork {
  id: string
  name: string
  columns: Record<BoardColumn, number>
  needsYou: NeedsYou
  liveAgents: number
  goal: { statement: string; status: string } | null
  open: OpenAssignment[]
}
export interface OpenWork { needsYou: NeedsYou; projects: ProjectWork[] }

/** A delegation Central started that is stuck, failed or waiting; `textLeftInBox` true means press Enter, do not retype. */
export interface OpenDuty { taskId: string; task: string; node: string; status: WorkStatus; reason: string | null; attempts: number; sinceMin: number; textLeftInBox?: boolean }

/** Central's open duties for the header; done and cancelled tasks are never among them. */
export function duties(db: Database, now: number): OpenDuty[] {
  return listDuties(db, MAX_DUTIES).map((d) => ({
    taskId: d.taskId, task: redactSecrets(d.title).slice(0, MAX_TITLE), node: d.nodeId.slice(0, MAX_NODE), status: d.status,
    reason: d.reason === null ? null : redactSecrets(d.reason).slice(0, MAX_REASON), attempts: d.attempts,
    sinceMin: Math.max(0, Math.floor((now - d.since) / MINUTE_MS)), ...(d.textLeftInBox === undefined ? {} : { textLeftInBox: d.textLeftInBox }),
  }))
}

const noNeeds = (): NeedsYou => ({ waiting_input: 0, needs_review: 0, stalled: 0, failed: 0 })
const noColumns = (): Record<BoardColumn, number> => Object.fromEntries(Object.keys(BOARD_COLUMNS).map((c) => [c, 0])) as Record<BoardColumn, number>
const needTotal = (n: NeedsYou): number => n.waiting_input + n.needs_review + n.stalled + n.failed

/** Counts for every project with open work, most attention first, plus the totals that outlive any shrink. */
export function openWork(db: Database, now: number): OpenWork {
  const needsYou = noNeeds()
  const byProject = new Map<string, ProjectWork>()
  const withOpen = new Set<string>()
  const entryOf = (id: string, name: unknown): ProjectWork => {
    const entry = byProject.get(id) ?? { id, name: redactSecrets(String(name)).slice(0, MAX_NODE), columns: noColumns(), needsYou: noNeeds(), liveAgents: 0, goal: null, open: [] }
    byProject.set(id, entry)
    return entry
  }
  for (const r of allRows(db, 'SELECT t.project_id, p.name, t.status, COUNT(*) AS n FROM central_task t JOIN project p ON p.id = t.project_id GROUP BY t.project_id, p.name, t.status')) {
    const id = String(r.project_id)
    const status = r.status as WorkStatus
    const n = Number(r.n)
    const entry = entryOf(id, r.name)
    entry.columns[boardColumnOf(status)] += n
    if (OPEN_STATUSES.includes(status)) withOpen.add(id)
    if (status in needsYou) {
      entry.needsYou[status as keyof NeedsYou] += n
      needsYou[status as keyof NeedsYou] += n
    }
  }
  // A live goal lists its project even with an empty board: that is the project waiting to be planned.
  for (const r of allRows(db, `SELECT id, name, json_extract(goal_json, '$.statement') AS statement, json_extract(goal_json, '$.status') AS status FROM project WHERE json_valid(goal_json)`)) {
    const id = String(r.id)
    const status = String(r.status)
    if (!byProject.has(id) && !LIVE_GOALS.includes(status)) continue
    entryOf(id, r.name).goal = { statement: redactSecrets(String(r.statement)).slice(0, MAX_GOAL), status }
    if (LIVE_GOALS.includes(status)) withOpen.add(id)
  }
  for (const r of allRows(db, 'SELECT project_id, COUNT(*) AS n FROM central_agents WHERE ended_at IS NULL GROUP BY project_id')) {
    const entry = byProject.get(String(r.project_id))
    if (entry) entry.liveAgents = Number(r.n)
  }
  const signalAt = new Map<OpenAssignment, number>()
  const taskOf = new Map<OpenAssignment, string>()
  for (const card of taskCards(db, createWorkStore(db, () => now).listTasks({ statuses: OPEN_STATUSES, limit: TASK_FETCH_LIMIT }))) {
    const a = card.assignment
    if (a === null || a.endedAt !== null) continue
    const at = a.lastSignalAt ?? a.startedAt
    const open = { task: redactSecrets(card.title).slice(0, MAX_TITLE), node: (card.nodeName ?? a.nodeId).slice(0, MAX_NODE), status: card.status, quietMin: Math.max(0, Math.floor((now - at) / MINUTE_MS)) }
    signalAt.set(open, at)
    taskOf.set(open, card.id)
    byProject.get(card.projectId)?.open.push(open)
  }
  // Latest report per open task, one grouped query (SQLite takes the bare column from the MAX(seq) row).
  const openTaskIds = [...taskOf.values()]
  if (openTaskIds.length > 0) {
    const reports = new Map(allRows(db, `SELECT correlation_id, json_extract(payload_json, '$.reason') AS reason, MAX(seq) AS seq FROM event
      WHERE kind = ? AND correlation_id IN (${openTaskIds.map(() => '?').join(',')}) GROUP BY correlation_id`, AGENT_REPORT_EVENT, ...openTaskIds)
      .map((r) => [String(r.correlation_id), redactSecrets(String(r.reason ?? '')).slice(0, MAX_REPORT)]))
    for (const [open, taskId] of taskOf) { const report = reports.get(taskId); if (report) open.report = report }
  }
  const projects = [...byProject.values()].filter((p) => withOpen.has(p.id))
  for (const p of projects) p.open = p.open.sort((a, b) => (signalAt.get(a) as number) - (signalAt.get(b) as number) || a.task.localeCompare(b.task)).slice(0, MAX_OPEN_ASSIGNMENTS)
  projects.sort((a, b) => needTotal(b.needsYou) - needTotal(a.needsYou) || a.id.localeCompare(b.id))
  return { needsYou, projects: projects.slice(0, MAX_WORK_PROJECTS) }
}

const ago = (ms: number): string => {
  const d = Math.max(0, ms)
  if (d < HOUR_MS) return `${Math.floor(d / MINUTE_MS)}m ago`
  if (d < 2 * DAY_MS) return `${Math.floor(d / HOUR_MS)}h ago`
  return `${Math.floor(d / DAY_MS)}d ago`
}

/**
 * One compact health line: a project chat gets its open counts and last scan, the global chat only the projects
 * holding open HIGH findings. Details come from the health tools.
 */
export function healthLine(db: Database, projectId: string | null, now: number): string {
  if (projectId !== null) {
    const s = createHealthStore(db, () => now).summary(projectId)
    if (s.lastScan === null) return 'never scanned'
    const levels = (['high', 'medium', 'low'] as const).filter((l) => s[l] > 0).map((l) => `${s[l]} ${l}`)
    const scan = s.lastScan.status === 'done' ? '' : ` (${s.lastScan.status})`
    return `${s.open} open${levels.length > 0 ? ` (${levels.join(', ')})` : ''} · last scan ${ago(now - s.lastScan.startedAt)}${scan}`
  }
  const rows = allRows(db, `SELECT p.name, COUNT(*) AS n FROM central_finding f JOIN project p ON p.id = f.project_id
    WHERE f.status = 'open' AND f.severity = 'high' GROUP BY f.project_id, p.name ORDER BY n DESC, p.name`)
  if (rows.length === 0) return 'no open high findings'
  const total = rows.reduce((sum, r) => sum + Number(r.n), 0)
  const named = rows.slice(0, MAX_HEALTH_PROJECTS).map((r) => `${redactSecrets(String(r.name)).slice(0, MAX_NODE)} ${Number(r.n)}`)
  const more = rows.length > MAX_HEALTH_PROJECTS ? `, +${rows.length - MAX_HEALTH_PROJECTS} more` : ''
  return `${total} open high in ${rows.length} project(s): ${named.join(', ')}${more}`
}
