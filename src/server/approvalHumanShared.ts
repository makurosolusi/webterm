// Shared constants, body coercers, and replay-store selection for the human approval handlers.
// Split out of `approvalHumanRoutes.ts` so each handler module stays inside the file budget.
import type { IncomingMessage } from 'node:http'
import type { ApprovalAcks } from './control/approvalApi'
import { AckStore } from './control/controlTypes'
import { TOKEN_HEADER, TOKEN_PARAM } from './auth'
import { durableAckFor } from './ledger/durableAck'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { firstHeader } from './httpHeaders'
export { MAX_PROJECT_ID } from './apiShared.types'

/**
 * Default actor for direct handler calls (tests, in-process callers) and the historical value
 * before the HTTP seam derived one from the transport credential.
 */
export const HUMAN_ACTOR = 'human'
/** Derived actor when the caller proved possession of the transport root token. */
export const ROOT_ACTOR = 'human:root'
/** Derived actor when no root token is enforced and the webterm page approved on loopback. */
export const LOOPBACK_ACTOR = 'human:loopback'
export const MAX_KIND = 128
export const MAX_SECRET = 256

/**
 * Audit identity derived from the transport credential, never from the body. `?token=` and
 * `x-webterm-token` are the only credentials this family accepts (the outer gate in `auth.ts` has
 * compared them), so either present means the root-token path; no token means the token-free loopback UI.
 */
export function actorForRequest(req: IncomingMessage, url: URL): string {
  const raw = req.headers[TOKEN_HEADER]
  const header = firstHeader(raw)?.trim()
  const query = url.searchParams.get(TOKEN_PARAM)?.trim()
  return header || query ? ROOT_ACTOR : LOOPBACK_ACTOR
}

export type Result = { status: number; body?: unknown }

/**
 * The durable journal is preferred so a retried requestId replays the original response even after
 * a restart. Fakes without a SQLite `query` fall back to one in-memory store per runtime object
 * (never a per-request literal, which is how the control plane's replay window once vanished).
 */
const ackStores = new WeakMap<object, AckStore>()
export function storeFor(runtime: LedgerRuntime): ApprovalAcks {
  // A real ledger db persists the window across restarts; fakes without `query` keep the
  // per-runtime in-memory store so node-env tests need no schema.
  const durable = durableAckFor(runtime.db, 'human')
  if (durable) return durable
  let store = ackStores.get(runtime)
  if (!store) ackStores.set(runtime, (store = new AckStore()))
  return store
}

export const secret = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_SECRET ? value : undefined

/** Parses `limit`/`offset`; `null` = invalid, `undefined` = absent. */
export function paging(raw: string | null, min: number, max: number): number | undefined | null {
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}
