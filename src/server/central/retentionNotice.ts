// `auto.retention_sweep`: the hourly retention sweep removes old rows on its own, so it says so. One notice per day
// at most (noticeKey per UTC day); a later sweep the same day still leaves its record, without a notice.
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { automaticAction } from './automaticAction'

/** Plain names for the tables a sweep touches; others fall back to the table name. */
const LABELS: Record<string, string> = {
  central_message: 'chat messages and notices', central_turn: 'chat turns', event: 'audit entries', memory_event: 'memory history entries',
  central_skill: 'skill proposals', central_agents: 'ended agents', usage: 'usage rows', run: 'runs', agent_outbox: 'delivered messages',
}

/** The sentence for a sweep's `changed` summary (table -> rows); null when nothing was removed. */
export function retentionSweepText(changed: Record<string, number>): string | null {
  const parts = Object.entries(changed).filter(([, n]) => n > 0).sort(([, a], [, b]) => b - a)
    .map(([table, n]) => `${n} ${LABELS[table] ?? table.replace(/_/g, ' ')}`)
  return parts.length === 0 ? null : `Cleaned up old records: ${parts.join(', ')}. They were past their keep period.`
}

/** Reaper hook (index.ts `onRetention`); `db` defaults to the active ledger. Never throws (automaticAction). */
export function announceRetentionSweep(changed: Record<string, number>, now: () => number = Date.now, db = activeLedgerRuntime()?.db ?? null): void {
  const text = retentionSweepText(changed)
  if (!text) return
  const input = { name: 'retention_sweep', actor: 'system:retention', subject: 'retention', text }
  const deps = { db, now }
  if (!automaticAction(deps, { ...input, noticeKey: `auto:retention_sweep:${new Date(now()).toISOString().slice(0, 10)}` })) automaticAction(deps, { ...input, noNotice: true })
}
