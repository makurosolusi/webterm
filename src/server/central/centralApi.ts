// HTTP surface for the central thin layer (RND/03-RENCANA.md §7): parsed request in,
// `{ status, body }` out. The caller owns transport auth/mounting and supplies the
// authority guard; this module never reads tokens, spawns workers, or writes fact/CORE.
import {
  type CentralAction,
  type CentralActor,
  CentralError,
  assertHumanAuthority,
  centralEnabled,
  clampPriority,
} from './centralModel'
import { pauseProject, prioritize, projectPortfolio, resumeProject } from './central'
import { livePortfolio, portfolioCounts } from './workspaceLookup'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { WorldCounts } from '../worldView'
import { boundedInteger } from '../apiShared.params'
import { LEDGER_OFF, type RouteResult } from '../apiShared.types'

export interface CentralRouteDeps {
  runtime: LedgerRuntime | null
  /** Defaults to the `central` capability; tests may pin it explicitly. */
  enabled?: boolean
  /** Caller-owned authorization; null/undefined (or a throw) denies. */
  authorize?: (action: CentralAction, projectId: string) => CentralActor | null | undefined
  /** World-view counts for the portfolio; default `portfolioCounts` (null = omitted). */
  counts?: (ledgerPath: string) => WorldCounts | null
}

const PORTFOLIO_PATH = '/api/central/portfolio'
const PROJECT_PREFIX = '/api/central/projects/'
const MAX_LIMIT = 200
const MAX_OFFSET = 1_000_000

function decodeProjectId(raw: string): string | null {
  try {
    const id = decodeURIComponent(raw)
    return id.trim() === '' ? null : id
  } catch {
    return null
  }
}

type Parsed =
  | { kind: 'portfolio' }
  | { kind: 'project'; projectId: string }
  | { kind: 'mutation'; projectId: string; action: CentralAction }
  | null

/** Exact path shapes only; anything else under /api/central belongs to another route. */
function parsePath(path: string): Parsed {
  if (path === PORTFOLIO_PATH) return { kind: 'portfolio' }
  if (!path.startsWith(PROJECT_PREFIX)) return null
  const rest = path.slice(PROJECT_PREFIX.length).split('/')
  const projectId = decodeProjectId(rest[0] ?? '')
  if (projectId === null) return null
  if (rest.length === 1) return { kind: 'project', projectId }
  if (rest.length === 2 && ['pause', 'resume', 'priority'].includes(rest[1] ?? '')) {
    return { kind: 'mutation', projectId, action: rest[1] as CentralAction }
  }
  return null
}
function failure(err: unknown): RouteResult {
  if (!(err instanceof CentralError)) return { status: 500, body: { error: 'central_internal' } }
  if (err.code === 'project_not_found') return { status: 404, body: { error: err.code } }
  if (err.code === 'forbidden' || err.code === 'invalid_actor') {
    return { status: 403, body: { error: 'central_forbidden' } }
  }
  return { status: 400, body: { error: err.code } }
}
/** Runs the caller guard, then re-asserts human/root: the guard cannot widen authority. */
function authorize(deps: CentralRouteDeps, action: CentralAction, projectId: string): CentralActor {
  const denied = new CentralError('forbidden', 'central authority guard denied the action')
  if (!deps.authorize) throw denied
  let actor: CentralActor | null | undefined
  try {
    actor = deps.authorize(action, projectId)
  } catch {
    // A throwing guard is a denial at this boundary; the guard owns its own logging.
    throw denied
  }
  if (!actor) throw denied
  return assertHumanAuthority(actor)
}

function mutationRoute(
  action: CentralAction,
  projectId: string,
  body: unknown,
  runtime: LedgerRuntime,
  deps: CentralRouteDeps
): RouteResult {
  try {
    const actor = authorize(deps, action, projectId)
    if (action === 'pause') return { status: 200, body: pauseProject(runtime.db, actor, projectId) }
    if (action === 'resume') return { status: 200, body: resumeProject(runtime.db, actor, projectId) }
    const raw =
      typeof body === 'object' && body !== null ? (body as { priority?: unknown }).priority : undefined
    return { status: 200, body: prioritize(runtime.db, actor, projectId, clampPriority(raw)) }
  } catch (err) {
    return failure(err)
  }
}

/** `null` = not a central path. Recognized paths answer 503 while flag/ledger is off. */
export function centralRoute(
  path: string,
  method: string,
  params: URLSearchParams,
  body: unknown,
  deps: CentralRouteDeps
): RouteResult | null {
  const parsed = parsePath(path)
  if (!parsed) return null
  if (!(deps.enabled ?? centralEnabled())) return { status: 503, body: { error: 'central_off' } }
  const runtime = deps.runtime
  if (!runtime) return LEDGER_OFF
  if (parsed.kind === 'portfolio') {
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
    const limit = boundedInteger(params.get('limit'), 1, MAX_LIMIT)
    if (limit === null) return { status: 400, body: { error: 'invalid_limit' } }
    const offset = boundedInteger(params.get('offset'), 0, MAX_OFFSET)
    if (offset === null) return { status: 400, body: { error: 'invalid_offset' } }
    try {
      const page = livePortfolio(runtime.db, { // every canvas workspace, deleted ones hidden (syncs first)
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
      })
      const counts = (deps.counts ?? portfolioCounts)(runtime.path)
      return { status: 200, body: counts ? { ...page, counts } : page }
    } catch (err) {
      return failure(err)
    }
  }
  if (parsed.kind === 'project') {
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
    try {
      const entry = projectPortfolio(runtime.db, parsed.projectId)
      return entry ? { status: 200, body: entry } : { status: 404, body: { error: 'project_not_found' } }
    } catch (err) {
      return failure(err)
    }
  }
  if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  return mutationRoute(parsed.action, parsed.projectId, body, runtime, deps)
}
