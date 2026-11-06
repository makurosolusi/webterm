// Ordered route table for `api.ts`, after Hono/itty-router: entries are tried in array order and
// the first that answers wins. Domain files own their entries; `api.ts` only fixes the group order.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { cappedBodyGetter } from '../cappedRequestBody'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'

type Ledger = ReturnType<typeof activeLedgerRuntime>

/** Per-request view handed to every route entry. */
export interface RouteCtx {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  path: string
  method: string
  /** Lazy body reader capped at `max` bytes; read only for POST/PUT (see cappedBodyGetter). */
  body(max: number): () => Promise<string>
  /** Body read capped at ROUTE_BODY_MAX_BYTES; rejects with `BodyReadError` ('too_large' -> 413). */
  readBody(): Promise<string>
  /** Ledger handle, read once per request the first time a route asks for it. */
  ledger(): Ledger
  /** The whole router again (the `webterm` CLI tools route dispatches capability bindings through it). */
  dispatch(req: IncomingMessage, res: ServerResponse): Promise<void>
}

/** One entry: `match` (optional) is a cheap pre-check; `handle` returns true once it answered. */
export interface ApiRoute {
  name: string
  match?: (ctx: RouteCtx) => boolean
  handle: (ctx: RouteCtx) => boolean | Promise<boolean>
}

export function json(res: ServerResponse, status: number, body?: unknown): void {
  res.statusCode = status
  // No body at all when a route omits one (204): a JSON body on a 204 is a contract change.
  if (body === undefined) { res.end(); return }
  const data = JSON.stringify(body)
  res.setHeader('Content-Type', 'application/json')
  res.end(data)
}

/** `{status, body}` family result -> response; null/undefined = not this family, keep falling through. */
export function send(res: ServerResponse, result: { status: number; body?: unknown } | null | undefined): boolean {
  if (!result) return false
  json(res, result.status, result.body)
  return true
}

/** Cap of `ctx.readBody` (sec-208-4: it used to buffer any size). git-info, its only real reader,
 *  sends at most GIT_INFO_MAX_PATHS (64) paths; 64 x PATH_MAX (4096) plus JSON fits in 256 KiB. */
export const ROUTE_BODY_MAX_BYTES = 256 * 1024

/** Builds the per-request context; `dispatch` is the router itself. */
export function routeCtx(req: IncomingMessage, res: ServerResponse, dispatch: RouteCtx['dispatch']): RouteCtx {
  const url = new URL(req.url || '/', 'http://x')
  const method = req.method || 'GET'
  let ledger: Ledger | undefined
  const readBody = cappedBodyGetter(req, method, ROUTE_BODY_MAX_BYTES)
  return {
    req, res, url, path: url.pathname, method, dispatch,
    body: (max) => cappedBodyGetter(req, method, max),
    readBody,
    ledger: () => (ledger === undefined ? (ledger = activeLedgerRuntime()) : ledger),
  }
}
