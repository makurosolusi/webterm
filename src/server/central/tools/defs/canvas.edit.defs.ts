// canvas.edit (R1): Central tidies a project's board like a human would: move, resize, arrange,
// retitle/recolor/collapse nodes and draw/cut cables. Ops apply in order over a copy of the board, then
// ONE CanvasPush.update writes it all (or nothing) and open windows apply it live. Named `canvas.*`, not
// `node.*`: the control API's node.read/prompt/close/spawn act on one session, this edits a board's layout.
import { CANVAS_PATCH_KEYS } from '../../../../shared/protocol'
import type { BridgeLink } from '../../../../shared/workspace'
import type { CanvasNode, CanvasPush, NodePatch } from '../../../canvas/canvasPush'
import { lookupWorkspace, projectWorkspace } from '../../workspaceLookup'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { obj, S } from '../../../capability/capability.schema'
import { READ_TOOLS_FLAG } from './read.shared'
import { applyOps, nodeRefResolver, MAX_COORD, MAX_OPS, MAX_SIDE, MAX_TITLE, NODE_COLORS, opShape, refsOf, type Board, type Op } from './canvas.edit.ops'

/** The one CanvasPush write this tool uses (tests pass a fake). */
export type EditCanvas = Pick<CanvasPush, 'update'>
export interface CanvasEditDeps {
  /** Resolved per call so the runtime (db + broadcaster) is only loaded when the tool runs. */
  canvas(): EditCanvas | Promise<EditCanvas>
}

const fail = (code: string, data?: Record<string, unknown>): ToolResult => ({ ok: false, code, ...(data ? { data } : {}) })

function editShape(input: ToolInput): boolean {
  const { ops } = input
  return Object.keys(input).every((k) => k === 'projectId' || k === 'ops')
    && Array.isArray(ops) && ops.length >= 1 && ops.length <= MAX_OPS && ops.every(opShape)
}

const isBridge = (b: unknown): b is BridgeLink => !!b && typeof b === 'object'
  && typeof (b as BridgeLink).id === 'string' && typeof (b as BridgeLink).source === 'string' && typeof (b as BridgeLink).target === 'string'

const USAGE = '{"projectId":"<id>","ops":[<1-50 ops, applied in order; later ops see earlier ones>]}. Node refs are ids or names from node.list '
  + '(e.g. Mango, any case). Ops: '
  + `{"op":"move","node":"<ref>","x":<n>,"y":<n>} (canvas coords, |n|<=${MAX_COORD}); `
  + '{"op":"move","node":"<ref>","beside":"<ref>","side":"right"|"left"|"below"|"above" (default right)}; '
  + `{"op":"resize","node":"<ref>","width":<n>,"height":<n>} (either or both; clamped to the node's minimum and ${MAX_SIDE}, reported in clamped); `
  + '{"op":"arrange","nodes":["<ref>",...]|"all","layout":"grid"|"row"|"column"} (from the top-left of those nodes); '
  + `{"op":"set","node":"<ref>","title":"<=${MAX_TITLE} chars"|null,"color":${NODE_COLORS.map((c) => `"${c}"`).join('|')}|null,"collapsed":<bool>,"hideLinks":<bool>} `
  + '(null clears; collapsed: terminal/Claude/files/browser/chat nodes; hideLinks: Claude agent nodes); '
  + '{"op":"link","from":"<ref>","to":"<ref>"} (a cable as the user draws it; an existing one is kept; a skill node + a Claude or Agent Chat node ATTACHES that skill to the agent, max 8, in either order); '
  + '{"op":"unlink","from":"<ref>","to":"<ref>"} or {"op":"unlink","cable":"<cable id>"} (unlinking a skill cable DETACHES the skill at once). '
  + 'All-or-nothing: one unknown ref or refused op changes nothing.'

/** Builds canvas.edit bound to `deps.canvas`. */
export function createCanvasEditDefs(deps: CanvasEditDeps): ToolDef[] {
  const edit: ToolDef = {
    name: 'canvas.edit',
    summary: 'Move, resize, arrange, retitle, recolor or collapse nodes and connect/disconnect cables on a project canvas.',
    tier: 'R1',
    flag: READ_TOOLS_FLAG,
    usage: USAGE,
    input: obj({ ops: S.arr(S.anyObj('one op, see usage'), MAX_OPS) }, ['ops']),
    output: S.keys('changed', 'linked', 'wired', 'unlinked', 'clamped', 'count', 'ids'),
    auditKeys: ['count', 'ids'],
    validate: (input) => (editShape(input) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const found = projectWorkspace(ctx.db, projectId)
      if (!found.ok) return fail(found.code)
      const stored = (found.nodes as CanvasNode[]).filter((n) => n && typeof n.id === 'string')
      const rawBridges = (lookupWorkspace(found.workspaceId) as { bridges?: unknown } | null)?.bridges
      const bridges = Array.isArray(rawBridges) ? rawBridges.filter(isBridge) : []
      const { nameOf, resolve } = nodeRefResolver(stored)
      const ops = input.ops as Op[]
      const unknown = [...new Set(ops.flatMap(refsOf).filter((r) => resolve(r) === undefined))]
      if (unknown.length) return fail('node_not_found', { unknown })

      const board: Board = { nodes: new Map(stored.map((n) => [n.id, { ...n }])), order: stored.map((n) => n.id), bridges: [...bridges], nameOf }
      const applied = applyOps(board, ops, (r) => resolve(r)!)
      if (!applied.ok) return fail(applied.code, applied.data)

      const patches: NodePatch[] = []
      const changed: Array<{ id: string; name: string | null; fields: string[] }> = []
      for (const before of stored) {
        const after = board.nodes.get(before.id)!
        const fields = CANVAS_PATCH_KEYS.filter((k) => before[k] !== after[k])
        if (!fields.length) continue
        patches.push({ id: before.id, ...Object.fromEntries(fields.map((k) => [k, after[k] ?? null])) } as NodePatch)
        changed.push({ id: before.id, name: nameOf.get(before.id) ?? null, fields })
      }
      const was = new Set(bridges.map((b) => b.id))
      const now = new Set(board.bridges.map((b) => b.id))
      const added = board.bridges.filter((b) => !was.has(b.id))
      const removed = bridges.filter((b) => !now.has(b.id))
      const cable = (b: BridgeLink) => ({ cable: b.id, from: nameOf.get(b.source) ?? b.source, to: nameOf.get(b.target) ?? b.target })

      const res = (await deps.canvas()).update({ workspaceId: found.workspaceId, patches, bridgesAdd: added, bridgesRemove: removed.map((b) => b.id) })
      if (!res.ok) return fail(res.code)
      const data = { changed, linked: added.map(cable), wired: added.map((b) => [b.source, b.target]), unlinked: removed.map(cable), count: changed.length + added.length + removed.length, ids: changed.map((c) => c.id) }
      return { ok: true, data: applied.clamped.length ? { ...data, clamped: applied.clamped } : data }
    },
  }
  return [edit]
}
