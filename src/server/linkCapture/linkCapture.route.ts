// POST /api/link-open { url }: a terminal (or agent) asks for a link to be opened in ITS canvas. Identity is the
// calling node, proven by either the limited link credential (plain terminals) or the node token (agents);
// the target board is always that node's own, never a client-supplied one. See docs/decisions/canvas-link-capture.md.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { requesterOf } from '../browser/browser.linkedTarget'
import { activeBrowser } from '../browser/browser.state'
import { asObject } from '../control/controlTypes'
import { firstHeader } from '../httpHeaders'
import { json } from '../routes/route.core'
import { captureLinksOn, LINK_OPEN_PATH, LINK_TOKEN_HEADER } from './linkCapture.config'
import { linkCredentialOwner } from './linkCapture.identity'

/** Node that sent the request: link credential first (it only ever names its own node), else the node token. */
export function linkOriginOf(headers: IncomingMessage['headers']): string | undefined {
  return linkCredentialOwner(firstHeader(headers[LINK_TOKEN_HEADER])) ?? requesterOf(headers)
}

/** `false` = not this route (keep falling through). */
export async function linkOpenRoute(req: IncomingMessage, res: ServerResponse, url: URL, readBody: () => Promise<string>, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (url.pathname !== LINK_OPEN_PATH) return false
  if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }); return true }
  const origin = linkOriginOf(req.headers)
  if (!origin) { json(res, 401, { error: 'unauthorized' }); return true }
  // Switch off (Settings > Browser): a session started while it was on still holds the shims; it hands the link to the machine opener.
  if (!captureLinksOn(env)) { json(res, 200, { ok: true, mode: 'machine' }); return true }
  const browser = activeBrowser()
  if (!browser?.openLink) {
    json(res, 503, { error: 'browser_off', message: 'The canvas browser is off (Settings > Browser), so the link was not opened.' })
    return true
  }
  let body: unknown
  try {
    body = JSON.parse(await readBody())
  } catch {
    json(res, 400, { error: 'invalid_json', message: 'The request body is not valid JSON.' })
    return true
  }
  const result = await browser.openLink(origin, asObject(body).url)
  json(res, result.status, result.body)
  return true
}
