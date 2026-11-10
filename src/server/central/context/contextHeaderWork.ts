// Open-work section of the state header: one grouped query per concern, never one per project.
import type { Database } from 'bun:sqlite'
import { BOARD_COLUMNS, WORK_STATUSES, WORK_TERMINAL, boardColumnOf, type BoardColumn, type WorkStatus } from '../../../shared/centralWork'
import { allRows } from '../../ledger/ledgerCore'
import { redactSecrets } from '../../redactSecrets'
import { taskCards } from '../work/workBoard'
import { createWorkStore } from '../work/workStore'

/** Open assignments listed per project before the shrink. */
export const MAX_OPEN_ASSIGNMENTS = 8
const MAX_WORK_PROJECTS = 20
const TASK_FETCH_LIMIT = 200
const MAX_TITLE = 60
const MAX_NODE = 40
const MINUTE_MS = 60_000
const OPEN_STATUSES = WORK_STATUSES.filter((s) => !WORK_TERMINAL.includes(s))

export interface NeedsYou { waiting_input: number; needs_review: number; stalled: number; failed: number }
export interface OpenAssignment { task: string; node: string; status: WorkStatus; quietMin: number }
export interface ProjectWork {
  id: string
  name: string
  columns: Record<BoardColumn, number>
  needsYou: NeedsYou
  liveAgents: number
  open: OpenAssignment[]
}
export interface OpenWork { needsYou: NeedsYou; projects: ProjectWork[] }

const noNeeds = (): NeedsYou => ({ waiting_input: 0, needs_review: 0, stalled: 0, failed: 0 })
const noColumns = (): Record<BoardColumn, number> => Object.fromEntries(Object.keys(BOARD_COLUMNS).map((c) => [c, 0])) as Record<BoardColumn, number>
const needTotal = (n: NeedsYou): number => n.waiting_input + n.needs_review + n.stalled + n.failed

/** Counts for every project with open work, most attention first, plus the totals that outlive any shrink. */
export function openWork(db: Database, now: number): OpenWork {
  const needsYou = noNeeds()
  const byProject = new Map<string, ProjectWork>()
  const withOpen = new Set<string>()
  for (const r of allRows(db, 'SELECT t.project_id, p.name, t.status, COUNT(*) AS n FROM central_task t JOIN project p ON p.id = t.project_id GROUP BY t.project_id, p.name, t.status')) {
    const id = String(r.project_id)
    const status = r.status as WorkStatus
    const n = Number(r.n)
    const entry = byProject.get(id) ?? { id, name: redactSecrets(String(r.name)).slice(0, MAX_NODE), columns: noColumns(), needsYou: noNeeds(), liveAgents: 0, open: [] }
    byProject.set(id, entry)
    entry.columns[boardColumnOf(status)] += n
    if (OPEN_STATUSES.includes(status)) withOpen.add(id)
    if (status in needsYou) {
      entry.needsYou[status as keyof NeedsYou] += n
      needsYou[status as keyof NeedsYou] += n
    }
  }
  for (const r of allRows(db, 'SELECT project_id, COUNT(*) AS n FROM central_agents WHERE ended_at IS NULL GROUP BY project_id')) {
    const entry = byProject.get(String(r.project_id))
    if (entry) entry.liveAgents = Number(r.n)
  }
  const signalAt = new Map<OpenAssignment, number>()
  for (const card of taskCards(db, createWorkStore(db, () => now).listTasks({ statuses: OPEN_STATUSES, limit: TASK_FETCH_LIMIT }))) {
    const a = card.assignment
    if (a === null || a.endedAt !== null) continue
    const at = a.lastSignalAt ?? a.startedAt
    const open = { task: redactSecrets(card.title).slice(0, MAX_TITLE), node: (card.nodeName ?? a.nodeId).slice(0, MAX_NODE), status: card.status, quietMin: Math.max(0, Math.floor((now - at) / MINUTE_MS)) }
    signalAt.set(open, at)
    byProject.get(card.projectId)?.open.push(open)
  }
  const projects = [...byProject.values()].filter((p) => withOpen.has(p.id))
  for (const p of projects) p.open = p.open.sort((a, b) => (signalAt.get(a) as number) - (signalAt.get(b) as number) || a.task.localeCompare(b.task)).slice(0, MAX_OPEN_ASSIGNMENTS)
  projects.sort((a, b) => needTotal(b.needsYou) - needTotal(a.needsYou) || a.id.localeCompare(b.id))
  return { needsYou, projects: projects.slice(0, MAX_WORK_PROJECTS) }
}
