// canvas.view (R0) / canvas.show (R1): what the user has on screen, and switching the user's visible canvas
// to another project workspace (optionally centring one node). The active workspace is global (last
// switch wins, webterm.db `app.active`); canvas.show writes it and tells every open UI tab to follow.
import { isNodeName, withNodeNames } from '../../../../shared/nodeNames'
import type { ServerMsg } from '../../../../shared/protocol'
import { viewingProject } from '../../context/contextHeader'
import { projectWorkspace, syncWorkspaceProjects } from '../../workspaceLookup'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { obj, S } from '../../../capability/capability.schema'
import { clip, isSafeId, MAX_ID, READ_TOOLS_FLAG } from './read.shared'

/** The UI side canvas.show drives (tests pass a fake). */
export interface ViewUi {
  /** Persist `workspaceId` as the active workspace (what the header's `viewing` reads back). */
  setActive(workspaceId: string): void
  /** Send one frame to every open UI socket. */
  broadcast(msg: ServerMsg): void
}
export interface CanvasViewDeps {
  /** Resolved per call so the runtime (webterm.db + broadcaster) is only loaded when a tool runs. */
  ui(): ViewUi | Promise<ViewUi>
}

const MAX_NODES = 50
const MAX_TITLE = 80

interface StoredNode { id?: unknown; name?: unknown; kind?: unknown; title?: unknown }
const onlyKeys = (input: ToolInput, allowed: readonly string[]): boolean => Object.keys(input).every((k) => allowed.includes(k))
const fail = (code: string, data?: Record<string, unknown>): ToolResult => ({ ok: false, code, ...(data ? { data } : {}) })
/** A node id, or a node name as `withNodeNames` mints it ("Mango", tier "Mango 2") in any case. */
const isNodeRef = (v: unknown): boolean => isSafeId(v) || isNodeName(v, true)
const named = (nodes: unknown[]) => withNodeNames((nodes as StoredNode[])
  .map((n) => ({ ...n, id: String(n.id), name: typeof n.name === 'string' ? n.name : undefined })))

/** Builds canvas.view and canvas.show bound to `deps.ui`. */
export function createCanvasViewDefs(deps: CanvasViewDeps): ToolDef[] {
  const view: ToolDef = {
    name: 'canvas.view',
    summary: 'Which project workspace the user is viewing right now, and the nodes on it.',
    tier: 'R0',
    flag: READ_TOOLS_FLAG,
    projectScoped: false,
    usage: '{}. Returns {"viewing":{"projectId","name"}|null,"nodes":[{"id","name","kind","title?"}, ... up to 50],"total":<all nodes>}. '
      + 'viewing is null when the user has no workspace open.',
    input: obj({}),
    output: S.keys('viewing', 'nodes', 'total'),
    auditKeys: ['total'],
    validate: (input) => (onlyKeys(input, []) ? null : 'invalid_shape'),
    handler(ctx): ToolResult {
      syncWorkspaceProjects(ctx.db) // the active workspace may be new since the last header
      const viewing = viewingProject(ctx.db)
      const found = viewing ? projectWorkspace(ctx.db, viewing.projectId) : null
      const all = found?.ok ? named(found.nodes) : []
      const nodes = all.slice(0, MAX_NODES).map((n) => ({
        id: n.id, name: n.name, kind: String(n.kind),
        ...(typeof n.title === 'string' && n.title ? { title: clip(n.title, MAX_TITLE) } : {}),
      }))
      return { ok: true, data: { viewing, nodes, total: all.length } }
    },
  }

  const show: ToolDef = {
    name: 'canvas.show',
    summary: "Switch the user's visible canvas to a project workspace, optionally centring one node or fitting the whole board.",
    tier: 'R1',
    flag: READ_TOOLS_FLAG,
    usage: '{"projectId":"<id>","nodeId":"<optional node id or name from node.list, e.g. Mango>","fit":<optional true: fit every '
      + 'node into view; not with nodeId>}. Every open webterm tab switches to that workspace (and centres the node, or fits the '
      + 'board like View: Fit Canvas). Call it before canvas.screenshot when you want to see another workspace than the one in '
      + 'viewing, or the whole board. It changes what the user sees, so only switch when the user asked or it helps them.',
    input: obj({ nodeId: S.str(MAX_ID), fit: S.bool() }),
    output: S.keys('workspaceId', 'name', 'nodeId', 'fit'),
    auditKeys: ['workspaceId', 'nodeId', 'fit'],
    validate: (input) => (onlyKeys(input, ['projectId', 'nodeId', 'fit']) && (input.nodeId === undefined || isNodeRef(input.nodeId))
      && (input.fit === undefined || typeof input.fit === 'boolean') && !(input.fit === true && input.nodeId !== undefined) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const found = projectWorkspace(ctx.db, projectId)
      if (!found.ok) return fail(found.code)
      let nodeId: string | undefined
      if (typeof input.nodeId === 'string') {
        const ref = input.nodeId
        const nodes = named(found.nodes)
        // An exact id wins over a name, as in canvas.close.
        nodeId = (nodes.find((n) => n.id === ref) ?? nodes.find((n) => n.name.toLowerCase() === ref.toLowerCase()))?.id
        if (!nodeId) return fail('node_not_found', { unknown: [ref] })
      }
      const fit = input.fit === true ? { fit: true } : {}
      const ui = await deps.ui()
      ui.setActive(found.workspaceId)
      ui.broadcast({ t: 'view', workspaceId: found.workspaceId, ...(nodeId ? { nodeId } : {}), ...fit })
      return { ok: true, data: { workspaceId: found.workspaceId, name: found.name, ...(nodeId ? { nodeId } : {}), ...fit } }
    },
  }

  return [view, show]
}
