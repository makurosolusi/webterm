// /api/browser/*: only exists while the browser runtime is alive (flag on). The auth gate in
// index.ts already rejects node tokens (this prefix is not on the node-token allowlist).
import { activeBrowser } from '../browser/browser.state'
import { BROWSER_BODY_MAX_BYTES } from '../browserApi'
import { send, type ApiRoute } from './route.core'

export const browserRoutes: ApiRoute[] = [
  {
    name: 'browser',
    handle: async (c) => {
      const result = await activeBrowser()?.api(c.method, c.path, c.body(BROWSER_BODY_MAX_BYTES), c.url.searchParams)
      for (const [k, v] of Object.entries(result?.headers ?? {})) c.res.setHeader(k, v) // e.g. Content-Disposition of a cookie export
      return send(c.res, result)
    },
  },
]
