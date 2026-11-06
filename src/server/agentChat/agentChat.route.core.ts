// Shared plumbing of the agent chat route files (agentChat.route*.ts): context type, JSON answers,
// capped JSON body reader and query integer parsing.
import { BodyReadError } from '../cappedRequestBody'
import { json, type RouteCtx } from '../routes/route.core'

/** Bytes of one POST body (a permission answer can carry an edited tool input). */
export const AGENT_CHAT_BODY_MAX_BYTES = 1024 * 1024
const UINT = /^\d+$/

export type Ctx = Pick<RouteCtx, 'req' | 'res' | 'url' | 'path' | 'method' | 'body'>
export type Fail = { status: number; error: string; reason: string }
export type Body = Record<string, unknown>

export const fail = (c: Ctx, f: Fail): true => { json(c.res, f.status, { error: f.error, reason: f.reason }); return true }
export const ok = (c: Ctx): true => { json(c.res, 200, { ok: true }); return true }
export const bad = (reason: string): Fail => ({ status: 400, error: 'bad_request', reason })

/** Non-negative integer query value; undefined = absent, null = invalid. */
export function uint(raw: string | null | undefined): number | undefined | null {
  if (raw === null || raw === undefined) return undefined
  return UINT.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null
}

/** JSON object body under the cap; anything else is a Fail. */
export async function readObject(c: Ctx, max = AGENT_CHAT_BODY_MAX_BYTES): Promise<{ body: Body } | { fail: Fail }> {
  let raw: string
  try {
    raw = await c.body(max)()
  } catch (err) {
    if (!(err instanceof BodyReadError)) throw err
    return { fail: err.reason === 'too_large'
      ? { status: 413, error: 'too_large', reason: `Request body is over ${max} bytes.` }
      : bad('Request body could not be read.') }
  }
  let v: unknown
  try {
    v = JSON.parse(raw || '{}')
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err
    return { fail: bad('Request body is not valid JSON.') }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? { body: v as Body } : { fail: bad('Request body must be a JSON object.') }
}
