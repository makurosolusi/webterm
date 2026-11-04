// Classifier switch + policy simulator (F4-d): UI-only, own path family next to the grants routes.
import { BodyReadError } from '../cappedRequestBody'
import { activeEventLog } from '../events/eventsRuntime'
import { isValidNodeToken } from '../hooksTokens'
import { handlePolicySimApi, isPolicySimPath } from '../policy/policy.sim.api'
import { activePolicy } from '../policy/policy.runtime'
import { json, type ApiRoute } from './route.core'

const BODY_MAX_BYTES = 32 * 1024

export const policySimRoutes: ApiRoute[] = [
  {
    name: 'policy-sim',
    match: (c) => isPolicySimPath(c.path),
    handle: async (c) => {
      const ledger = c.ledger()
      const policy = activePolicy()
      const log = activeEventLog()
      if (!ledger || !policy || !log) { json(c.res, 503, { error: 'ledger_off' }); return true }
      let body: unknown
      if (c.method === 'POST' || c.method === 'PUT') {
        let text: string
        try {
          text = await c.body(BODY_MAX_BYTES)()
        } catch (err) {
          if (!(err instanceof BodyReadError)) throw err
          json(c.res, err.reason === 'too_large' ? 413 : 400, { error: err.reason })
          return true
        }
        try {
          body = text === '' ? {} : JSON.parse(text)
        } catch {
          json(c.res, 400, { error: 'invalid_json' })
          return true
        }
      }
      const out = handlePolicySimApi(c.req, c.url, body, { db: ledger.db, policy, append: (e) => { log.append(e) }, isNodeToken: isValidNodeToken, now: Date.now })
      json(c.res, out.status, out.body)
      return true
    },
  },
]
