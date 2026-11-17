// workspace.color (R1): read or change a workspace's identity color (hue + shade), the same palette the human's picker
// uses. UI-only and reversible, but the user recognises a workspace by its color, so Central changes it only when asked
// (or when it creates a workspace) and, like workspace.switch, yields while the user is moving the canvas
// ({applied:false, reason:'user_active'}). Every change is announced: the open windows show a notice with Undo
// (`t:'workspaceColor'` with `by:'central'`) and a bounded `central.act` record is written (ids and palette names only).
import type { ServerMsg } from '../../../../shared/protocol'
import { WORKSPACE_HUES, WORKSPACE_SHADES, describeWorkspaceColor, isWorkspaceHue, isWorkspaceShade } from '../../../../shared/workspaceColor'
import { USER_ACTIVE_PAUSE_MS } from '../../../../shared/canvasCamera'
import type { Db } from '../../../db'
import type { AppendEventInput } from '../../../events/eventModel'
import { recordEvent } from '../../../events/producers'
import { setWorkspaceColor } from '../../../workspaceColor'
import { obj, S } from '../../../capability/capability.schema'
import { projectWorkspace } from '../../workspaceLookup'
import { ACT_EVENT_KIND } from '../toolAct'
import type { ToolDef, ToolResult } from '../toolTypes'
import { READ_TOOLS_FLAG } from './read.shared'

export interface WorkspaceColorDeps {
  runtime(): { db: Pick<Db, 'get' | 'list' | 'setColor' | 'usedHues'>; broadcast(msg: ServerMsg): void } | Promise<{ db: Pick<Db, 'get' | 'list' | 'setColor' | 'usedHues'>; broadcast(msg: ServerMsg): void }>
  /** Ms since the human last moved the canvas (Infinity = never), null = no visible webterm tab (presence). */
  idleMs(): number | null | Promise<number | null>
  /** Where the bounded record goes (tests pass a fake). */
  record?: (event: AppendEventInput) => void
}

/** Builds workspace.color. */
export function createWorkspaceColorDefs(deps: WorkspaceColorDeps): ToolDef[] {
  const color: ToolDef = {
    name: 'workspace.color',
    summary: "Read or change a workspace's identity color (the tab/status-bar marker the user recognises it by).",
    tier: 'R1',
    flag: READ_TOOLS_FLAG,
    usage: `{"projectId":"<id>","color":"${WORKSPACE_HUES.join('|')}","shade":"${WORKSPACE_SHADES.join('|')}"} (both optional). `
      + 'With neither it only reads: {"workspaceId","name","color","shade","others":[{"name","color","shade"}]}. '
      + 'Change it ONLY when the user asks (every workspace already got a color when it was created, and the user tells workspaces apart by it), '
      + 'or when you create a workspace and the user named a color. The user sees a notice with Undo. '
      + `If the user moved the canvas in the last ${USER_ACTIVE_PAUSE_MS / 1000} s the result is {"applied":false,"reason":"user_active"}: do not retry in a loop.`,
    input: obj({ color: S.oneOf(...WORKSPACE_HUES), shade: S.oneOf(...WORKSPACE_SHADES) }),
    output: S.keys('applied', 'reason', 'workspaceId', 'name', 'color', 'shade', 'previous', 'others'),
    auditKeys: ['applied', 'reason', 'workspaceId', 'color', 'shade'],
    validate: (input) => {
      if (!Object.keys(input).every((k) => k === 'projectId' || k === 'color' || k === 'shade')) return 'invalid_shape'
      if (input.color !== undefined && !isWorkspaceHue(input.color)) return 'invalid_shape'
      return input.shade === undefined || isWorkspaceShade(input.shade) ? null : 'invalid_shape'
    },
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const found = projectWorkspace(ctx.db, projectId)
      if (!found.ok) return { ok: false, code: found.code }
      const { db, broadcast } = await deps.runtime()
      const ws = db.get(found.workspaceId)
      if (!ws) return { ok: false, code: 'workspace_not_found' }
      const base = { workspaceId: ws.id, name: ws.name }
      if (input.color === undefined && input.shade === undefined) {
        const others = db.list().filter((w) => w.id !== ws.id).slice(0, 20).map((w) => ({ name: w.name, color: w.color, shade: w.colorShade }))
        return { ok: true, data: { ...base, color: ws.color, shade: ws.colorShade, others } }
      }
      // No visible window = nobody to surprise (the record below still tells the story); only a moving user blocks it.
      const idle = await deps.idleMs()
      if (idle !== null && idle < USER_ACTIVE_PAUSE_MS) return { ok: true, data: { applied: false, reason: 'user_active' } }
      const r = setWorkspaceColor(db, ws.id, { color: input.color, colorShade: input.shade }, broadcast, Math.random, 'central')
      if (!r.ok) return { ok: false, code: r.bad === 'not_found' ? 'workspace_not_found' : 'invalid_shape' }
      try {
        (deps.record ?? recordEvent)({
          kind: ACT_EVENT_KIND, source: 'central', actor: 'central', subject: `workspace:${ws.id}`, workspaceId: ws.id, trust: 'trusted',
          payload: { v: 1, tool: 'workspace.color', verb: 'recolored', color: r.change.color, shade: r.change.shade },
        })
      } catch (err) {
        // The change is stored and shown; a dead ledger must not turn it into a failure. Logged with its cause.
        console.warn(`[central] workspace.color record for workspace ${ws.id} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return { ok: true, data: { applied: true, ...base, color: r.change.color, shade: r.change.shade, previous: describeWorkspaceColor(r.change.previous.color, r.change.previous.shade) } }
    },
  }
  return [color]
}
