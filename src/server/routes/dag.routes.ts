// Task DAG (F4-b): `/api/dag*`. Reads are open behind the transport gate, writes are UI-only (dag.api.ts).
import { LEDGER_OFF } from '../apiShared.types'
import { BodyReadError } from '../cappedRequestBody'
import { DAG_BODY_MAX_BYTES, DAG_PATH, handleDagApi } from '../dag/dag.api'
import { armDagLoop, dagScheduler } from '../dag/dag.runtime'
import { recordEvent } from '../events/producers'
import { isValidNodeToken } from '../hooksTokens'
import { json, send, type ApiRoute } from './route.core'

async function parseBody(read: () => Promise<string>): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  let raw: string
  try {
    raw = await read()
  } catch (err) {
    if (err instanceof BodyReadError) return { ok: false, status: err.reason === 'too_large' ? 413 : 400, error: err.reason }
    throw err
  }
  try {
    const parsed: unknown = raw === '' ? {} : JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, body: parsed as Record<string, unknown> }
  } catch { /* falls through to the 400 below: a bad body is the caller's mistake, not ours */ }
  return { ok: false, status: 400, error: 'invalid_json' }
}

export const dagRoutes: ApiRoute[] = [
  {
    name: 'dag',
    match: (c) => c.path === DAG_PATH || c.path.startsWith(`${DAG_PATH}/`),
    handle: async (c) => {
      const ledger = c.ledger()
      const scheduler = dagScheduler()
      if (!ledger || !scheduler) return send(c.res, LEDGER_OFF)
      const read = c.method === 'POST' ? await parseBody(c.body(DAG_BODY_MAX_BYTES)) : { ok: true as const, body: {} }
      if (!read.ok) { json(c.res, read.status, { error: read.error }); return true }
      const deps = { ctx: { db: ledger.db, now: Date.now }, scheduler, isNodeToken: isValidNodeToken, record: recordEvent, arm: armDagLoop }
      return send(c.res, await handleDagApi(deps, c.req, c.url, read.body))
    },
  },
]
