// Bake-off (F6): `/api/bakeoff*`. Reads are open behind the transport gate, writes are UI-only (bakeoff.api.ts).
import { LEDGER_OFF } from '../apiShared.types'
import { BodyReadError } from '../cappedRequestBody'
import { BAKEOFF_BODY_MAX_BYTES, BAKEOFF_PATH, handleBakeoffApi } from '../bakeoff/bakeoff.api'
import { bakeoffService } from '../bakeoff/bakeoff.runtime'
import { isValidNodeToken } from '../hooksTokens'
import { json, send, type ApiRoute } from './route.core'

export const bakeoffRoutes: ApiRoute[] = [
  {
    name: 'bakeoff',
    match: (c) => c.path === BAKEOFF_PATH || c.path.startsWith(`${BAKEOFF_PATH}/`),
    handle: async (c) => {
      const service = bakeoffService()
      if (!service) return send(c.res, LEDGER_OFF)
      try {
        return send(c.res, await handleBakeoffApi({ service, isNodeToken: isValidNodeToken }, c.req, c.url, c.body(BAKEOFF_BODY_MAX_BYTES)))
      } catch (err) {
        if (!(err instanceof BodyReadError)) throw err
        json(c.res, err.reason === 'too_large' ? 413 : 400, { error: err.reason })
        return true
      }
    },
  },
]
