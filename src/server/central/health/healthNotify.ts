// H3: turns a finished scan into check-in reasons, so Central speaks up with evidence instead of waiting to be asked.
// Only what needs a decision wakes it: new HIGH findings of a project scan, new high/medium findings of a task review,
// and a dismissed finding whose evidence changed (argue once with new data). Delivery limits live in workCheckin.
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import type { FindingView, HealthLevel } from '../../../shared/centralHealth'
import { getRow } from '../../ledger/ledgerCore'
import { createLogger } from '../../logs'
import { queueCheckinReason } from '../work/workCheckin'
import type { FinishScanResult } from './healthStore'

/** Findings listed in one reason; the rest are counted. */
export const NOTIFY_LIST_MAX = 5
const EVIDENCE_CHARS = 120
const log = createLogger('central.health')
const REVIEW_LEVELS: readonly HealthLevel[] = ['high', 'medium']

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)
const where = (f: FindingView): string => (f.line === null ? f.file : `${f.file}:${f.line}`)
const item = (f: FindingView): string => `${f.severity} ${f.title} — ${where(f)} (${clip(f.evidence, EVIDENCE_CHARS)})`
const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

function listed(found: readonly FindingView[]): string {
  const more = found.length > NOTIFY_LIST_MAX ? `; +${found.length - NOTIFY_LIST_MAX} more` : ''
  return `${found.slice(0, NOTIFY_LIST_MAX).map(item).join('; ')}${more}`
}

const projectName = (db: Database, id: string): string => String(getRow(db, 'SELECT name FROM project WHERE id = ?', id)?.['name'] ?? id)

/** True when no other finished project scan exists: the first scan only speaks about high findings and says so. */
const firstScan = (db: Database, projectId: string, scanId: string): boolean =>
  getRow(db, `SELECT 1 AS one FROM central_health_scan WHERE project_id = ? AND origin = 'scan' AND status = 'done' AND id != ? LIMIT 1`, projectId, scanId) === null

/**
 * Queues the check-in reasons a finished scan deserves; returns how many new ones were written.
 * Idempotent: every reason has a dedupe key, so calling it twice for one scan changes nothing.
 */
export function notifyScanResult(db: Database, result: FinishScanResult, now: number): number {
  const { scan, opened, changedDismissed } = result
  const name = projectName(db, scan.projectId)
  let queued = 0
  const queue = (input: Parameters<typeof queueCheckinReason>[1]): void => { if (queueCheckinReason(db, input)) queued++ }

  if (scan.origin === 'scan') {
    const high = opened.filter((f) => f.severity === 'high')
    if (high.length > 0) {
      const label = firstScan(db, scan.projectId, scan.id) ? 'First health scan' : 'Health scan'
      queue({ kind: 'health_finding', dedupeKey: `health:scan:${scan.id}`, projectId: scan.projectId, taskId: null, now,
        text: `${label} of project ${name} opened ${high.length} high-severity finding(s): ${listed(high)}` })
    }
  } else if (scan.origin === 'review') {
    const found = opened.filter((f) => REVIEW_LEVELS.includes(f.severity))
    const taskId = found[0]?.taskId ?? null
    if (found.length > 0 && taskId !== null) {
      queue({ kind: 'health_finding', dedupeKey: `health:review:${taskId}:${scan.id}`, projectId: scan.projectId, taskId, now,
        text: `Review checks of a task in project ${name} found ${found.length} issue(s) in its changes: ${listed(found)}` })
    }
  }

  for (const { finding: f, evidence } of changedDismissed) {
    queue({ kind: 'health_changed', dedupeKey: `health:changed:${f.id}:${sha(evidence)}`, projectId: f.projectId, taskId: f.taskId, now,
      text: `You dismissed "${f.title}" (${f.dismissedReason ?? 'no reason'}) — ${where(f)} in project ${name}; the evidence changed: was ${clip(f.evidence, EVIDENCE_CHARS)}, now ${clip(evidence, EVIDENCE_CHARS)}` })
  }
  return queued
}

/** Queues the check-in reasons of a finished scan; a failure is logged with the scan id and never fails the scan. */
export function notifyFinished(db: Database, result: FinishScanResult, now: number): void {
  try {
    notifyScanResult(db, result, now)
  } catch (err) {
    log.warn('health.notify_failed', `could not queue check-in reasons for health scan ${result.scan.id}`, { scanId: result.scan.id, projectId: result.scan.projectId, error: err instanceof Error ? err.message : String(err) })
  }
}
