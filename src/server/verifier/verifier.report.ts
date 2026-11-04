// Puts a completion verdict where the human sees it (F4-c): a `verifier.verdict` row on the Activity
// timeline (plus `verifier.lease_violation` when flagged) and an inbox item
// (`brisk-otter finished: 4 files, tests green ✓`). Best effort: a broken ledger never changes the
// verdict that was already decided, it is logged instead.
import { createInboxItem } from '../inbox/inboxItemStore'
import type { LedgerContext } from '../ledger/ledgerCore'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { recordEvent } from '../events/producers'
import { createLogger } from '../logs'
import type { CompletionVerdict } from './verifier.judge'

const log = createLogger('verifier')

export const VERDICT_EVENT = 'verifier.verdict'
export const LEASE_VIOLATION_EVENT = 'verifier.lease_violation'

export interface CompletionReport {
  verdict: CompletionVerdict
  taskId: string
  /** Display name of the worker (node title or agent id). */
  worker: string
  projectId?: string | null
  workspaceId?: string | null
  nodeId?: string | null
}

export type ReportCompletion = (report: CompletionReport) => void

/** `<worker> finished: 4 files, tests green ✓` / `<worker> failed verification: no changes`. */
export function completionTitle(report: CompletionReport): string {
  const v = report.verdict
  return v.status === 'done' ? `${report.worker} finished: ${v.summary}` : `${report.worker} failed verification: ${v.message}`
}

function defaultLedger(): LedgerContext | null {
  const rt = activeLedgerRuntime()
  return rt ? { db: rt.db, now: Date.now } : null
}

/** Timeline events + inbox item for one verdict. Never throws. */
export function recordCompletion(report: CompletionReport, ledger: () => LedgerContext | null = defaultLedger): void {
  const { verdict } = report
  const base = { source: 'verifier', actor: 'verifier', subject: `task:${report.taskId}`, workspaceId: report.workspaceId ?? null, nodeId: report.nodeId ?? null, trust: 'trusted' as const }
  recordEvent({ ...base, kind: VERDICT_EVENT, payload: { taskId: report.taskId, status: verdict.status, reason: verdict.reason, summary: verdict.summary, receipt: verdict.receipt } })
  if (verdict.leaseViolations.length > 0) {
    recordEvent({ ...base, kind: LEASE_VIOLATION_EVENT, payload: { taskId: report.taskId, files: verdict.leaseViolations.slice(0, 50) } })
  }
  try {
    const ctx = ledger()
    if (!ctx) return
    createInboxItem(ctx, {
      kind: verdict.status === 'done' ? 'review' : 'notify',
      source: 'verifier',
      title: completionTitle(report),
      body: (verdict.receipt.evidence['diffStat'] as string | undefined) || null,
      projectId: report.projectId ?? null,
      workspaceId: report.workspaceId ?? null,
      nodeId: report.nodeId ?? null,
      dedupeKey: `verifier:${report.taskId}`,
    })
  } catch (err) {
    log.warn('verifier.inbox.failed', `inbox item for task ${report.taskId} not written`, { cause: err instanceof Error ? err.message : String(err) })
  }
}
