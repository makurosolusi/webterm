// Agent slice of `Settings` (quick-add agent, launch commands/profiles, custom agents,
// permissions). Merged into `Settings` in `settings.ts`; defaults live in `DEFAULT_SETTINGS` there.

import type { CustomAgent } from './customAgent.schema'
import type { AgentId, AgentPermissionMode, BuiltinAgentId } from './workspace'
import type { ClaudeLaunchProfile } from './claudeLaunch/claudeLaunch.profiles'

export interface AgentSettings {
  // --- Agent -----------------------------------------------------------------------------------
  /** Agent yang diluncurkan tombol quick-add. */
  defaultAgent: AgentId
  /** Override perintah peluncuran per agent builtin. Nilainya mengganti nama CLI polos di mana
   *  pun baris peluncuran dibangun — sesi baru, relaunch, restart in-place — dengan flag yang biasa
   *  (`--resume`, prompt) ditempelkan setelahnya, sehingga skrip wrapper yang memilih akun ikut
   *  berjalan. Kosong/absen = default builtin. Hanya builtin: agent custom sudah punya
   *  `launchCmd`-nya sendiri.
   *  CLAUDE: superseded by `claudeLaunchProfiles` (a stored `claude` entry is seeded once as the
   *  "Custom" profile). Still read for back-compat by paths not yet routed through
   *  `server/claudeLauncher` and by the other builtins. */
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
}
