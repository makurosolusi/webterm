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
  /** Uncapped body read (routes that never had a cap keep none). */
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Builds the per-request context; `dispatch` is the router itself. */
export function routeCtx(req: IncomingMessage, res: ServerResponse, dispatch: RouteCtx['dispatch']): RouteCtx {
  const url = new URL(req.url || '/', 'http://x')
  const method = req.method || 'GET'
  let ledger: Ledger | undefined
  return {
    req, res, url, path: url.pathname, method, dispatch,
    body: (max) => cappedBodyGetter(req, method, max),
    readBody: () => readBody(req),
    ledger: () => (ledger === undefined ? (ledger = activeLedgerRuntime()) : ledger),
  }
}
