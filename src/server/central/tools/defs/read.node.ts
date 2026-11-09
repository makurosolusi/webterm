// node.list (R0): the canvas nodes of a project's workspace (id, name, kind, title, agent kind), paginated.
// Terminals/agents report whether a PTY session is alive; browsers report their host only. Reads the
// persisted workspace row; never returns cwd, launch command, session ids, full URLs or comments.
import { hostOnly } from '../../../../shared/browser.url'
import { sessionIdsOf } from '../../../../shared/paneSessions'
import { withNodeNames } from '../../../../shared/nodeNames'
import type { Pane } from '../../../../shared/workspace'
import { projectWorkspace } from '../../workspaceLookup'
import type { ToolDef, ToolResult } from '../toolTypes'
import { clip, MAX_PAGE, READ_TOOLS_FLAG, readPage } from './read.shared'
import { createNodeSightDef, type NodeSightDeps } from './read.node.inspect'
import { obj, S } from '../../../capability/capability.schema'

const MAX_TITLE = 80
const PTY_KINDS = new Set(['terminal', 'agent'])
interface StoredNode { id?: unknown; name?: unknown; kind?: unknown; title?: unknown; agentId?: unknown; url?: unknown; panes?: Pane }

export interface NodeReadDeps extends NodeSightDeps {
  /** Session liveness, resolved per call (production: the process-wide sessions); absent = no `live` field. */
  live?(): ((sessionId: string) => boolean) | Promise<(sessionId: string) => boolean>
}

/** Builds the R0 node tools: node.list and node.inspect. */
export function createNodeReadDefs(deps: NodeReadDeps = {}): ToolDef[] {
  const nodeList: ToolDef = {
    name: 'node.list',
    summary: 'List the canvas nodes (terminals, agents, browsers, files) of a project workspace, with names, paginated.',
    tier: 'R0',
    flag: READ_TOOLS_FLAG,
    usage: '{"projectId":"<id>","limit":<1-50, default 20>,"offset":<default 0>}. Read-only. Terminals/agents carry '
      + '`live` (session running), browsers their `host`. `name` is the node\'s unique handle (e.g. "Mango") the user '
      + 'refers to; ids or names feed canvas.close.',
    input: obj({ limit: S.int(1, MAX_PAGE), offset: S.int(0) }),
    output: S.keys('workspace', 'total', 'offset', 'items', 'nextOffset'),
    validate: (input) => (readPage(input) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const { limit, offset } = readPage(input)!
      // Workspaces live in webterm.db, not the ledger file: resolved through the registered store.
      const found = projectWorkspace(ctx.db, projectId)
      if (!found.ok) return { ok: false, code: found.code }
      const nodes = found.nodes as StoredNode[]
      const isLive = deps.live ? await deps.live() : null
      // The store already names nodes (Db); re-deriving is deterministic, so any store reads the same names.
      const named = withNodeNames(nodes.map((n) => ({ id: String(n.id), name: typeof n.name === 'string' ? n.name : undefined })))
      const items = nodes.slice(offset, offset + limit).map((n, i) => {
        const id = String(n.id)
        const kind = String(n.kind)
        return {
          id, name: named[offset + i].name, kind,
          title: typeof n.title === 'string' ? clip(n.title, MAX_TITLE) : null,
          agentId: typeof n.agentId === 'string' ? n.agentId : null,
          ...(isLive && PTY_KINDS.has(kind) ? { live: sessionIdsOf(n.panes, id).some(isLive) } : {}),
          ...(kind === 'browser' && typeof n.url === 'string' ? { host: hostOnly(n.url) } : {}),
        }
      })
      return {
        ok: true,
        data: { workspace: found.name, total: nodes.length, offset, items, nextOffset: offset + limit < nodes.length ? offset + limit : null },
      }
    },
  }
  return [nodeList, createNodeSightDef(deps)]
}
