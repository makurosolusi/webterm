// Deterministic state header (RND/23 §4.4): counts and ids that need attention, <= 2000 chars,
// JSON keys in fixed order, no clock. Details are read on demand through tools.
import type { Database } from 'bun:sqlite'
import { getRow } from '../../ledger/ledgerCore'
import { livePortfolio, projectWorkspace } from '../workspaceLookup'
import { scopeFromConversationId } from '../conversationModel'

/** Hard cap of the header text. */
export const HEADER_MAX_CHARS = 2000
const PROJECT_FETCH_LIMIT = 50
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

/**
 * Renders the header for a conversation scope; shrinks the project list until it fits the cap.
 * Every canvas workspace is listed even in a project chat (Telegram binds one): `scope` names the bound one.
 * `viewing` is never shrunk away: it is how Central knows what the user has on screen.
 */
export function buildStateHeader(db: Database, conversationId: string): string {
  const scope = scopeFromConversationId(conversationId)
  const page = livePortfolio(db, { limit: PROJECT_FETCH_LIMIT })
  const viewing = viewingProject(db)
  const projects = page.items.map((p) => ({ approvals: p.pendingApprovals, id: p.id, name: p.name.slice(0, MAX_NAME), status: p.status }))
  const render = (count: number): string => `State: ${JSON.stringify({
    projectTotal: page.total,
    projects: projects.slice(0, count),
    scope: scope.kind === 'project' ? scope.projectId : 'global',
    viewing,
  })}`
  let count = projects.length
  while (count > 0 && render(count).length > HEADER_MAX_CHARS) count -= 1
  return render(count)
}
