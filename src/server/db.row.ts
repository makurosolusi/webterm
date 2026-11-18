// Row <-> Workspace mapping of the `workspace` table (read side only; every write stays in db.ts).
import type { Workspace } from '../shared/workspace'
import { normalizeWorkspace } from '../shared/workspace.schema'
import { withNodeNames } from '../shared/nodeNames'
import { workspaceLog } from './workspacesLog'
import { parseLayout } from './db.layout'

export interface Row {
  id: string
  name: string
  cwd: string | null
  color: string | null
  color_shade: string
  viewport: string
  nodes: string
  bridges: string
  layout: string
  updated_at: number
  position: number | null
}

// Every read carries the stored display order (`db.order.ts`); a row without one (cannot happen after boot) sorts last.
export const SELECT_WS = 'SELECT w.*, p.position FROM workspace w LEFT JOIN workspace_position p ON p.workspace_id = w.id'
export const ORDER_WS = 'ORDER BY p.position IS NULL, p.position ASC, w.updated_at DESC, w.id DESC'

/** Column text -> value; unparsable -> `null`, which the schema then reports and replaces. */
export function parseColumn(raw: string | null | undefined, absent: string): unknown {
  try {
    return JSON.parse(raw ?? absent)
  } catch {
    return null // a truncated/hand-edited blob: normalizeWorkspace turns it into a default + an issue
  }
}

/**
 * Row -> workspace through the shared schema, so one bad blob or node degrades THAT board (hidden
 * node, default viewport, warning with the id) instead of throwing out of `list()` for every board.
 * A hidden node with an id stays in the row: `Db.nodesColumn` carries it through every write.
 */
export function toWorkspace(r: Row): Workspace {
  const { board, issues, preserved } = normalizeWorkspace({
    name: r.name, cwd: r.cwd, color: r.color, colorShade: r.color_shade,
    viewport: parseColumn(r.viewport, ''), nodes: parseColumn(r.nodes, ''), bridges: parseColumn(r.bridges, '[]'),
  })
  if (issues.length > 0) workspaceLog.repaired(r.id, issues)
  if (preserved.length > 0) workspaceLog.nodesPreserved(r.id, preserved)
  // Named on read too: legacy rows get the same names `nodesColumn` will store on their next save.
  return { id: r.id, ...board, nodes: withNodeNames(board.nodes), name: r.name, layout: parseLayout(r.layout), position: r.position ?? undefined, updatedAt: r.updated_at }
}
