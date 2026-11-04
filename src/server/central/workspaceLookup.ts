// Workspace store port for central code. Workspaces live in webterm.db (`src/server/db.ts`), a
// different SQLite file from the ledger, so ledger SQL can never JOIN them; boot registers the store.
import type { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { allRows, execWrite, getRow } from '../ledger/ledgerCore'
import { projectRepository } from '../ledger/ledgerEntity'
import { portfolio } from './centralProjection'
import type { PortfolioOptions, PortfolioPage } from './centralModel'

/** The fields of a stored workspace central code reads. */
export interface WorkspaceRecord { id?: string; name: string; cwd?: string; nodes?: unknown; updatedAt?: number }
/** Workspace store lookup by id; may throw when the stored blob is corrupt. */
export type WorkspaceLookup = (id: string) => WorkspaceRecord | null
/** Every stored workspace, most recently updated first. */
export type WorkspaceList = () => WorkspaceRecord[]

let store: { get: WorkspaceLookup; list?: WorkspaceList } | null = null

/** Registers the workspace store (boot); returns the unregister. */
export function registerWorkspaceLookup(get: WorkspaceLookup, list?: WorkspaceList): () => void {
  store = { get, list }
  return () => { store = null }
}

/** One workspace by id, null when unknown or no store is registered. */
export function lookupWorkspace(id: string): WorkspaceRecord | null {
  return store ? store.get(id) : null
}

/** All workspaces, or null when no store (or no list) is registered. */
export function listWorkspaces(): WorkspaceRecord[] | null {
  return store?.list ? store.list() : null
}

/**
 * Ensures one ledger project per stored workspace (new id = workspace id) and copies renames.
 * Idempotent; returns the live workspace ids, or null when no store is registered (ledger-only).
 * Two statements regardless of workspace count; writes only for new or renamed workspaces.
 */
export function syncWorkspaceProjects(ledger: Database, now: () => number = Date.now): string[] | null {
  const workspaces = listWorkspaces()
  if (workspaces === null) return null
  const linked = new Map<string, { id: string; name: string }>()
  for (const r of allRows(ledger, 'SELECT id, workspace_id, name FROM project')) {
    linked.set(String(r['workspace_id']), { id: String(r['id']), name: String(r['name']) })
  }
  const repo = projectRepository({ db: ledger, now })
  const live: string[] = []
  for (const ws of workspaces) {
    if (!ws.id || !ws.name) continue
    live.push(ws.id)
    const row = linked.get(ws.id)
    if (!row) repo.createProject({ id: ws.id, workspaceId: ws.id, name: ws.name, path: ws.cwd || homedir() })
    else if (row.name !== ws.name) execWrite(ledger, 'UPDATE project SET name = ?, updated_at = ? WHERE id = ?', ws.name, now(), row.id)
  }
  return live
}

/** Portfolio of canvas workspaces: synced first, deleted workspaces excluded; ledger-only without a store. */
export function livePortfolio(ledger: Database, opts: PortfolioOptions = {}): PortfolioPage {
  const live = syncWorkspaceProjects(ledger)
  return portfolio(ledger, live === null ? opts : { ...opts, workspaceIds: live })
}

export type ProjectWorkspace =
  | { ok: true; workspaceId: string; name: string; nodes: unknown[] }
  | { ok: false; code: 'workspace_unavailable' | 'workspace_not_found' | 'workspace_corrupt' }

/** The workspace of a ledger project: project row from the ledger, workspace from the registered store. */
export function projectWorkspace(ledger: Database, projectId: string | undefined): ProjectWorkspace {
  if (!store) return { ok: false, code: 'workspace_unavailable' }
  const row = getRow(ledger, 'SELECT workspace_id FROM project WHERE id = ?', projectId ?? null)
  if (!row || row['workspace_id'] == null) return { ok: false, code: 'workspace_not_found' }
  const workspaceId = String(row['workspace_id'])
  let ws: WorkspaceRecord | null
  try {
    ws = store.get(workspaceId)
  } catch {
    return { ok: false, code: 'workspace_corrupt' } // `Db.get` parses the blob; its message would quote it
  }
  if (!ws) return { ok: false, code: 'workspace_not_found' }
  if (!Array.isArray(ws.nodes)) return { ok: false, code: 'workspace_corrupt' }
  return { ok: true, workspaceId, name: ws.name, nodes: ws.nodes }
}
