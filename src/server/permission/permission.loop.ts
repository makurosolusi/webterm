// PreToolUse doom-loop guard for the hook route (F3-b): the 3rd identical consecutive call of a node
// (or of one of its subagents) is denied with a reason Claude reads, and recorded as an event.
import { recordEvent } from '../events/producers'
import { createLogger } from '../logs'
import { createDoomLoopGuard, doomLoopReason, preToolDeny, toolLabel, type PermissionBody } from './permission.model'

export const DOOM_LOOP_EVENT = 'permission.doom_loop'

const log = createLogger('hooks')
/** Process-wide: every node posts its hooks to this process. */
const guard = createDoomLoopGuard()

/** `hookSpecificOutput` fields that block the call, or `{}` to let it through. */
export function doomLoopBlock(nodeId: string, workspaceId: string | null, body: PermissionBody, now = Date.now()): Record<string, unknown> {
  const count = guard.check(nodeId, body, now)
  if (!count) return {}
  const label = toolLabel(body)
  log.warn('hooks.doom_loop', 'Blocked an identical repeated tool call', { ids: { nodeId }, count })
  recordEvent({ kind: DOOM_LOOP_EVENT, source: 'permission', actor: 'webterm', trust: 'trusted', subject: `node:${nodeId}`, nodeId, workspaceId, payload: { label, count, behavior: 'deny' } })
  return preToolDeny(doomLoopReason(label, count))
}
