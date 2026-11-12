// Launch permission mode of a Claude session: the approval level of its workspace (global, or the
// project's `projectApprovalLevels` override) decides; Danger forces `bypassPermissions`, otherwise the
// node's own mode wins over the level's mode. Also remembers the level each terminal session launched
// with, so the UI can say how many running sessions still use an old level.
import type { AgentPermissionMode } from '../../shared/workspace'
import type { ApprovalLevel } from '../../shared/settings.approvalLevel'
import { approvalLevelFor, approvalModeName, claudeModeFor, skipApprovalsFor, type ApprovalModeName, type ApprovalSettings } from '../../shared/settings.projectApprovalLevels'

/** Mode a NEW Claude launch gets; sessions already running keep theirs. */
export function effectiveClaudeMode(settingsMode: AgentPermissionMode, nodeMode: AgentPermissionMode | undefined, skip: boolean): AgentPermissionMode {
  return skip ? 'bypassPermissions' : nodeMode ?? settingsMode
}

/** Launch mode of a node in `workspaceId` under `s`. */
export function launchModeFor(s: ApprovalSettings, workspaceId: string | null | undefined, nodeMode?: AgentPermissionMode): AgentPermissionMode {
  return effectiveClaudeMode(claudeModeFor(s, workspaceId), nodeMode, skipApprovalsFor(s, workspaceId))
}

/** nodeId -> level its running terminal session launched with (process memory; a restart forgets). */
const launched = new Map<string, { workspaceId: string | null; level: ApprovalLevel }>()

export function recordLaunchLevel(nodeId: string, workspaceId: string | null, level: ApprovalLevel): void {
  launched.set(nodeId, { workspaceId, level })
}

/** Ask/Auto/Danger a node runs under: its launch level when known, else the current level of its workspace. */
export function sessionModeName(s: ApprovalSettings, nodeId: string, workspaceId: string | null | undefined): ApprovalModeName {
  return approvalModeName(launched.get(nodeId)?.level ?? approvalLevelFor(s, workspaceId))
}

/**
 * Live terminal sessions in `workspaceId` (global: every workspace without an override) that launched
 * under another level than the one that applies now; they keep it until restarted.
 * ponytail: sessions adopted from tmux after a server restart have no recorded level and are not counted.
 */
export function staleLaunchCount(s: ApprovalSettings, isLive: (nodeId: string) => boolean, workspaceId?: string | null): number {
  let n = 0
  for (const [id, l] of launched) {
    if (!isLive(id)) { launched.delete(id); continue }
    if (workspaceId !== undefined && l.workspaceId !== workspaceId) continue
    if (l.level !== approvalLevelFor(s, l.workspaceId)) n++
  }
  return n
}
