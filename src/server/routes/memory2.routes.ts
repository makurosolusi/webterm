// Memory panel controls (F5-a): UI-only, its own path family `/api/memory2` next to the procedural route.
import { BodyReadError } from '../cappedRequestBody'
import { dataDir } from '../config'
import { isValidNodeToken } from '../hooksTokens'
import { handleMemoryControlsApi, isMemoryControlsPath } from '../memory/memoryControls.api'
import { createMemoryFilePort } from '../memory/memoryFilePath'
import { createUserMemoryStore, userMemoryRoot } from '../memory/memoryUserStore'
import { json, type ApiRoute } from './route.core'

const BODY_MAX_BYTES = 8 * 1024

export const memory2Routes: ApiRoute[] = [
  {
    name: 'memory-controls',
    match: (c) => isMemoryControlsPath(c.path),
    handle: async (c) => {
      const ledger = c.ledger()
      if (!ledger) { json(c.res, 503, { error: 'ledger_off' }); return true }
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
      const removeUserFile = (key: string): Promise<void> =>
        createUserMemoryStore(createMemoryFilePort(userMemoryRoot(process.env, dataDir()))).remove(key)
      const out = await handleMemoryControlsApi(c.req, c.url, body, { db: ledger.db, isNodeToken: isValidNodeToken, now: Date.now, removeUserFile })
      if (!out) return false
      json(c.res, out.status, out.body)
      return true
    },
  },
]
