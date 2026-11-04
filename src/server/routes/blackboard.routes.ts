// F5-b: the shared blackboard (`/api/blackboard`, UI + node tokens) and the consolidator's proposals
// (`/api/memory-proposals`, UI-only). Mounted next to the memory panel controls, before the generic memory writes.
import { requesterNodeId } from '../agentStatusAuth'
import { handleBlackboardApi, isBlackboardPath } from '../blackboard/blackboard.api'
import { BodyReadError } from '../cappedRequestBody'
import { isValidNodeToken } from '../hooksTokens'
import { activeConsolidator } from '../memory/consolidator/consolidator.boot'
import { handleProposalsApi, isProposalsPath } from '../memory/consolidator/consolidator.api'
import { json, type ApiRoute, type RouteCtx } from './route.core'

const BODY_MAX_BYTES = 8 * 1024

/** JSON body of a POST, or a sent 4xx (`undefined`). */
async function jsonBody(c: RouteCtx): Promise<{ body: unknown } | undefined> {
  let text: string
  try {
    text = await c.body(BODY_MAX_BYTES)()
  } catch (err) {
    if (!(err instanceof BodyReadError)) throw err
    json(c.res, err.reason === 'too_large' ? 413 : 400, { error: err.reason })
    return undefined
  }
  try {
    return { body: text === '' ? {} : JSON.parse(text) }
  } catch {
    json(c.res, 400, { error: 'invalid_json' })
    return undefined
  }
}

export const blackboardRoutes: ApiRoute[] = [
  {
    name: 'blackboard',
    match: (c) => isBlackboardPath(c.path),
    handle: async (c) => {
      const ledger = c.ledger()
      if (!ledger) { json(c.res, 503, { error: 'ledger_off' }); return true }
      const parsed = c.method === 'POST' ? await jsonBody(c) : { body: undefined }
      if (!parsed) return true
      const out = handleBlackboardApi(c.req, c.url, parsed.body, { db: ledger.db, isNodeToken: isValidNodeToken, nodeOf: requesterNodeId, now: Date.now })
      if (!out) return false
      json(c.res, out.status, out.body)
      return true
    },
  },
  {
    name: 'memory-proposals',
    match: (c) => isProposalsPath(c.path),
    handle: async (c) => {
      const ledger = c.ledger()
      if (!ledger) { json(c.res, 503, { error: 'ledger_off' }); return true }
      const out = await handleProposalsApi(c.req, c.url, { db: ledger.db, isNodeToken: isValidNodeToken, now: Date.now, consolidator: activeConsolidator() })
      if (!out) return false
      json(c.res, out.status, out.body)
      return true
    },
  },
]
