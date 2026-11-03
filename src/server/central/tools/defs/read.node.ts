// node.list (R0): the canvas nodes of a project's workspace (id, kind, title, agent kind), paginated.
// Reads the persisted workspace row; never returns cwd, launch command, session ids or comments.
import { getRow } from '../../../ledger/ledgerCore'
import type { ToolDef, ToolResult } from '../toolTypes'
import { clip, READ_TOOLS_FLAG, readPage } from './read.shared'

const MAX_TITLE = 80
interface StoredNode { id?: unknown; kind?: unknown; title?: unknown; agentId?: unknown }

const nodeList: ToolDef = {
  name: 'node.list',
  summary: 'List the canvas nodes (terminals, agents, files) of a project workspace, paginated.',
  tier: 'R0',
  flag: READ_TOOLS_FLAG,
  usage: '{"projectId":"<id>","limit":<1-50, default 20>,"offset":<default 0>}. Read-only.',
  validate: (input) => (readPage(input) ? null : 'invalid_shape'),
  handler(ctx, input, projectId): ToolResult {
    const { limit, offset } = readPage(input)!
    // The workspace table lives in the same file but is created by `openDb`, not the ledger schema.
    if (!getRow(ctx.db, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'workspace'")) {
      return { ok: false, code: 'workspace_unavailable' }
    }
    const row = getRow(
      ctx.db, 'SELECT w.name AS name, w.nodes AS nodes FROM workspace w JOIN project p ON p.workspace_id = w.id WHERE p.id = ?', projectId
    )
    if (!row) return { ok: false, code: 'workspace_not_found' }
    let nodes: StoredNode[]
    try {
      const parsed: unknown = JSON.parse(String(row['nodes']))
      if (!Array.isArray(parsed)) return { ok: false, code: 'workspace_corrupt' }
      nodes = parsed as StoredNode[]
    } catch {
      return { ok: false, code: 'workspace_corrupt' } // parse message dropped: it quotes the stored blob
    }
    const items = nodes.slice(offset, offset + limit).map((n) => ({
      id: String(n.id), kind: String(n.kind),
      title: typeof n.title === 'string' ? clip(n.title, MAX_TITLE) : null,
      agentId: typeof n.agentId === 'string' ? n.agentId : null,
    }))
    return {
      ok: true,
      data: { workspace: String(row['name']), total: nodes.length, offset, items, nextOffset: offset + limit < nodes.length ? offset + limit : null },
    }
  },
}

/** R0 node list tool. */
export const NODE_READ_DEFS: readonly ToolDef[] = [nodeList]
