// Agent slice of `Settings` (launch commands/profiles, custom agents,
// permissions). Merged into `Settings` in `settings.ts`; defaults live in `DEFAULT_SETTINGS` there.

import type { CustomAgent } from './customAgent.schema'
import type { AgentId, AgentPermissionMode, BuiltinAgentId } from './workspace'
import type { ClaudeLaunchProfile } from './claudeLaunch/claudeLaunch.profiles'
import type { ProjectModelOverride } from './settings.projectModels'
import type { ApprovalLevel } from './settings.approvalLevel'
import type { PermissionRouting } from './settings.permissionRouting'

export interface AgentSettings {
  // --- Agent -----------------------------------------------------------------------------------
  /** Legacy Claude launch override (the only builtin; keys of retired builtins are dropped on load).
   *  Superseded by `claudeLaunchProfiles` (a stored `claude` entry is seeded once as the "Custom"
   *  profile); still read for back-compat by paths not yet routed through `server/claudeLauncher`. */
  agentLaunchCommands: Partial<Record<BuiltinAgentId, string>>
  /** User Claude launch profiles (`envman -e p:e -- claude`, ...). The built-in Default (`claude`)
   *  is implicit, never stored, never deletable. Resolve via `server/claudeLauncher`. */
  claudeLaunchProfiles: ClaudeLaunchProfile[]
  /** Profile new Claude agent nodes record at creation (`'default'` = bare `claude`). */
  defaultClaudeProfileId: string
  /** Profile Central's Claude uses; '' = same as `defaultClaudeProfileId`. */
  centralClaudeProfileId: string
  customAgents: CustomAgent[]
  /** Id agent yang disembunyikan dari menu Add. */
  disabledAgents: AgentId[]
  /** Mode permission yang dipakai sesi Claude saat START — dikirim sebagai `--permission-mode`
   *  saat peluncuran; Shift+Tab tetap bisa memutar mode saat runtime. */
  claudePermissionMode: AgentPermissionMode
  /** Persetujuan hook yang deterministik: saat on (default), hook PermissionRequest menahan sampai
   *  `PERM_WAIT_SECS_INTERACTIVE` menunggu Approve/Deny dari canvas sebelum jatuh ke prompt
   *  interaktif biasa (permission/permission.runtime.ts). Off ⇒ tanpa penahanan, langsung ke prompt interaktif. */
  hookReplyApprovals: boolean
  /** Skip approvals: Central's ask-tier actions run without a card and Claude agents launch with
   *  `bypassPermissions`. Hard denies (halt, pause, caps, budget, policy deny) still apply. */
  skipApprovals: boolean
  /** The three keys above as one choice (`settings.approvalLevel.ts`). Derived from them on every read; a
   *  patch carrying it is written as those keys, so it is never the source of truth itself. */
  agentApprovalLevel: ApprovalLevel
  /** Who answers a worker's held permission prompt first: Central (default, escalates to you) or you directly (settings.permissionRouting.ts). */
  permissionRouting: PermissionRouting
  /** Central may start a turn by itself when the supervisor finds something that needs a decision. */
  centralCheckins: boolean
  /** Self-started Central turns per local day: 5, 10, 20 or 50. */
  centralCheckinDailyLimit: number
  /** Per-workspace model/effort override of the model ladder, by workspace id; absent = ladder. */
  projectModels: Record<string, ProjectModelOverride>
  /** Per-workspace approval level, by workspace id; absent = `agentApprovalLevel` (settings.projectApprovalLevels.ts). */
  projectApprovalLevels: Record<string, ApprovalLevel>
}
