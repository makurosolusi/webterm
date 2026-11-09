// canvas.group (R1): Central's Layers groups, the folders the user makes in the Layers side bar
// ("put the browsers in a group called Docs"). One op per call, through the shared CanvasPush, so it
// follows the human's rules (`canvas/canvasPush.layout.ts`) and open windows show it live.
import { MAX_TAB_GROUP_NAME } from '../../../../shared/tabLayout.schema'
import { isNodeName, withNodeNames } from '../../../../shared/nodeNames'
import type { CanvasPush } from '../../../canvas/canvasPush'
import type { GroupOp } from '../../../canvas/canvasPush.layout'
import { projectWorkspace } from '../../workspaceLookup'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { obj, S } from '../../../capability/capability.schema'
import { isSafeId, MAX_ID, READ_TOOLS_FLAG } from './read.shared'

/** The CanvasPush write this tool uses (tests pass a fake). */
export type GroupCanvas = Pick<CanvasPush, 'groups'>
export interface CanvasGroupDeps {
  /** Resolved per call so the runtime (db + broadcaster) is only loaded when a tool runs. */
  canvas(): GroupCanvas | Promise<GroupCanvas>
}

const OPS = ['create', 'add', 'remove', 'rename', 'ungroup', 'collapse'] as const
type Op = (typeof OPS)[number]
const MAX_NODES = 50
/** Keys each op takes besides projectId/op; `name` on create is optional. */
const OP_KEYS: Record<Op, readonly string[]> = {
  create: ['nodes', 'name'], add: ['group', 'nodes'], remove: ['group', 'nodes'],
  rename: ['group', 'name'], ungroup: ['group'], collapse: ['group', 'collapsed'],
}

const onlyKeys = (input: ToolInput, allowed: readonly string[]): boolean => Object.keys(input).every((k) => allowed.includes(k))
const noControl = (s: string): boolean => !/[\x00-\x08\x0b-\x1f\x7f]/.test(s)
const text = (v: unknown, max: number): boolean => typeof v === 'string' && v.trim().length > 0 && v.length <= max && noControl(v)
const fail = (code: string, data?: Record<string, unknown>): ToolResult => ({ ok: false, code, ...(data ? { data } : {}) })
/** A node id, or a node name as `withNodeNames` mints it ("Mango", tier "Mango 2") in any case. */
const isNodeRef = (v: unknown): boolean => isSafeId(v) || isNodeName(v, true)

function groupShape(input: ToolInput): boolean {
  const op = input.op as Op
  if (!OPS.includes(op) || !onlyKeys(input, ['projectId', 'op', ...OP_KEYS[op]])) return false
  const { nodes, group, name, collapsed } = input
  if (OP_KEYS[op].includes('nodes') && !(Array.isArray(nodes) && nodes.length >= 1 && nodes.length <= MAX_NODES && nodes.every(isNodeRef))) return false
  if (OP_KEYS[op].includes('group') && !text(group, MAX_ID)) return false
  if (op === 'rename' && !text(name, MAX_TAB_GROUP_NAME)) return false
  if (op === 'create' && name !== undefined && !text(name, MAX_TAB_GROUP_NAME)) return false
  return op !== 'collapse' || typeof collapsed === 'boolean'
}

/** Builds canvas.group bound to `deps.canvas`. */
export function createCanvasGroupDefs(deps: CanvasGroupDeps): ToolDef[] {
  const group: ToolDef = {
    name: 'canvas.group',
    summary: 'Group canvas nodes into named Layers folders (create, add, remove, rename, ungroup, collapse).',
    tier: 'R1',
    flag: READ_TOOLS_FLAG,
    usage: '{"projectId":"<id>","op":"create"|"add"|"remove"|"rename"|"ungroup"|"collapse", ...}. '
      + 'create {"nodes":[...],"name":"<optional, default Group N>"}; add/remove {"group","nodes":[...]}; rename {"group","name"}; '
      + 'ungroup {"group"}; collapse {"group","collapsed":true|false}. nodes = 1-50 node ids or names from node.list (e.g. Mango); '
      + 'group = a group id or name (any case). A node is in at most one group: create/add move it out of its old group. '
      + 'ungroup keeps the nodes. Refused whole when a node or group is unknown. Returns every group of the board.',
    input: obj({
      op: S.oneOf(...OPS), nodes: S.arr(S.str(MAX_ID), MAX_NODES), group: S.str(MAX_ID), name: S.str(MAX_TAB_GROUP_NAME), collapsed: S.bool(),
    }, ['op']),
    output: S.keys('groups', 'groupId'),
    auditKeys: ['groupId'],
    validate: (input) => (groupShape(input) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const found = projectWorkspace(ctx.db, projectId)
      if (!found.ok) return fail(found.code)
      let nodeIds: string[] = []
      if (Array.isArray(input.nodes)) {
        const named = withNodeNames((found.nodes as Array<{ id?: unknown; name?: unknown }>)
          .map((n) => ({ id: String(n.id), name: typeof n.name === 'string' ? n.name : undefined })))
        const ids = new Set(named.map((n) => n.id))
        const idOfName = new Map(named.map((n) => [n.name.toLowerCase(), n.id]))
        // An exact id wins over a name; whatever matches neither refuses the whole call.
        const refs = input.nodes as string[]
        const resolved = refs.map((r) => (ids.has(r) ? r : idOfName.get(r.toLowerCase())))
        const unknown = refs.filter((_, i) => resolved[i] === undefined)
        if (unknown.length) return fail('node_not_found', { unknown })
        nodeIds = [...new Set(resolved as string[])]
      }
      const g = input.group as string
      const op: GroupOp = input.op === 'create' ? { op: 'create', nodeIds, ...(typeof input.name === 'string' ? { name: input.name } : {}) }
        : input.op === 'add' || input.op === 'remove' ? { op: input.op, group: g, nodeIds }
          : input.op === 'rename' ? { op: 'rename', group: g, name: input.name as string }
            : input.op === 'collapse' ? { op: 'collapse', group: g, collapsed: input.collapsed as boolean }
              : { op: 'ungroup', group: g }
      const res = (await deps.canvas()).groups({ workspaceId: found.workspaceId, op })
      if (!res.ok) return fail(res.code, res.code === 'group_not_found' || res.code === 'group_ambiguous' ? { group: g } : undefined)
      const groups = res.groups.map((x) => ({ id: x.id, name: x.name, collapsed: x.collapsed, nodes: x.ids }))
      return { ok: true, data: { groups, ...(res.groupId ? { groupId: res.groupId } : {}) } }
    },
  }
  return [group]
}
