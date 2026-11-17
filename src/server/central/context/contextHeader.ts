// State header (RND/23 §4.4): the time, open work and what needs attention, <= 4000 chars, JSON keys in
// fixed order. It carries the clock, so it must stay after the stable prefix (promptPrefix.ts), which is
// what keeps the provider cache alive. Details are read on demand through tools.
import type { Database } from 'bun:sqlite'
import { allRows, getRow } from '../../ledger/ledgerCore'
import { livePortfolio, projectWorkspace } from '../workspaceLookup'
import { approvalLevelFor, approvalModeName, type ApprovalModeName, type ApprovalSettings } from '../../../shared/settings.projectApprovalLevels'
import { scopeFromConversationId } from '../conversationModel'
import { MAX_OPEN_ASSIGNMENTS, duties, healthLine, openWork } from './contextHeaderWork'

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

// Workspace identity colors live in webterm.db too ("blue vivid" per workspace id; a workspace's own project has
// id = workspace id), so they come through a port as well: the header names the color so Central can say which
// workspace it is in ("the indigo one") and the user can recognise it by color.
let colorSource: () => ReadonlyMap<string, string> = () => new Map()

/** Registers where the workspace colors are read from; returns the unregister. */
export function registerWorkspaceColors(get: () => ReadonlyMap<string, string>): () => void {
  colorSource = get
  return () => { colorSource = () => new Map() }
}

// Approval settings live in webterm.db too, so they come through the same kind of port (canvasPush.runtime.ts).
let settingsSource: () => ApprovalSettings | null = () => null

/** Registers where the approval settings are read from; returns the unregister. */
export function registerApprovalSettings(get: () => ApprovalSettings | null): () => void {
  settingsSource = get
  return () => { settingsSource = () => null }
}

/** Approval mode per project id (its workspace override, else the global level); empty without settings. */
function approvalModes(ledger: Database, projectIds: string[]): Map<string, ApprovalModeName> {
  const out = new Map<string, ApprovalModeName>()
  const s = settingsSource()
  if (!s || projectIds.length === 0) return out
  const ws = workspaceIdsOf(ledger, projectIds)
  for (const id of projectIds) out.set(id, approvalModeName(approvalLevelFor(s, ws.get(id) ?? null)))
  return out
}

/** Workspace id per project id (null = not linked to a workspace); one statement for the whole list. */
function workspaceIdsOf(ledger: Database, projectIds: string[]): Map<string, string | null> {
  if (projectIds.length === 0) return new Map()
  const rows = allRows(ledger, `SELECT id, workspace_id FROM project WHERE id IN (${projectIds.map(() => '?').join(',')})`, ...projectIds)
  return new Map(rows.map((r) => [String(r['id']), r['workspace_id'] == null ? null : String(r['workspace_id'])]))
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
 * open assignments, the rest of the project list, per-project work. `time`, `needsYou`, `openDuties`, `health` and `viewing` always stay.
 * Every canvas workspace is listed even in a project chat (Telegram binds one): `scope` names the bound one.
 */
export function buildStateHeader(db: Database, conversationId: string, now = Date.now(), timeZone?: string): string {
  const scope = scopeFromConversationId(conversationId)
  const page = livePortfolio(db, { limit: PROJECT_FETCH_LIMIT })
  const viewing = viewingProject(db)
  const colors = colorSource()
  const wsOf = workspaceIdsOf(db, [...page.items.map((p) => p.id), ...(viewing ? [viewing.projectId] : [])])
  const colorOf = (projectId: string): string | undefined => colors.get(wsOf.get(projectId) ?? '')
  const modes = approvalModes(db, page.items.map((p) => p.id))
  // `approval` = the mode that decides whether a tool call shows a card (ask) or just runs (auto/danger).
  const projects = page.items.map((p) => ({ approval: modes.get(p.id), approvals: p.pendingApprovals, id: p.id, name: p.name.slice(0, MAX_NAME), status: p.status, color: colorOf(p.id) }))
  const work = openWork(db, now)
  const openDuties = duties(db, now)
  const time = headerClock(now, timeZone)
  const health = healthLine(db, scope.kind === 'project' ? scope.projectId : null, now)
  const size = { list: projects.length, open: MAX_OPEN_ASSIGNMENTS, work: work.projects.length }
  const render = (): string => `State: ${JSON.stringify({
    time,
    needsYou: work.needsYou,
    openDuties,
    health,
    work: work.projects.slice(0, size.work).map((p) => ({ ...p, open: p.open.slice(0, size.open) })),
    projectTotal: page.total,
    projects: projects.slice(0, size.list),
    scope: scope.kind === 'project' ? scope.projectId : 'global',
    viewing: viewing ? { ...viewing, color: colorOf(viewing.projectId) } : null,
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
