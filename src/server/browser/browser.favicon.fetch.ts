// Fetches one favicon through the page's own Chromium (`Network.loadNetworkResource`): same profile, cookies, proxy and
// network rules as the page, so localhost dev servers and sites that need a session work, and no second HTTP client
// exists that could bypass the guard. The body is read in chunks and abandoned once it passes the size cap.
import { MAX_FAVICON_BYTES } from '../../shared/browser.favicon'
import { hostOnly } from '../../shared/browser.url'
import { createLogger } from '../logs'
import { CDP } from './cdp.client'
import { faviconDataUri, decodeDataUrl } from './browser.favicon.image'

const log = createLogger('browser.favicon')

/** Sends one CDP command on the page's session. */
export type PageSend = (method: string, params?: object) => Promise<Record<string, unknown>>

const READ_CHUNK_BYTES = 16 * 1024
const HTTP_OK_MIN = 200
const HTTP_OK_MAX = 299

interface Resource { success?: boolean; httpStatusCode?: number; netError?: number; stream?: string }

/** The main frame's id (loadNetworkResource is addressed to a frame). */
async function mainFrameId(send: PageSend): Promise<string> {
  const r = await send(CDP.getFrameTree) as { frameTree?: { frame?: { id?: unknown } } }
  const id = r.frameTree?.frame?.id
  if (typeof id !== 'string') throw new Error('Page.getFrameTree returned no main frame id')
  return id
}

/** A stream that will not close only lives until its page goes away; the failure is logged, the icon result is unaffected. */
async function closeStream(send: PageSend, handle: string): Promise<void> {
  try { await send(CDP.ioClose, { handle }) } catch (err) {
    log.warn('browser.favicon.io', 'closing an icon stream failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

async function readStream(send: PageSend, handle: string): Promise<Uint8Array | null> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const r = await send(CDP.ioRead, { handle, size: READ_CHUNK_BYTES }) as { data?: string; base64Encoded?: boolean; eof?: boolean }
      const part = Buffer.from(r.data ?? '', r.base64Encoded ? 'base64' : 'utf8')
      total += part.length
      if (total > MAX_FAVICON_BYTES) return null // too big to be an icon: stop reading, keep nothing
      chunks.push(part)
      if (r.eof) return Buffer.concat(chunks)
    }
  } finally {
    await closeStream(send, handle)
  }
}

/**
 * Data URI for the icon at `url`, or null when it is unreachable, not a 2xx, too big, or not a safe image.
 * `fresh` bypasses the HTTP cache (a reload of the page: the developer just changed the icon). Throws on CDP failure.
 */
export async function fetchFavicon(send: PageSend, url: string, fresh: boolean): Promise<string | null> {
  if (url.startsWith('data:')) {
    const bytes = decodeDataUrl(url)
    return bytes ? faviconDataUri(bytes) : null
  }
  const frameId = await mainFrameId(send)
  const res = (await send(CDP.loadNetworkResource, { frameId, url, options: { disableCache: fresh, includeCredentials: true } }) as { resource?: Resource }).resource
  if (!res?.success || !res.stream) return null
  const status = res.httpStatusCode ?? HTTP_OK_MIN
  if (status < HTTP_OK_MIN || status > HTTP_OK_MAX) {
    await closeStream(send, res.stream)
    return null
  }
  const bytes = await readStream(send, res.stream)
  if (!bytes) return null
  return faviconDataUri(bytes)
}

/** Host only: what logs may say about an icon URL (never its query or path). */
export const iconHost = (url: string): string => (url.startsWith('data:') ? 'data-uri' : hostOnly(url))
