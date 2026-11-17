// canvas.reopen (R1): bring back a node CENTRAL closed with canvas.close (its snapshot and cables), nothing else.
// A node the human closed is never reopened by Central: the source is Central's own record (central_closed), and a
// node the human closed AFTER Central's close (closed_history newer than the record) is refused as closed_by_user.
import { isNodeName } from '../../../../shared/nodeNames'
import type { CanvasBridge, CanvasNode } from '../../../canvas/canvasPush'
import type { HistoryDb } from '../../../sessionHistory.store'
import { obj, S } from '../../../capability/capability.schema'
import { forgetCentralClosed, humanClosedAt, listCentralClosed, type CentralClosed } from '../../centralClosed.store'
import { projectWorkspace } from '../../workspaceLookup'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import type { NodeCanvas } from './canvas.act.defs'
import { clip, isSafeId, MAX_ID, READ_TOOLS_FLAG } from './read.shared'

export interface CanvasReopenDeps {
  canvas(): NodeCanvas | Promise<NodeCanvas>
  /** webterm.db handle holding central_closed and closed_history. */
  history(): HistoryDb | Promise<HistoryDb>
}

/** A human close newer than Central's by more than this is the human's (covers a slow tab recording Central's own close). */
export const HUMAN_CLOSE_SLACK_MS = 60_000
const MAX_LIST = 20
const MAX_TITLE = 80

const label = (e: CentralClosed): { id: string; name: string | null; kind: string; title: string | null } => ({
  id: e.node.id, name: e.node.name ?? null, kind: String(e.node.kind), title: e.node.title ? clip(e.node.title, MAX_TITLE) : null,
})

/** Builds canvas.reopen over Central's close record. */
export function createCanvasReopenDefs(deps: CanvasReopenDeps): ToolDef[] {
  const reopen: ToolDef = {
    name: 'canvas.reopen',
    summary: 'Reopen a node you closed with canvas.close (never one the user closed).',
    tier: 'R1',
    flag: READ_TOOLS_FLAG,
    usage: '{"projectId":"<id>","node":"<id or name of a node you closed; omit to list what you can reopen>"}. Brings the node back with its '
      + 'cables where both ends are on the board. A node the user closed is refused (closed_by_user); one that is back already is already_open. '
      + 'Without "node" it only lists {"reopenable":[{"id","name","kind","title"}]}.',
    input: obj({ node: S.str(MAX_ID) }),
    output: S.keys('reopened', 'count', 'ids', 'reopenable'),
    auditKeys: ['count', 'ids'],
    validate: (input: ToolInput) => (Object.keys(input).every((k) => k === 'projectId' || k === 'node')
      && (input.node === undefined || isSafeId(input.node) || isNodeName(input.node, true)) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const found = projectWorkspace(ctx.db, projectId)
      if (!found.ok) return { ok: false, code: found.code }
      const db = await deps.history()
      const mine = listCentralClosed(db, found.workspaceId)
      if (input.node === undefined) return { ok: true, data: { reopenable: mine.slice(0, MAX_LIST).map(label), count: 0, ids: [] } }
      const ref = String(input.node).toLowerCase()
      const hit = mine.find((e) => e.node.id === input.node) ?? mine.find((e) => (e.node.name ?? '').toLowerCase() === ref)
      if (!hit) return { ok: false, code: 'not_closed_by_central', data: { hint: 'Only nodes you closed with canvas.close can be reopened; the user reopens their own.', reopenable: mine.slice(0, MAX_LIST).map(label) } }
      const board = found.nodes as CanvasNode[]
      if (board.some((n) => n.id === hit.node.id)) { forgetCentralClosed(db, hit.node.id); return { ok: false, code: 'already_open', data: { id: hit.node.id } } }
      const human = humanClosedAt(db, hit.node.id)
      if (human !== null && human - hit.closedAt > HUMAN_CLOSE_SLACK_MS) { forgetCentralClosed(db, hit.node.id); return { ok: false, code: 'closed_by_user', data: { id: hit.node.id } } }
      // Cables come back only when the other end is on the board (as the client's own Reopen does).
      const live = new Set(board.map((n) => n.id))
      const bridges: CanvasBridge[] = hit.bridges.filter((b) => (b.source === hit.node.id ? live.has(b.target) : live.has(b.source)))
      const res = (await deps.canvas()).add({ workspaceId: found.workspaceId, nodes: [hit.node as CanvasNode], ...(bridges.length ? { bridges } : {}) })
      if (!res.ok) return { ok: false, code: res.code }
      forgetCentralClosed(db, hit.node.id)
      return { ok: true, data: { reopened: [label(hit)], count: 1, ids: [hit.node.id] } }
    },
  }
  return [reopen]
}
