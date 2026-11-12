// A saved approval level (Settings › Claude › Permissions) also sets the auto-approver (classifier) switch,
// which lives in the event log, not the settings row (settings.approvalLevel.ts has the mapping).
import type { Database } from 'bun:sqlite'
import type { AppendEventInput } from '../events/eventModel'
import { activeEventLog } from '../events/eventsRuntime'
import { approvalClassifierSwitch, isApprovalLevel } from '../../shared/settings.approvalLevel'
import { setClassifierSwitch } from './policy.classifier'

/** Called after PUT /api/settings with its patch; no level in it, or the ledger off = nothing to do. */
export function applyApprovalLevelSwitch(
  patch: Record<string, unknown>, ledger: { db: Database } | null, log: { append(e: AppendEventInput): unknown } | null = activeEventLog(),
): void {
  const level = patch.agentApprovalLevel
  const next = isApprovalLevel(level) ? approvalClassifierSwitch(level) : null
  if (!next || !ledger || !log) return
  setClassifierSwitch(ledger.db, (e) => { log.append(e) }, next)
}
