// node.list (R0): the canvas nodes of a project's workspace (id, kind, title, agent kind), paginated.
// Reads the persisted workspace row; never returns cwd, launch command, session ids or comments.
import { projectWorkspace } from '../../workspaceLookup'
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
    // Workspaces live in webterm.db, not the ledger file: resolved through the registered store.
    const found = projectWorkspace(ctx.db, projectId)
    if (!found.ok) return { ok: false, code: found.code }
    const nodes = found.nodes as StoredNode[]
    const items = nodes.slice(offset, offset + limit).map((n) => ({
      id: String(n.id), kind: String(n.kind),
      title: typeof n.title === 'string' ? clip(n.title, MAX_TITLE) : null,
      agentId: typeof n.agentId === 'string' ? n.agentId : null,
    }))
    return {
      ok: true,
      data: { workspace: found.name, total: nodes.length, offset, items, nextOffset: offset + limit < nodes.length ? offset + limit : null },
    }
  },
}

/** R0 node list tool. */
export const NODE_READ_DEFS: readonly ToolDef[] = [nodeList]
