// World view (PLAN 01 K5): one read-only connection that ATTACHes ledger.db to webterm.db, so every
// surface (Central portfolio, Telegram, Control) counts projects/workspaces/agents/tasks the same way.
// Read-only by construction: the main file is opened `readonly`, and SQLite opens ATTACHed files with
// the main connection's flags, so a stray write fails. The files are NOT merged (K5: data-loss risk).
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, dbPath } from './config'

/** Task states still in flight (everything except verified/failed/cancelled). */
const OPEN_TASK_STATES = ['pending', 'leased', 'suspect', 'claimed_done', 'blocked', 'reopened'] as const

export interface WorldCounts {
  workspaces: number
  /** Canvas nodes across all workspaces, and those running an agent (`agentId` set). */
  nodes: number
  agentNodes: number
  /** null when the ledger file does not exist yet (ledger never started). */
  ledger: {
    /** Ledger projects whose workspace still exists on the canvas (what the portfolio lists). */
    projects: number
    /** Ledger projects whose workspace was deleted. */
    orphanProjects: number
    agents: number
    tasks: { total: number; open: number; byStatus: Record<string, number> }
  } | null
}

export interface WorldPaths { webterm: string; ledger: string }
export const defaultWorldPaths = (): WorldPaths => ({ webterm: dbPath(), ledger: join(dataDir(), 'ledger.db') })

// bun:sqlite's real API; the repo's type shim (bun-test.d.ts) only declares exec/query.
type RoDb = Database & { close(): void }
const openReadonly = (file: string): RoDb => new (Database as unknown as new (f: string, o: { readonly: boolean }) => RoDb)(file, { readonly: true })

const n = (row: unknown, col = 'n'): number => Number((row as Record<string, unknown> | null)?.[col] ?? 0)

/** Counts across both DBs; opens and closes its own read-only connection per call. */
export function worldCounts(paths: WorldPaths = defaultWorldPaths()): WorldCounts {
  let db: RoDb
  try {
    db = openReadonly(paths.webterm)
  } catch (err) {
    throw new Error(`worldView: cannot open ${paths.webterm} read-only: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    const canvas = db.query(
      `SELECT COUNT(DISTINCT w.id) AS workspaces, COUNT(j.key) AS nodes,
         COALESCE(SUM(CASE WHEN json_extract(j.value, '$.agentId') IS NOT NULL THEN 1 ELSE 0 END), 0) AS agentNodes
       FROM workspace w LEFT JOIN json_each(CASE WHEN json_valid(w.nodes) THEN w.nodes ELSE '[]' END) j`,
    ).get() as Record<string, unknown>
    const out: WorldCounts = { workspaces: n(canvas, 'workspaces'), nodes: n(canvas, 'nodes'), agentNodes: n(canvas, 'agentNodes'), ledger: null }
    if (!existsSync(paths.ledger)) return out
    db.query('ATTACH DATABASE ? AS l').run(paths.ledger)
    const live = 'p.workspace_id IN (SELECT id FROM main.workspace)'
    const byStatus: Record<string, number> = {}
    for (const r of db.query(`SELECT t.status AS status, COUNT(*) AS n FROM l.task t JOIN l.project p ON p.id = t.project_id WHERE ${live} GROUP BY t.status`).all()) {
      byStatus[String((r as Record<string, unknown>)['status'])] = n(r)
    }
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0)
    out.ledger = {
      projects: n(db.query(`SELECT COUNT(*) AS n FROM l.project p WHERE ${live}`).get()),
      orphanProjects: n(db.query(`SELECT COUNT(*) AS n FROM l.project p WHERE NOT ${live}`).get()),
      agents: n(db.query(`SELECT COUNT(*) AS n FROM l.agent a JOIN l.project p ON p.id = a.project_id WHERE ${live}`).get()),
      tasks: { total, open: OPEN_TASK_STATES.reduce((a, s) => a + (byStatus[s] ?? 0), 0), byStatus },
    }
    return out
  } finally {
    db.close()
  }
}
