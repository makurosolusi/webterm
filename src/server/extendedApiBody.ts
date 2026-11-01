// Body intake for the P3/P4 runtime mount (`extendedApi`). Kept apart from the route table so the
// mount file stays under the route budget; the cap semantics live here and nowhere else.
//
// Bodies are capped hard (16 KiB) *while streaming* and must be a JSON object. Nothing from the
// body is ever logged here.
import type { IncomingMessage } from 'node:http'
import { declaredLength, readCappedBody } from './channels/channelHttp'

export const MAX_API_BODY_BYTES = 16 * 1024

type JsonResult = { ok: true; value: Record<string, unknown> } | { ok: false }

/** Empty, array, scalar and malformed text are all "not a JSON object". */
export function parseJsonObject(raw: string): JsonResult {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false }
  try {
    const value = JSON.parse(trimmed) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false }
    return { ok: true, value: value as Record<string, unknown> }
  } catch {
    return { ok: false }
  }
}

/** Raw body plus the HTTP answer to send when intake refuses it. */
export type BoundedBody =
  | { ok: true; raw: string }
  | { ok: false; status: number; error: string }

/**
 * Reads a POST body under `MAX_API_BODY_BYTES`; non-POST methods read nothing.
 *
 * Cap BEFORE buffering anything: a declared oversize is refused without reading a byte, and the
 * streaming reader stops at MAX+1 (then drains), so a chunked multi-GB body is never accumulated.
 * Overflow already dropped the listener and resumed the stream inside the reader.
 */
export async function readBoundedBody(req: IncomingMessage, method: string): Promise<BoundedBody> {
  if (method !== 'POST') return { ok: true, raw: '' }
  const declared = declaredLength(req.headers['content-length'])
  if (declared !== undefined && declared > MAX_API_BODY_BYTES) {
    req.resume() // drain so keep-alive is not desynced by an unread body
    return { ok: false, status: 413, error: 'payload_too_large' }
  }
  const read = await readCappedBody(req, MAX_API_BODY_BYTES)
  if (!read.ok) {
    return read.reason === 'too_large'
      ? { ok: false, status: 413, error: 'payload_too_large' }
      : { ok: false, status: 400, error: 'body_read_failed' }
  }
  return { ok: true, raw: read.body }
}
