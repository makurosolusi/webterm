// Read-only human approval handlers: the shared-challenge view and the approved-consent list.
import { boundedText, failure, invalid } from './approvalFailures'
import { MAX_LIST_LIMIT, listApprovedUnconsumed, readChallenge } from './approvalQuery'
import { MAX_PROJECT_ID, paging, type Result } from './approvalHumanShared'
import type { LedgerRuntime } from './ledger/ledgerRuntime'

export function challengeRoute(runtime: LedgerRuntime, url: URL, now: number): Result {
  const id = boundedText(url.searchParams.get('id') ?? undefined, MAX_PROJECT_ID)
  if (!id) return invalid('id')
  const view = readChallenge(runtime.db, id, now)
  return view ? { status: 200, body: view } : failure(404, 'approval_not_found')
}

/** `GET /api/approvals?status=approved` — approved-but-unconsumed consent, paginated. */
export function listRoute(runtime: LedgerRuntime, url: URL, now: number): Result {
  if (url.searchParams.get('status') !== 'approved') return invalid('status')
  const projectId = url.searchParams.get('projectId')
  if (projectId !== null && (projectId.trim() === '' || projectId.length > MAX_PROJECT_ID)) {
    return invalid('projectId')
  }
  const limit = paging(url.searchParams.get('limit'), 1, MAX_LIST_LIMIT)
  if (limit === null) return invalid('limit')
  const offset = paging(url.searchParams.get('offset'), 0, 1_000_000)
  if (offset === null) return invalid('offset')
  return {
    status: 200,
    body: listApprovedUnconsumed(runtime.db, {
      ...(projectId === null ? {} : { projectId }),
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
      now,
    }),
  }
}
