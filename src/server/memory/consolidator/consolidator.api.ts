// `/api/memory-proposals[...]`: the consolidator's proposals in the memory panel. UI-only (same gate as
// `/api/memory2`): an agent credential gets 403 before any memory code runs. Dismissing a proposal is the
// existing `POST /api/memory2/:id/forget` (tombstone, so the same text is never proposed again).
//   GET                      {proposals, tokensToday, dailyTokens}
//   POST /:id/confirm        {result}          POST /confirm-all   {results}
//   POST /run                {runs}  review every node active in the last day now (human-triggered)
import type { IncomingMessage } from 'node:http'
import type { Database } from 'bun:sqlite'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../../approvalAuth'
import { MemoryAuthorityError, type MemoryAuthority, MemoryRejectedError } from '../memoryModel'
import type { RunResult } from './consolidator.runtime'
import {
  CONSOLIDATOR_DAILY_TOKENS, confirmAllConsolidatorProposals, confirmConsolidatorProposal, listConsolidatorProposals, tokensToday,
} from './consolidator.store'

export const PROPOSALS_PATH = '/api/memory-proposals'
const HUMAN: MemoryAuthority = { kind: 'human', id: 'human-ui' }

export const isProposalsPath = (p: string): boolean => p === PROPOSALS_PATH || p.startsWith(`${PROPOSALS_PATH}/`)

export interface ProposalsDeps {
  db: Database
  isNodeToken: (token: string) => boolean
  now: () => number
  /** The running consolidator (consolidator.boot); null = not started (tests, ledger off). */
  consolidator: { runNow(nodeId: string): Promise<RunResult>; recentNodes(): string[] } | null
}

type Result = { status: number; body: unknown }

async function dispatch(method: string, url: URL, deps: ProposalsDeps): Promise<Result> {
  const { db } = deps
  const [rawId = '', action = ''] = url.pathname.slice(PROPOSALS_PATH.length + 1).split('/')
  if (!rawId && method === 'GET') {
    return { status: 200, body: { proposals: listConsolidatorProposals(db), tokensToday: tokensToday(db, deps.now()), dailyTokens: CONSOLIDATOR_DAILY_TOKENS } }
  }
  if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  if (rawId === 'confirm-all' && !action) return { status: 200, body: { results: confirmAllConsolidatorProposals(db, HUMAN, deps.now()) } }
  if (rawId === 'run' && !action) {
    const c = deps.consolidator
    if (!c) return { status: 503, body: { error: 'consolidator_off' } }
    const runs: Array<{ nodeId: string; status: string; written: number }> = []
    for (const nodeId of c.recentNodes()) {
      const r = await c.runNow(nodeId)
      runs.push({ nodeId, status: r.status, written: r.written.length })
    }
    return { status: 200, body: { runs } }
  }
  if (rawId && action === 'confirm') return { status: 200, body: { result: confirmConsolidatorProposal(db, HUMAN, decodeURIComponent(rawId), deps.now()) } }
  return { status: 405, body: { error: 'method_not_allowed' } }
}

/** Handles `/api/memory-proposals*`; null when `url` is not ours. Errors map to stable codes. */
export async function handleProposalsApi(req: IncomingMessage, url: URL, deps: ProposalsDeps): Promise<Result | null> {
  if (!isProposalsPath(url.pathname)) return null
  const denial = uiOnlyDenial(req, url, deps.isNodeToken)
  if (denial) return { status: 403, body: { error: denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_remember' : denial } }
  try {
    return await dispatch(req.method ?? 'GET', url, deps)
  } catch (err) {
    if (err instanceof MemoryRejectedError) return { status: err.code === 'not_found' ? 404 : 400, body: { error: err.code } }
    if (err instanceof MemoryAuthorityError) return { status: 403, body: { error: 'forbidden' } }
    if (err instanceof URIError) return { status: 400, body: { error: 'invalid_id' } }
    throw err
  }
}
