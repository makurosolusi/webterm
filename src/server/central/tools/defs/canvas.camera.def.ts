// canvas.camera (R1): Central moves the camera of the canvas the human is looking at: fit, focus a node, zoom, pan.
// It rides the same `t:'view'` frame as canvas.show (no second camera mechanism) marked `polite`, and it yields to a
// human: while the user moved the canvas in the last USER_ACTIVE_PAUSE_MS (Follow's own pause) nothing is sent and the
// result says {applied:false, reason:'user_active'}. The user's activity comes from the presence ping (`idleMs`).
import { CAMERA_MAX_ZOOM, CAMERA_MIN_ZOOM, CAMERA_PAN_MAX_PX, clampTo, USER_ACTIVE_PAUSE_MS } from '../../../../shared/canvasCamera'
import { isNodeName } from '../../../../shared/nodeNames'
import { viewingProject } from '../../context/contextHeader'
import { projectWorkspace } from '../../workspaceLookup'
import { obj, S } from '../../../capability/capability.schema'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { nodeRefResolver } from './canvas.edit.ops'
import type { CanvasViewDeps } from './canvas.view.defs'
import { isSafeId, MAX_ID, READ_TOOLS_FLAG } from './read.shared'

export interface CanvasCameraDeps extends CanvasViewDeps {
  /** Ms since the human last moved the canvas (Infinity = never), null = no visible webterm tab (presence). */
  idleMs(): number | null | Promise<number | null>
}

const ACTIONS = ['fit', 'focus', 'zoom', 'pan'] as const
type Action = (typeof ACTIONS)[number]
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const onlyKeys = (input: ToolInput, allowed: readonly string[]): boolean => Object.keys(input).every((k) => allowed.includes(k))
/** A node id, or a node name as `withNodeNames` mints it ("Mango", tier "Mango 2") in any case. */
const isNodeRef = (v: unknown): boolean => isSafeId(v) || isNodeName(v, true)

/** Why Central must not move the view now, or null when it may (shared with workspace.switch). */
export async function viewRefusal(deps: Pick<CanvasCameraDeps, 'idleMs'>): Promise<'no_visible_window' | 'user_active' | null> {
  const idle = await deps.idleMs()
  if (idle === null) return 'no_visible_window'
  return idle < USER_ACTIVE_PAUSE_MS ? 'user_active' : null
}

function shape(input: ToolInput): boolean {
  const { action, node, zoom, dx, dy } = input
  if (!onlyKeys(input, ['projectId', 'action', 'node', 'zoom', 'dx', 'dy']) || !ACTIONS.includes(action as Action)) return false
  const only = (...keys: string[]): boolean => ['node', 'zoom', 'dx', 'dy'].every((k) => keys.includes(k) || input[k] === undefined)
  if (action === 'fit') return only()
  if (action === 'focus') return isNodeRef(node) && only('node')
  if (action === 'zoom') return num(zoom) && only('zoom')
  return (num(dx) || num(dy)) && (dx === undefined || num(dx)) && (dy === undefined || num(dy)) && only('dx', 'dy')
}

/** Builds canvas.camera over the same UI port as canvas.show. */
export function createCanvasCameraDefs(deps: CanvasCameraDeps): ToolDef[] {
  const camera: ToolDef = {
    name: 'canvas.camera',
    summary: 'Move the camera on the canvas the user views: fit, focus a node, zoom, pan. Yields while they move it.',
    tier: 'R1',
    flag: READ_TOOLS_FLAG,
    usage: '{"projectId":"<id>","action":"fit"|"focus"|"zoom"|"pan","node":"<node id or name; focus only>","zoom":<absolute zoom '
      + `${CAMERA_MIN_ZOOM}-${CAMERA_MAX_ZOOM}, 1 = 100%; zoom only>,"dx":<screen px right; pan only>,"dy":<screen px down; pan only>}. `
      + 'Only for the workspace the user is viewing (canvas.view; otherwise {"applied":false,"reason":"not_viewing"}: use canvas.show to switch). '
      + `Out-of-range zoom/pan is clamped (pan to +-${CAMERA_PAN_MAX_PX}px, "clamped":true). `
      + `If the user moved the canvas in the last ${USER_ACTIVE_PAUSE_MS / 1000} s the result is {"applied":false,"reason":"user_active"}: do not retry in a loop, `
      + 'carry on with the work (Follow shows your nodes by itself) and try again later only if it matters. Tabs layout: zoom, pan and fit do nothing there.',
    input: obj({ action: S.oneOf(...ACTIONS), node: S.str(MAX_ID), zoom: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' } }, ['action']),
    output: S.keys('applied', 'reason', 'action', 'workspaceId', 'nodeId', 'zoom', 'dx', 'dy', 'clamped'),
    auditKeys: ['applied', 'reason', 'action', 'nodeId', 'zoom', 'dx', 'dy', 'clamped'],
    validate: (input) => (shape(input) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const found = projectWorkspace(ctx.db, projectId)
      if (!found.ok) return { ok: false, code: found.code }
      const action = input.action as Action
      let nodeId: string | undefined
      if (action === 'focus') {
        nodeId = nodeRefResolver(found.nodes as Parameters<typeof nodeRefResolver>[0]).resolve(String(input.node))
        if (!nodeId) return { ok: false, code: 'node_not_found', data: { unknown: [String(input.node)] } }
      }
      const done = (applied: boolean, extra: Record<string, unknown>): ToolResult => ({ ok: true, data: { applied, action, ...extra } })
      if (viewingProject(ctx.db)?.projectId !== projectId) return done(false, { reason: 'not_viewing' })
      const reason = await viewRefusal(deps)
      if (reason) return done(false, { reason })
      const pad = CAMERA_PAN_MAX_PX
      const zoom = action === 'zoom' ? clampTo(input.zoom as number, CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM) : undefined
      const pan = action === 'pan' ? { dx: clampTo((input.dx as number | undefined) ?? 0, -pad, pad), dy: clampTo((input.dy as number | undefined) ?? 0, -pad, pad) } : undefined
      const clamped = (zoom !== undefined && zoom !== input.zoom) || (pan !== undefined && (pan.dx !== (input.dx ?? 0) || pan.dy !== (input.dy ?? 0)))
      const ui = await deps.ui()
      ui.broadcast({
        t: 'view', workspaceId: found.workspaceId, polite: true,
        ...(nodeId ? { nodeId } : {}), ...(action === 'fit' ? { fit: true } : {}), ...(zoom !== undefined ? { zoom } : {}), ...(pan ? { pan } : {}),
      })
      return done(true, { workspaceId: found.workspaceId, ...(nodeId ? { nodeId } : {}), ...(zoom !== undefined ? { zoom } : {}), ...(pan ?? {}), ...(clamped ? { clamped: true } : {}) })
    },
  }
  return [camera]
}
