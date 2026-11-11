// State header (RND/23 §4.4): the time, open work and what needs attention, <= 4000 chars, JSON keys in
// fixed order. It carries the clock, so it must stay after the stable prefix (promptPrefix.ts), which is
// what keeps the provider cache alive. Details are read on demand through tools.
import type { Database } from 'bun:sqlite'
import { getRow } from '../../ledger/ledgerCore'
import { livePortfolio, projectWorkspace } from '../workspaceLookup'
import { scopeFromConversationId } from '../conversationModel'
import { MAX_OPEN_ASSIGNMENTS, healthLine, openWork } from './contextHeaderWork'

/** Hard cap of the header text. */
export const HEADER_MAX_CHARS = 4000
const PROJECT_FETCH_LIMIT = 50
/** Project-list entries kept while open-work detail is still being shrunk. */
const PROJECT_LIST_FLOOR = 10
const MAX_NAME = 40

/** The workspace the user is viewing, as its ledger project. */
export interface Viewing { projectId: string; name: string }

// Id of the active workspace (webterm.db `app.active`, written on every UI switch). A different file from
// the ledger, so it comes through a port: canvasPush.runtime.ts registers it at boot; tests register fakes.
let activeSource: () => string | null = () => null

/** Registers where the active workspace id is read from; returns the unregister. */
export function registerActiveWorkspace(get: () => string | null): () => void {
  activeSource = get
  return () => { activeSource = () => null }
}

/** The project of the workspace the user is viewing; null when none is active or it no longer exists. */
export function viewingProject(ledger: Database): Viewing | null {
  const active = activeSource()
  if (!active) return null
  // A workspace's own project has id = workspace id (livePortfolio); prefer it over any older link.
  const row = getRow(ledger, 'SELECT id FROM project WHERE workspace_id = ? ORDER BY (id = workspace_id) DESC, id LIMIT 1', active)
  if (!row) return null
  const projectId = String(row['id'])
  const ws = projectWorkspace(ledger, projectId)
  return ws.ok ? { projectId, name: ws.name.slice(0, MAX_NAME) } : null
}

/** Local date and time with weekday and timezone, to the minute. */
export function headerClock(now: number, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const text = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short', timeZone }).format(now)
  return `${text} (${timeZone})`
}

/**
 * Renders the header for a conversation scope and shrinks it to the cap in a fixed order: long project list,
 * open assignments, the rest of the project list, per-project work. `time`, `needsYou`, `health` and `viewing` always stay.
 * Every canvas workspace is listed even in a project chat (Telegram binds one): `scope` names the bound one.
 */
export function buildStateHeader(db: Database, conversationId: string, now = Date.now(), timeZone?: string): string {
  const scope = scopeFromConversationId(conversationId)
  const page = livePortfolio(db, { limit: PROJECT_FETCH_LIMIT })
  const viewing = viewingProject(db)
  const projects = page.items.map((p) => ({ approvals: p.pendingApprovals, id: p.id, name: p.name.slice(0, MAX_NAME), status: p.status }))
  const work = openWork(db, now)
  const time = headerClock(now, timeZone)
  const health = healthLine(db, scope.kind === 'project' ? scope.projectId : null, now)
  const size = { list: projects.length, open: MAX_OPEN_ASSIGNMENTS, work: work.projects.length }
  const render = (): string => `State: ${JSON.stringify({
    time,
    needsYou: work.needsYou,
    health,
    work: work.projects.slice(0, size.work).map((p) => ({ ...p, open: p.open.slice(0, size.open) })),
    projectTotal: page.total,
    projects: projects.slice(0, size.list),
    scope: scope.kind === 'project' ? scope.projectId : 'global',
    viewing,
  })}`
  const shrink: Array<() => boolean> = [
    () => size.list > PROJECT_LIST_FLOOR && (size.list -= 1, true),
    () => size.open > 0 && (size.open -= 1, true),
    () => size.list > 0 && (size.list -= 1, true),
    () => size.work > 0 && (size.work -= 1, true),
  ]
  for (const step of shrink) while (render().length > HEADER_MAX_CHARS && step());
  return render()
}
