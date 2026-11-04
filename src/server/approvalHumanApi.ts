// HTTP seam for the human approval surface. Unlike /api/control/approval/*, this route is
// authorized by the transport gate plus the UI-only policy in `approvalAuth.ts`: never by an agent
// capability or node token, and only from the webterm page itself. An agent must not approve its own
// irreversible action.
//
// Handlers live in `approvalHumanRoutes.ts`, the read-only SQL in `approvalQuery.ts`, the failure
// taxonomy in `approvalFailures.ts`, and the byte-capped body reader in `approvalHttp.ts`.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { uiOnlyDenial } from './approvalAuth'
import { APPROVAL_MAX_BODY_BYTES, readCappedBody, sendJson } from './approvalHttp'
import { actorForRequest } from './approvalHumanShared'
import { LEDGER_OFF } from './apiShared.types'
import {
  challengeRoute,
  consumeRoute,
  decideRoute,
  listRoute,
  requestRoute,
} from './approvalHumanRoutes'
import { asObject } from './control/controlTypes'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { activeLedgerRuntime } from './ledger/ledgerRuntimeState'
import { isValidNodeToken } from './hooksTokens'
import { decidePermission, listPendingPermissions } from './permission/permission.human'
import { activePolicy } from './policy/policy.runtime'

/** Derived audit actor for a human request; implementation lives with the handler constants. */
export { actorForRequest } from './approvalHumanShared'

export interface HumanApprovalDeps {
  /** Test seam; production uses the process runtime. */
  runtime?: LedgerRuntime | null
  now?: () => number
  /** Test seam; production asks the live node-token table. */
  isNodeToken?: (token: string) => boolean
}

/** Exact family match: `/api/approvalsXYZ` is NOT ours and must fall through to 404. */
const isApprovalPath = (pathname: string): boolean =>
  pathname === '/api/approvals' || pathname.startsWith('/api/approvals/')

const POST_ROUTES = ['request', 'decide', 'consume', 'permission'] as const
const MAX_TASK_REF = 200

const isTaskKind = (kind: unknown): boolean =>
  typeof kind === 'string' && (kind === 'task' || kind.startsWith('task.'))

/** Non-empty bounded string, matching the handler's `boundedText` task id rule. */
const isTaskRef = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TASK_REF

const isFence = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * A task-flavoured approval without a resolvable task+fence is consent that can never transition
 * the task (consume has no fence to verify against), so it must be rejected before any row exists.
 * `requestRoute` gives top-level `taskId`/`fence` precedence and folds them into the payload, so
 * both spellings satisfy the guard.
 */
function missingTaskRef(body: Record<string, unknown>): boolean {
  if (!isTaskKind(body.kind)) return false
  const payload =
    typeof body.request === 'object' && body.request !== null && !Array.isArray(body.request)
      ? (body.request as Record<string, unknown>)
      : undefined
  const taskId = body.taskId !== undefined ? body.taskId : payload?.taskId
  const fence = body.fence !== undefined ? body.fence : payload?.fence
  return !isTaskRef(taskId) || !isFence(fence)
}

/** `null` = not an approval path; `'method_not_allowed'` = known path, wrong verb. */
function routeOf(pathname: string, method: string): string | null {
  if (method === 'GET') {
    if (pathname === '/api/approvals') return 'list'
    if (pathname === '/api/approvals/challenge') return 'challenge'
    if (pathname === '/api/approvals/permission') return 'permission_list'
    return null
  }
  const name = pathname.startsWith('/api/approvals/')
    ? pathname.slice('/api/approvals/'.length)
    : undefined
  const known = name !== undefined && (POST_ROUTES as readonly string[]).includes(name)
  if (!known) return null
  return method === 'POST' ? name : 'method_not_allowed'
}

/** Returns true when it handled the request; false lets api.ts continue to 404. */
export async function approvalHumanRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: HumanApprovalDeps = {}
): Promise<boolean> {
  if (!isApprovalPath(url.pathname)) return false
  // Agent credentials are refused and only the webterm page may consent; zero-config on loopback.
  const denial = uiOnlyDenial(req, url, deps.isNodeToken ?? isValidNodeToken)
  if (denial) {
    sendJson(res, 403, { error: denial })
    return true
  }
  const runtime = deps.runtime === undefined ? activeLedgerRuntime() : deps.runtime
  if (!runtime) {
    sendJson(res, LEDGER_OFF.status, LEDGER_OFF.body)
    return true
  }
  const now = (deps.now ?? Date.now)()
  const method = (req.method || 'GET').toUpperCase()
  const route = routeOf(url.pathname, method)
  if (route === null) {
    sendJson(res, 404, { error: 'not_found' })
    return true
  }
  if (route === 'method_not_allowed') {
    sendJson(res, 405, { error: 'method_not_allowed' })
    return true
  }
  if (route === 'permission_list') {
    sendJson(res, 200, { items: listPendingPermissions(runtime.db, now) })
    return true
  }
  if (method === 'GET') {
    const result = route === 'list' ? listRoute(runtime, url, now) : challengeRoute(runtime, url, now)
    sendJson(res, result.status, result.body)
    return true
  }
  const read = await readCappedBody(req, APPROVAL_MAX_BODY_BYTES)
  if (!read.ok) {
    sendJson(
      res,
      read.status,
      read.status === 413
        ? { error: read.error, max: APPROVAL_MAX_BODY_BYTES }
        : { error: read.error }
    )
    return true
  }
  let body: Record<string, unknown>
  try {
    body = asObject(JSON.parse(read.raw) as unknown)
  } catch {
    sendJson(res, 400, { error: 'invalid_json' })
    return true
  }
  if (route === 'request' && missingTaskRef(body)) {
    sendJson(res, 400, { error: 'invalid_task_ref' })
    return true
  }
  if (route === 'permission') {
    const result = decidePermission(runtime.db, activePolicy(), body, actorForRequest(req, url), now)
    sendJson(res, result.status, result.body)
    return true
  }
  const handler = route === 'request' ? requestRoute : route === 'decide' ? decideRoute : consumeRoute
  const result = handler(runtime, body, now, actorForRequest(req, url))
  sendJson(res, result.status, result.body)
  return true
}
