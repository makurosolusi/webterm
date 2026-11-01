// HTTP adapter for the central thin layer. This module owns transport concerns only:
// JSON already parsed by the caller, fixed human/root authority (the transport is root-only),
// and a narrow dependency shape. Business rules stay in `./central/centralApi` +
// `./central/central`.
//
// Read-only GET portfolio/project, and POST pause/resume/priority. No body is ever logged,
// and responses are projections/one-line mutations, never file contents or tokens.
import { centralRoute, type CentralRouteDeps, type RouteResult } from './central/centralApi'
import type { CentralActor } from './central/centralModel'
import type { LedgerRuntime } from './ledger/ledgerRuntime'

export type { RouteResult } from './central/centralApi'

export const CENTRAL_PREFIX = '/api/central/'
export const CENTRAL_PORTFOLIO_PATH = '/api/central/portfolio'

/** The HTTP transport is already root-only, so the in-process guard is a fixed human/root. */
export const CENTRAL_HTTP_ACTOR: CentralActor = { kind: 'human', id: 'root' }

export interface CentralHttpDeps {
  runtime: LedgerRuntime | null
  /** Defaults to the `WEBTERM_CENTRAL` flag; tests may pin it. */
  enabled?: boolean
}

/** True for exact central families only; `/api/central` itself is not one. */
export function isCentralPath(path: string): boolean {
  return path === CENTRAL_PORTFOLIO_PATH || path.startsWith(`${CENTRAL_PREFIX}projects/`)
}

/** Fixed, never derived from headers/body: a caller cannot widen its own authority. */
const authorize = (): CentralActor => CENTRAL_HTTP_ACTOR

/** `null` = not a route this module owns (keep falling through). */
export function centralHttpRoute(
  path: string,
  method: string,
  params: URLSearchParams,
  body: unknown,
  deps: CentralHttpDeps
): RouteResult | null {
  if (!isCentralPath(path)) return null
  const routeDeps: CentralRouteDeps = {
    runtime: deps.runtime,
    authorize,
    ...(deps.enabled === undefined ? {} : { enabled: deps.enabled }),
  }
  return centralRoute(path, method, params, body, routeDeps)
}
