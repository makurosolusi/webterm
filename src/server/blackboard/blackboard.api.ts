// `/api/blackboard[...]`: the shared blackboard (blackboard.store.ts). Readers: the webterm UI and any agent
// node proven by its node token. Writers: the UI as the human principal; a node as itself (its own
// `agent:<id>/...` keys land directly, other keys become proposals). Confirm/reject is UI-only.
//   GET  ?                         {entries, proposals}
//   GET  /history?key=<key>        {history}
//   POST {key, value}              {entry, proposed, unchanged}
//   POST /proposals/:id/confirm    POST /proposals/:id/reject      (UI only)
import type { IncomingMessage } from 'node:http'
import type { Database } from 'bun:sqlite'
import { uiOnlyDenial } from '../approvalAuth'
import { MemoryAuthorityError, MemoryRejectedError } from '../memory/memoryModel'
import {
  type BlackboardPrincipal, blackboardHistory, confirmProposal, listBlackboard, listProposals, rejectProposal, writeBlackboard,
} from './blackboard.store'

export const BLACKBOARD_PATH = '/api/blackboard'
const HUMAN: BlackboardPrincipal = { kind: 'human', id: 'human-ui' }

export const isBlackboardPath = (p: string): boolean => p === BLACKBOARD_PATH || p.startsWith(`${BLACKBOARD_PATH}/`)

export interface BlackboardDeps {
  db: Database
  isNodeToken: (token: string) => boolean
  /** Node proven by the request's node token (agentStatusAuth.requesterNodeId); undefined = not an agent. */
  nodeOf: (req: IncomingMessage) => string | undefined
  now: () => number
}

type Result = { status: number; body: unknown }
const field = (body: unknown, name: string): unknown => (body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined)

/** The caller as a blackboard principal, or null when it is neither the UI nor a proven node. */
function principalOf(req: IncomingMessage, url: URL, deps: BlackboardDeps): BlackboardPrincipal | null {
  const nodeId = deps.nodeOf(req)
  if (nodeId !== undefined) return { kind: 'agent', nodeId }
  return uiOnlyDenial(req, url, deps.isNodeToken) === null ? HUMAN : null
}

function dispatch(method: string, url: URL, body: unknown, who: BlackboardPrincipal, deps: BlackboardDeps): Result {
  const { db } = deps
  const rest = url.pathname.slice(BLACKBOARD_PATH.length).split('/').filter(Boolean)
  if (rest.length === 0 && method === 'GET') return { status: 200, body: { entries: listBlackboard(db), proposals: listProposals(db) } }
  if (rest.length === 0 && method === 'POST') return { status: 200, body: writeBlackboard(db, who, field(body, 'key'), field(body, 'value'), deps.now()) }
  if (rest[0] === 'history' && rest.length === 1 && method === 'GET') return { status: 200, body: { history: blackboardHistory(db, url.searchParams.get('key')) } }
  if (rest[0] === 'proposals' && rest.length === 3 && method === 'POST') {
    const id = decodeURIComponent(rest[1] ?? '')
    if (rest[2] === 'confirm') return { status: 200, body: { entry: confirmProposal(db, who, id, deps.now()) } }
    if (rest[2] === 'reject') return { status: 200, body: { entry: rejectProposal(db, who, id, deps.now()) } }
  }
  return { status: 405, body: { error: 'method_not_allowed' } }
}

/** Handles `/api/blackboard*`; null when `url` is not ours. Errors map to stable codes, never raw messages. */
export function handleBlackboardApi(req: IncomingMessage, url: URL, body: unknown, deps: BlackboardDeps): Result | null {
  if (!isBlackboardPath(url.pathname)) return null
  const who = principalOf(req, url, deps)
  if (who === null) return { status: 403, body: { error: 'forbidden' } }
  try {
    return dispatch(req.method ?? 'GET', url, body, who, deps)
  } catch (err) {
    if (err instanceof MemoryRejectedError) return { status: err.code === 'not_found' ? 404 : 400, body: { error: err.code } }
    if (err instanceof MemoryAuthorityError) return { status: 403, body: { error: 'forbidden' } }
    if (err instanceof URIError) return { status: 400, body: { error: 'invalid_id' } }
    throw err
  }
}
