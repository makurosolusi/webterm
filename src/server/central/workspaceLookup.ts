// Workspace store port for central code. Workspaces live in webterm.db (`src/server/db.ts`), a
// different SQLite file from the ledger, so ledger SQL can never JOIN them; boot registers the store.
import type { Database } from 'bun:sqlite'
import { getRow } from '../ledger/ledgerCore'

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
