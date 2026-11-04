// Agents list for the /m PWA: every agent node on every board, its live status and the last thing
// it said (the redacted `preview` the hook producer already stores on `hook.*` events).
import type { Database } from 'bun:sqlite'
import type { AgentStatus, Workspace } from '../../shared/workspace'
import { allRows } from '../ledger/ledgerCore'

/** Recent hook events scanned for last messages; older agents show none. */
const EVENT_WINDOW = 5000
const PREVIEW_MAX = 280

export interface MobileAgent {
  nodeId: string
  workspaceId: string
  workspace: string
  title: string
  agentId: string
  status: AgentStatus | null
  live: boolean
  lastMessage: string | null
  lastAt: number | null
}

/** nodeId -> newest hook preview; one query over the newest rows (no per-node lookup). */
export function lastMessages(db: Database | null, nodeIds: ReadonlySet<string>): Map<string, { text: string; at: number }> {
  const out = new Map<string, { text: string; at: number }>()
  if (!db || nodeIds.size === 0) return out
  // ponytail: fixed window over the PK; an index on (node_id, seq) if boards ever outgrow it.
  const rows = allRows(db, `SELECT node_id, ts, json_extract(payload_json, '$.preview') AS preview FROM event
    WHERE seq > (SELECT COALESCE(MAX(seq), 0) FROM event) - ? AND kind >= 'hook.' AND kind < 'hook/'
      AND node_id IS NOT NULL AND json_extract(payload_json, '$.preview') IS NOT NULL
    ORDER BY seq DESC`, EVENT_WINDOW)
  for (const r of rows) {
    const id = String(r['node_id'])
    if (!nodeIds.has(id) || out.has(id)) continue
    const text = String(r['preview'])
    out.set(id, { text: text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text, at: Number(r['ts']) })
    if (out.size === nodeIds.size) break
  }
  return out
}

export interface MobileAgentDeps {
  workspaces(): Workspace[]
  statusOf(id: string): AgentStatus | undefined
  isLive(id: string): boolean
  ledgerDb(): Database | null
}

/** Live agents first, then by board and title. */
export function listMobileAgents(deps: MobileAgentDeps): MobileAgent[] {
  const agents: MobileAgent[] = []
  for (const ws of deps.workspaces()) {
    for (const n of ws.nodes) {
      if (!n.agentId) continue
      agents.push({
        nodeId: n.id, workspaceId: ws.id, workspace: ws.name, title: n.title?.trim() || n.agentId, agentId: n.agentId,
        status: deps.statusOf(n.id) ?? null, live: deps.isLive(n.id), lastMessage: null, lastAt: null,
      })
    }
  }
  const last = lastMessages(deps.ledgerDb(), new Set(agents.map((a) => a.nodeId)))
  for (const a of agents) {
    const m = last.get(a.nodeId)
    if (m) { a.lastMessage = m.text; a.lastAt = m.at }
  }
  return agents.sort((a, b) => Number(b.live) - Number(a.live) || a.workspace.localeCompare(b.workspace) || a.title.localeCompare(b.title))
}
