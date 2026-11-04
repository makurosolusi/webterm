// PR review bot (F6): `/api/prreview*`. Reads are open behind the transport gate, writes are UI-only (prreview.api.ts).
import { LEDGER_OFF } from '../apiShared.types'
import { BodyReadError } from '../cappedRequestBody'
import { recordEvent } from '../events/producers'
import { isValidNodeToken } from '../hooksTokens'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { handlePrReviewApi, PRREVIEW_BODY_MAX_BYTES, PRREVIEW_PATH } from '../prreview/prreview.api'
import { prReviewService } from '../prreview/prreview.runtime'
import { json, send, type ApiRoute } from './route.core'

export const prReviewRoutes: ApiRoute[] = [
  {
    name: 'prreview',
    match: (c) => c.path === PRREVIEW_PATH || c.path.startsWith(`${PRREVIEW_PATH}/`),
    handle: async (c) => {
      const service = prReviewService()
      const rt = activeLedgerRuntime()
      if (!service || !rt) return send(c.res, LEDGER_OFF)
      try {
        const deps = { service, ctx: { db: rt.db, now: Date.now }, isNodeToken: isValidNodeToken, record: recordEvent }
        return send(c.res, await handlePrReviewApi(deps, c.req, c.url, c.body(PRREVIEW_BODY_MAX_BYTES)))
      } catch (err) {
        if (!(err instanceof BodyReadError)) throw err
        json(c.res, err.reason === 'too_large' ? 413 : 400, { error: err.reason })
        return true
      }
    },
  },
]
