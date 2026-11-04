// HTTP binding of the outbox, same `(path, method, ...) => {status, body} | null` contract as
// gitDiff.route.ts (null = not this route). Root token only (not in `isNodeTokenPath`): Diff notes,
// Central and the Inbox enqueue as the human UI.
//
//   POST /api/outbox {to, body, operationId, kind?, priority?}  202 queued | 200 deduped (same operationId)
//   GET  /api/outbox?node=<id>[&limit=&offset=]                 messages with status, newest first
import { isSafeNodeId } from '../../shared/workspace'
import type { OutboxDelivery } from './outboxDelivery'
import { OUTBOX_LIST_MAX } from './outboxStore'
import { OUTBOX_PATH } from './outbox.types'

export const OUTBOX_BODY_MAX_CHARS = 32 * 1024
const OP_RE = /^[\w.:-]{1,200}$/
const PRIORITY_MAX = 100

type Result = { status: number; body: unknown } | null
const bad = (message: string): Result => ({ status: 400, body: { error: 'bad_request', message } })

function intParam(v: string | null, dflt: number, max: number): number | null {
  if (v === null || v === '') return dflt
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null
}

export async function outboxRoute(
  path: string, method: string, query: URLSearchParams, body: () => Promise<string>,
  outbox: () => Promise<OutboxDelivery> = async () => (await import('./outboxRuntime')).startOutbox(),
): Promise<Result> {
  if (path !== OUTBOX_PATH) return null
  if (method === 'GET') {
    const node = query.get('node')
    if (!isSafeNodeId(node)) return bad('node is required')
    const limit = intParam(query.get('limit'), 50, OUTBOX_LIST_MAX)
    const offset = intParam(query.get('offset'), 0, Number.MAX_SAFE_INTEGER)
    if (!limit || offset === null) return bad(`1 <= limit <= ${OUTBOX_LIST_MAX}, offset >= 0`)
    return { status: 200, body: { messages: (await outbox()).list(node, limit, offset) } }
  }
  if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  let req: { to?: unknown; body?: unknown; operationId?: unknown; kind?: unknown; priority?: unknown }
  try { req = JSON.parse(await body()) } catch { return bad('bad json') }
  if (!req || typeof req !== 'object') return bad('bad json')
  const kind = req.kind ?? 'visible'
  const priority = req.priority ?? 0
  if (!isSafeNodeId(req.to)) return bad('to must be a node id')
  if (typeof req.body !== 'string' || !req.body.trim() || req.body.length > OUTBOX_BODY_MAX_CHARS) return bad(`body: 1..${OUTBOX_BODY_MAX_CHARS} chars`)
  if (typeof req.operationId !== 'string' || !OP_RE.test(req.operationId)) return bad('operationId: 1..200 of [A-Za-z0-9_.:-]')
  if (kind !== 'visible' && kind !== 'context') return bad("kind: 'visible' | 'context'")
  if (typeof priority !== 'number' || !Number.isInteger(priority) || Math.abs(priority) > PRIORITY_MAX) return bad(`priority: integer in -${PRIORITY_MAX}..${PRIORITY_MAX}`)
  const ob = await outbox()
  const refusal = ob.refusal(req.to)
  if (refusal) return { status: 404, body: { error: 'bad_target', message: refusal } }
  const res = ob.enqueue({ to: req.to, body: req.body, operationId: req.operationId, kind, priority, createdBy: 'human-ui' })
  return { status: res.deduped ? 200 : 202, body: res }
}
