// Agent slice of `Settings` (quick-add agent, launch commands/profiles, custom agents,
// permissions). Merged into `Settings` in `settings.ts`; defaults live in `DEFAULT_SETTINGS` there.

import type { CustomAgent } from './customAgent.schema'
import type { AgentId, AgentPermissionMode, BuiltinAgentId } from './workspace'
import type { ClaudeLaunchProfile } from './claudeLaunch/claudeLaunch.profiles'
import type { ProjectModelOverride } from './settings.projectModels'

export interface AgentSettings {
  // --- Agent -----------------------------------------------------------------------------------
  /** Agent yang diluncurkan tombol quick-add. */
  defaultAgent: AgentId
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
  /** Per-workspace model/effort override of the model ladder, by workspace id; absent = ladder. */
  projectModels: Record<string, ProjectModelOverride>
}
