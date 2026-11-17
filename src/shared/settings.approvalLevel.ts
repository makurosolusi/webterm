// "How much may agents do on their own?" (Settings › Claude › Permissions): one choice over the three keys
// the runtime already reads (`skipApprovals`, `claudePermissionMode`, `hookReplyApprovals`). Those keys stay
// the source of truth: a level is written as them (`approvalLevelPatch`) and read back from them
// (`approvalLevelOf`), so nothing that reads the keys changes. The server also flips the auto-approver
// (policy classifier) switch for `risky` / `always` (routes/settings.routes.ts).
import type { AgentPermissionMode } from './workspace'

export const APPROVAL_LEVELS = ['never', 'risky', 'always'] as const
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number]

/**
 * Level while nothing is stored: Bypass ('never'). Owner decision 2026-11-17, replacing 2026-11-12 ('risky'):
 * agents asked for approval too often. A stored choice is kept; boot moves an old default once
 * (server/approvalDefaultMigration.ts). Deny rules, spend limits, caps and secret access still protect.
 */
export const DEFAULT_APPROVAL_LEVEL: ApprovalLevel = 'never'

export const isApprovalLevel = (v: unknown): v is ApprovalLevel => (APPROVAL_LEVELS as readonly unknown[]).includes(v)

export interface ApprovalKeys { skipApprovals: boolean; claudePermissionMode: AgentPermissionMode; hookReplyApprovals: boolean }

/** The stored keys a level writes. `never` only sets the skip (the raw mode underneath is kept for later). */
export function approvalLevelPatch(level: ApprovalLevel): Partial<ApprovalKeys> {
  if (level === 'never') return { skipApprovals: true }
  if (level === 'risky') return { skipApprovals: false, claudePermissionMode: 'auto', hookReplyApprovals: true }
  return { skipApprovals: false, claudePermissionMode: 'manual', hookReplyApprovals: true }
}

/** The level the stored keys amount to. Any raw mode other than `manual` (auto, acceptEdits, plan…) reads as `risky`. */
export function approvalLevelOf(s: Pick<ApprovalKeys, 'skipApprovals' | 'claudePermissionMode'>): ApprovalLevel {
  if (s.skipApprovals) return 'never'
  return s.claudePermissionMode === 'manual' ? 'always' : 'risky'
}

/** Auto-approver (classifier) switch a level sets; null = leave it as it is. */
export function approvalClassifierSwitch(level: ApprovalLevel): { central: boolean; permissions: boolean } | null {
  if (level === 'never') return null
  const on = level === 'risky'
  return { central: on, permissions: on }
}

/** User-facing name and one-sentence hint per level (Settings, per-project switch). */
export const APPROVAL_LEVEL_TEXT: Record<ApprovalLevel, { label: string; hint: string }> = {
  always: { label: 'Ask', hint: 'Every action that needs permission waits for your approval first.' },
  risky: { label: 'Auto', hint: 'Routine work runs on its own; only actions that cannot be undone ask first.' },
  never: { label: 'Bypass', hint: 'Nothing asks (bypass permissions, the default); only your Deny rules, spend limits and secret access still protect you.' },
}
