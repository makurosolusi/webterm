// /api/browser/*: only exists while the browser runtime is alive (flag on). The auth gate in
// index.ts already rejects node tokens (this prefix is not on the node-token allowlist).
import { createReadStream, statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { activeBrowser } from '../browser/browser.state'
import { BROWSER_BODY_MAX_BYTES } from '../browserApi'
import { createLogger } from '../logs'
import { json, send, type ApiRoute } from './route.core'

const log = createLogger('browser.routes')

/** `Content-Disposition: attachment` with an ASCII fallback name plus the RFC 5987 UTF-8 name (the stored name is already free of quotes and separators). */
export const attachmentHeader = (name: string): string =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`

/** Stream a stored download. Always an opaque attachment: a downloaded page must never render inside webterm's own origin. */
function sendFile(res: ServerResponse, file: { path: string; name: string }): void {
  let size: number
  try {
    size = statSync(file.path).size
  } catch (err) {
    log.warn('browser.download.file', 'download file is gone', { error: err instanceof Error ? err.message : String(err) })
    json(res, 404, { error: 'not_found' })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Content-Disposition': attachmentHeader(file.name),
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
  })
  const stream = createReadStream(file.path)
  stream.on('error', (err) => { log.warn('browser.download.file', 'download stream failed', { error: err.message }); res.destroy() })
  stream.pipe(res)
}

export const browserRoutes: ApiRoute[] = [
  {
    name: 'browser',
    handle: async (c) => {
      const result = await activeBrowser()?.api(c.method, c.path, c.body(BROWSER_BODY_MAX_BYTES), c.url.searchParams)
      for (const [k, v] of Object.entries(result?.headers ?? {})) c.res.setHeader(k, v) // e.g. Content-Disposition of a cookie export
      if (result?.file) { sendFile(c.res, result.file); return true }
      return send(c.res, result)
    },
  },
]
