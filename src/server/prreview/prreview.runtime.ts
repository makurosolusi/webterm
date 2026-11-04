// Production wiring of the PR review bot: the process-wide `agent.spawn`, the real `gh`, worktrees
// under `<dataDir>/worktrees`. One service per active ledger, built on first use (zero-config).
// An approval decided anywhere (Inbox button, Telegram, the SCM panel's Post review) emits
// `inbox.decision`; that is what posts the draft. `reconcile` catches decisions made while down.
import { eventBus } from '../events/eventBus'
import { INBOX_DECISION_EVENT } from '../inbox/inboxItemModel'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { createLogger } from '../logs'
import { spawnAgent } from '../spawn/agentSpawn'
import { createGh } from './prreview.gh'
import { createPrReviewService, PRREVIEW_SOURCE, type PrReviewService } from './prreview.service'
import { getInboxItem } from '../inbox/inboxItemStore'

const log = createLogger('prreview')
let shared: { db: unknown; service: PrReviewService; off: () => void } | null = null

/** The PR review service over the active ledger; null when the ledger is off. */
export function prReviewService(): PrReviewService | null {
  const rt = activeLedgerRuntime()
  if (!rt) return null
  if (shared?.db !== rt.db) {
    shared?.off()
    const ctx = { db: rt.db, now: Date.now }
    const service = createPrReviewService({ ctx, gh: createGh(), spawn: (req) => spawnAgent(req) })
    const off = eventBus.subscribe(INBOX_DECISION_EVENT, (e) => {
      const p = e.payload as { approvalId?: string; decision?: string } | null
      if (p?.decision !== 'approve' || !p.approvalId || getInboxItem(rt.db, p.approvalId)?.source !== PRREVIEW_SOURCE) return
      service.post(p.approvalId).catch((err: unknown) => log.warn('prreview.post_failed', `Posting draft review ${p.approvalId} failed`, { cause: err instanceof Error ? err.message : String(err) }))
    })
    void service.reconcile()
    shared = { db: rt.db, service, off }
  }
  return shared.service
}

/** Routine `prreview` action: one poll of the repo's open PRs, summed up in one line. */
export async function pollPrReviews(input: { repo: string; workspaceId: string | null; parent: string }): Promise<string> {
  const service = prReviewService()
  if (!service) throw new Error('the webterm ledger is off; PR review drafts need the Inbox')
  const r = await service.poll({ repo: input.repo, workspaceId: input.workspaceId, parent: input.parent, door: 'routine' })
  return r.reviewed.length ? `reviewed PR ${r.reviewed.map((n) => `#${n}`).join(', ')}; drafts are in the Inbox` : `no new PR heads (${r.skipped} already reviewed)`
}
