// One-time boot migration for the 2026-11-17 owner decision: the default permission level is Bypass ('never').
// A stored global level of Ask/Auto is most likely the old default (Auto since 2026-11-12), so it moves to Bypass
// ONCE; per-project overrides are never touched. A marker row in `app` makes later boots (and a later explicit
// choice of Ask/Auto in Settings) final: this never decides twice.
import { approvalLevelOf } from '../shared/settings.approvalLevel'
import type { Settings } from '../shared/settings'

export const APPROVAL_DEFAULT_MARKER = 'approval_default_bypass_v1'

export interface ApprovalMigrationDeps {
  getFlag: (key: string) => string | null
  setFlag: (key: string, value: string) => void
  settings: () => Settings
  save: (patch: { agentApprovalLevel: 'never'; confirmDanger: true }) => unknown
}

/** 'moved' = the global level went to Bypass (announce it); 'marked' = nothing to change; 'skipped' = decided before. */
export function migrateApprovalDefault(d: ApprovalMigrationDeps): 'moved' | 'marked' | 'skipped' {
  if (d.getFlag(APPROVAL_DEFAULT_MARKER) !== null) return 'skipped'
  const moved = approvalLevelOf(d.settings()) !== 'never'
  // Save first: a failed save leaves the marker unset, so the next boot retries.
  if (moved) d.save({ agentApprovalLevel: 'never', confirmDanger: true })
  d.setFlag(APPROVAL_DEFAULT_MARKER, moved ? 'moved' : 'marked')
  return moved ? 'moved' : 'marked'
}
