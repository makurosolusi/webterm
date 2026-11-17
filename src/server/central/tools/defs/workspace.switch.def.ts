// workspace.switch (R1): change which project workspace (tab) the human sees. UI-only and reversible, but it can
// surprise, so it uses the same rule as canvas.camera: nothing is sent while the user is moving the canvas
// ({applied:false, reason:'user_active'}). canvas.show remains the explicit "show it now" (user asked) switch.
import { projectWorkspace } from '../../workspaceLookup'
import { viewingProject } from '../../context/contextHeader'
import { obj, S } from '../../../capability/capability.schema'
import type { ToolDef, ToolResult } from '../toolTypes'
import { viewRefusal, type CanvasCameraDeps } from './canvas.camera.def'
import { READ_TOOLS_FLAG } from './read.shared'

/** Builds workspace.switch over the same UI port as canvas.show (it persists the active workspace the same way). */
export function createWorkspaceSwitchDefs(deps: CanvasCameraDeps): ToolDef[] {
  const sw: ToolDef = {
    name: 'workspace.switch',
    summary: "Switch the workspace (tab) the user sees to this project's; yields while they move the canvas.",
    tier: 'R1',
    flag: READ_TOOLS_FLAG,
    usage: '{"projectId":"<id>"}. Every open webterm tab shows that workspace. Returns {"applied":true,"workspaceId","name"}, '
      + '{"applied":true,"already":true} when it is on screen, or {"applied":false,"reason":"user_active"|"no_visible_window"}: '
      + 'the user is moving the canvas, so do not retry in a loop. Use it only when it helps the user; canvas.show does the same at once when the user asked to see it.',
    input: obj({}),
    output: S.keys('applied', 'reason', 'already', 'workspaceId', 'name'),
    auditKeys: ['applied', 'reason', 'already', 'workspaceId'],
    validate: (input) => (Object.keys(input).every((k) => k === 'projectId') ? null : 'invalid_shape'),
    async handler(ctx, _input, projectId): Promise<ToolResult> {
      const found = projectWorkspace(ctx.db, projectId)
      if (!found.ok) return { ok: false, code: found.code }
      if (viewingProject(ctx.db)?.projectId === projectId) return { ok: true, data: { applied: true, already: true, workspaceId: found.workspaceId, name: found.name } }
      const reason = await viewRefusal(deps)
      if (reason) return { ok: true, data: { applied: false, reason } }
      const ui = await deps.ui()
      ui.setActive(found.workspaceId)
      ui.broadcast({ t: 'view', workspaceId: found.workspaceId, polite: true })
      return { ok: true, data: { applied: true, workspaceId: found.workspaceId, name: found.name } }
    },
  }
  return [sw]
}
