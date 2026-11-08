// Launch permission mode of a Claude session: Settings > Skip approvals forces `bypassPermissions`,
// otherwise the node's own mode wins over the settings default.
import type { AgentPermissionMode } from '../../shared/workspace'

/** Mode a NEW Claude launch gets; sessions already running keep theirs. */
export function effectiveClaudeMode(settingsMode: AgentPermissionMode, nodeMode: AgentPermissionMode | undefined, skip: boolean): AgentPermissionMode {
  return skip ? 'bypassPermissions' : nodeMode ?? settingsMode
}
