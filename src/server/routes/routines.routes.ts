// Routines (F4-a): Schedule / Event / API triggered agent runs. UI-only except the API `fire` verb
// (see routines/routines.api.ts); a path family of its own, so it does not shadow other routes.
import { BodyReadError } from '../cappedRequestBody'
import { isValidNodeToken } from '../hooksTokens'
import { handleRoutinesApi, ROUTINES_PATH } from '../routines/routines.api'
import { ensureRoutines } from '../routines/routinesRuntime'
import { json, type ApiRoute } from './route.core'

const BODY_MAX_BYTES = 64 * 1024

export const routinesRoutes: ApiRoute[] = [
  {
    name: 'routines',
    match: (c) => c.path === ROUTINES_PATH || c.path.startsWith(`${ROUTINES_PATH}/`),
    handle: async (c) => {
      const runtime = ensureRoutines()
      if (!runtime) { json(c.res, 503, { error: 'ledger_off' }); return true }
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
      const out = handleRoutinesApi(c.req, c.url, body, { runtime, isNodeToken: isValidNodeToken })
      json(c.res, out.status, out.body)
      return true
    },
  },
]
