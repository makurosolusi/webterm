// Nodes Central itself closed with canvas.close, so canvas.reopen can bring back exactly those and never one the
// human closed. Lives in webterm.db next to the human's closed_history (schema: sessionHistory.store.ts).
import type { BridgeLink, WsNode } from '../../shared/workspace'
import type { HistoryDb } from '../sessionHistory.store'

/** Most records kept per workspace; the oldest fall off (a reopen is for "I just closed it", not an archive). */
export const CENTRAL_CLOSED_CAP = 20

export interface CentralClosed { workspaceId: string; node: WsNode; bridges: BridgeLink[]; closedAt: number }

/** Remembers `entries` (snapshots taken BEFORE the removal), then trims the workspace to the cap. */
export function recordCentralClosed(db: HistoryDb, entries: readonly CentralClosed[]): void {
  const ins = db.query('INSERT OR REPLACE INTO central_closed (node_id, workspace_id, closed_at, node, bridges) VALUES (?, ?, ?, ?, ?)')
  for (const e of entries) {
    ins.run(e.node.id, e.workspaceId, e.closedAt, JSON.stringify(e.node), e.bridges.length ? JSON.stringify(e.bridges) : null)
    db.query('DELETE FROM central_closed WHERE workspace_id = ? AND node_id NOT IN (SELECT node_id FROM central_closed WHERE workspace_id = ? ORDER BY closed_at DESC, rowid DESC LIMIT ?)')
      .run(e.workspaceId, e.workspaceId, CENTRAL_CLOSED_CAP)
  }
}

interface Row { workspace_id: string; closed_at: number; node: string; bridges: string | null }
const toEntry = (r: Row): CentralClosed => ({
  workspaceId: r.workspace_id, closedAt: r.closed_at, node: JSON.parse(r.node) as WsNode,
  bridges: r.bridges ? (JSON.parse(r.bridges) as BridgeLink[]) : [],
})

/** Central's closes of one workspace, newest first. */
export function listCentralClosed(db: HistoryDb, workspaceId: string): CentralClosed[] {
  return (db.query('SELECT * FROM central_closed WHERE workspace_id = ? ORDER BY closed_at DESC, rowid DESC').all(workspaceId) as Row[]).map(toEntry)
}

/** Forgets one record (after a reopen). */
export function forgetCentralClosed(db: HistoryDb, nodeId: string): void {
  db.query('DELETE FROM central_closed WHERE node_id = ?').run(nodeId)
}

/** The human's own closed-history row for `nodeId` (its `closedAt`), or null. */
export function humanClosedAt(db: HistoryDb, nodeId: string): number | null {
  const r = db.query('SELECT closed_at FROM closed_history WHERE node_id = ?').get(nodeId) as { closed_at: number } | null
  return r ? r.closed_at : null
}
