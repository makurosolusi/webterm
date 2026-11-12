// A saved approval-level change (global or per project), made transparent and live where it can be:
// one `permission.mode_change` event per changed scope, running Agent Chat sessions switched at once
// (setMode), and a read-only count of terminal sessions that keep their launch mode until restarted.
import type { AppendEventInput } from '../events/eventModel'
import { recordEvent } from '../events/producers'
import { MODE_CHANGE_EVENT, activeAgentChatPool, type AgentChatPool } from '../agentChat/agentChat.pool'
import {
  approvalLevelChanges, approvalLevelFor, approvalModeName, type ApprovalLevelChange, type ApprovalSettings,
} from '../../shared/settings.projectApprovalLevels'
import { launchModeFor, staleLaunchCount } from './permission.mode'
import { createLogger } from '../logs'

const log = createLogger('permission')

export const APPROVAL_SESSIONS_PATH = '/api/settings/approval-sessions'

/** Records one event per changed scope (names only: ask/auto/danger, ids; no settings values). */
export function recordLevelChanges(prev: ApprovalSettings, next: ApprovalSettings, actor: string, record: (e: AppendEventInput) => void = recordEvent): ApprovalLevelChange[] {
  const changes = approvalLevelChanges(prev, next)
  for (const c of changes) {
    record({
      kind: MODE_CHANGE_EVENT, source: 'settings', actor, trust: 'trusted',
      subject: c.workspaceId ? `workspace:${c.workspaceId}` : 'settings:global', workspaceId: c.workspaceId ?? null,
      payload: { scope: c.scope, from: approvalModeName(c.from), to: approvalModeName(c.to) },
    })
  }
  return changes
}

/**
 * Switches running Agent Chat sessions the changes reach to their workspace's new launch mode. The
 * node's own stored mode is not consulted: the user just chose a level for this project.
 */
export async function switchAgentChats(changes: ApprovalLevelChange[], next: ApprovalSettings, pool: AgentChatPool | undefined = activeAgentChatPool()): Promise<number> {
  if (!pool || !changes.length) return 0
  const global = changes.some((c) => c.scope === 'global')
  const ids = new Set(changes.flatMap((c) => (c.workspaceId ? [c.workspaceId] : [])))
  let n = 0
  for (const nodeId of pool.nodeIds()) {
    const t = pool.target(nodeId)
    if (!t || !(ids.has(t.ws.id) || (global && next.projectApprovalLevels?.[t.ws.id] === undefined))) continue
    const mode = launchModeFor(next, t.ws.id)
    if (pool.peek(nodeId)?.currentMode() === mode) continue
    try {
      if (await pool.setMode(nodeId, mode, 'settings')) n++
    } catch (err) {
      // One chat refusing (e.g. its Query cannot enter bypass live) must not undo the saved level or skip the others.
      log.warn('permission.mode_switch_failed', 'Agent chat kept its mode after a level change', { ids: { nodeId, workspaceId: t.ws.id }, cause: err instanceof Error ? err.message : String(err) })
    }
  }
  return n
}

/** GET body: the level that applies in `workspaceId` (absent = global) and running terminal sessions still on an older one. */
export function approvalSessions(s: ApprovalSettings, isLive: (nodeId: string) => boolean, workspaceId?: string): { workspaceId: string | null; mode: string; staleSessions: number } {
  return { workspaceId: workspaceId ?? null, mode: approvalModeName(approvalLevelFor(s, workspaceId)), staleSessions: staleLaunchCount(s, isLive, workspaceId) }
}
