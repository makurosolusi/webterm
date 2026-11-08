// POST /api/canvas-shot/<reqId>: a UI tab answers a `t:'shot'` request (canvas.screenshot, shotBroker.ts).
// Body: raw png/jpeg bytes (format from magic bytes, never the header) or `{"error":"<code>"}` JSON when
// the tab could not capture. 204 accepted · 404 unknown/expired id · 409 already answered · 413 too
// large · 415 not png/jpeg. Human-UI only (uiOnly): an agent must not be able to forge what the user sees.
import { readBinaryBody, sniffImage } from '../canvasBackground.store'
import { getShotBroker, type ShotBroker, type ShotResult } from '../canvas/shotBroker'
import { uiOnly } from './route.uiOnly'
import { json, type ApiRoute, type RouteCtx } from './route.core'

export const CANVAS_SHOT_PREFIX = '/api/canvas-shot/'
export const MAX_SHOT_BYTES = 4 * 1024 * 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ERROR_CODE_RE = /^[a-z0-9_]{1,40}$/
const MIME = { png: 'image/png', jpg: 'image/jpeg' } as const

/** The tab's failure code, or a generic one when the JSON is malformed. */
function clientError(body: Buffer): ShotResult {
  try {
    const code = (JSON.parse(body.toString('utf8')) as { error?: unknown }).error
    return { ok: false, code: typeof code === 'string' && ERROR_CODE_RE.test(code) ? code : 'capture_failed' }
  } catch {
    return { ok: false, code: 'capture_failed' } // unparseable error report: still an answer, the tab could not capture
  }
}

/** Handles one upload; false = not this route. */
export async function canvasShotRoute(c: Pick<RouteCtx, 'req' | 'res' | 'path' | 'method'>, broker: ShotBroker): Promise<boolean> {
  if (!c.path.startsWith(CANVAS_SHOT_PREFIX)) return false
  const { res } = c
  if (c.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return true }
  const reqId = c.path.slice(CANVAS_SHOT_PREFIX.length)
  if (!UUID_RE.test(reqId)) { c.req.resume(); json(res, 404, { error: 'unknown_request' }); return true }
  const body = await readBinaryBody(c.req, MAX_SHOT_BYTES)
  if (body === 'too_large') { json(res, 413, { error: 'payload_too_large', maxBytes: MAX_SHOT_BYTES }); return true }
  let result: ShotResult
  if (String(c.req.headers['content-type'] ?? '').startsWith('application/json')) result = clientError(body)
  else {
    const ext = sniffImage(body)
    if (ext !== 'png' && ext !== 'jpg') { json(res, 415, { error: 'unsupported_image', accepted: ['png', 'jpeg'] }); return true }
    result = { ok: true, mimeType: MIME[ext], data: body.toString('base64') }
  }
  const answer = broker.answer(reqId, result)
  if (answer === 'unknown') json(res, 404, { error: 'unknown_request' })
  else if (answer === 'answered') json(res, 409, { error: 'already_answered' })
  else json(res, 204)
  return true
}

export const canvasShotRoutes: ApiRoute[] = [uiOnly({
  name: 'canvas-shot',
  match: (c) => c.path.startsWith(CANVAS_SHOT_PREFIX),
  handle: (c) => canvasShotRoute(c, getShotBroker()),
})]
