// "No hidden magic" routes of the Central panel: the working state, the human memory controls, how full a
// conversation's context is and what one turn was given. Not a node-token path (auth.ts `isNodeTokenPath`), so
// the outer gate admits only the page and the root token. Lock: routes/route.uiOnly.policy.bun.test.ts.
import { HUMAN_UI } from '../awareness/proceduralMemory'
import type { RouteResult } from '../apiShared.types'
import { dataDir } from '../config'
import { allRows, getRow } from '../ledger/ledgerCore'
import { CONSOLIDATOR_SOURCE, confirmConsolidatorProposal } from '../memory/consolidator/consolidator.store'
import { confirmClaim, forgetMemory } from '../memory/memoryControls'
import { createMemoryFilePort } from '../memory/memoryFilePath'
import { MemoryAuthorityError, type MemoryAuthority, MemoryRejectedError } from '../memory/memoryModel'
import { createUserMemoryStore, userMemoryRoot } from '../memory/memoryUserStore'
import { redactSecrets } from '../redactSecrets'
import type { Ca2Handle } from './ca2Boot'
import { HUMAN_PREFIX } from './ca2Routes.act'
import { CentralStateError, GLOBAL_STATE, type StateDoc, type StateErrorCode, projectState, readState, writeState } from './context/centralState'
import { lastCtxTokens } from './context/contextUsage'
import { contextWindowTokens } from './context/rotationPolicy'

const STATE = '/api/central/state'
const CONTEXT = '/api/central/context'
const MEMORY_ACTION = /^\/api\/central\/memory\/([^/]+)\/(confirm|forget)$/
const TURN_CONTEXT = /^\/api\/central\/turns\/([^/]+)\/context$/
const HUMAN: MemoryAuthority = { kind: 'human', id: HUMAN_UI }
const PERCENT = 100
const SUMMARY_MAX = 8000
const TITLE_MAX = 400
/** Above any header's memory block; only bounds a corrupt record. */
const MEMORY_IDS_MAX = 200

type Body = Record<string, unknown>
const fail = (status: number, error: string): RouteResult => ({ status, body: { error } })
const ok = (body: unknown): RouteResult => ({ status: 200, body })
const notAllowed = fail(405, 'method_not_allowed')
const isRecord = (v: unknown): v is Body => v !== null && typeof v === 'object' && !Array.isArray(v)
const decode = (s: string): string | null => { try { return decodeURIComponent(s) } catch { return null } }
const parseRecord = (json: unknown): Body | null => {
  if (typeof json !== 'string') return null
  const parsed: unknown = JSON.parse(json)
  return isRecord(parsed) ? parsed : null
}
const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Whether `path` is one of these routes; `GET /memory` itself stays in the panel's read table. */
export const isMemoryPath = (path: string): boolean => path === STATE || path === CONTEXT || MEMORY_ACTION.test(path) || TURN_CONTEXT.test(path)

const STATE_STATUS: Record<StateErrorCode, number> = { version_conflict: 409, project_not_found: 404, state_too_large: 400 }
const docOf = (doc: StateDoc | null) => (doc ? { body: redactSecrets(doc.body), version: doc.version, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy } : null)

function stateView(h: Ca2Handle, q: URLSearchParams): RouteResult {
  const projectId = q.get('projectId')?.trim()
  return ok({ global: docOf(readState(h.db, GLOBAL_STATE)), project: projectId ? docOf(readState(h.db, projectState(projectId))) : null })
}

function saveState(h: Ca2Handle, raw: unknown, actor: string): RouteResult {
  const body = isRecord(raw) ? raw : {}
  const { projectId, expectedVersion } = body
  if (projectId !== null && (typeof projectId !== 'string' || projectId === '')) return fail(400, 'invalid_project')
  if (typeof body.body !== 'string') return fail(400, 'invalid_body')
  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 0) return fail(400, 'invalid_version')
  try {
    return ok({ version: writeState(h.db, { scope: projectId === null ? GLOBAL_STATE : projectState(projectId), body: body.body, expectedVersion, actor, now: h.now() }).version })
  } catch (err) {
    if (err instanceof CentralStateError) return fail(STATE_STATUS[err.code], err.code)
    throw err
  }
}

function confirm(h: Ca2Handle, id: string): RouteResult {
  const row = getRow(h.db, 'SELECT scope, source_kind FROM memory WHERE id = ?', id)
  if (row?.scope === 'central' && row.source_kind === CONSOLIDATOR_SOURCE) confirmConsolidatorProposal(h.db, HUMAN, id, h.now())
  else confirmClaim(h.db, HUMAN, id, h.now())
  return ok({ ok: true })
}

async function forget(h: Ca2Handle, id: string): Promise<RouteResult> {
  // Idempotent (it is the Undo of automatic memory writes): a row already forgotten answers ok again.
  if (String(getRow(h.db, 'SELECT key FROM memory WHERE id = ?', id)?.['key'] ?? '').startsWith('forgotten:')) return ok({ ok: true })
  const { scope, key } = forgetMemory(h.db, HUMAN, id, h.now())
  if (scope === 'user') await createUserMemoryStore(createMemoryFilePort(userMemoryRoot(h.env, dataDir()))).remove(key)
  return ok({ ok: true })
}

async function memoryAction(h: Ca2Handle, id: string, action: string): Promise<RouteResult> {
  try {
    return action === 'confirm' ? confirm(h, id) : await forget(h, id)
  } catch (err) {
    if (err instanceof MemoryRejectedError) return { status: err.code === 'not_found' ? 404 : 400, body: { error: err.code, message: err.message } }
    if (err instanceof MemoryAuthorityError) return fail(403, 'forbidden')
    throw err
  }
}

function lastCompaction(h: Ca2Handle, conversationId: string) {
  const row = getRow(h.db, "SELECT ts, payload_json FROM event WHERE correlation_id = ? AND kind = 'central.compact' ORDER BY seq DESC LIMIT 1", conversationId)
  if (row === null) return null
  const payload = parseRecord(row.payload_json) ?? {}
  return {
    at: Number(row.ts), trigger: String(payload.trigger ?? ''), preTokens: numberOrNull(payload.preTokens) ?? 0,
    summary: typeof payload.summary === 'string' && payload.summary !== '' ? redactSecrets(payload.summary).slice(0, SUMMARY_MAX) : null,
  }
}

function contextView(h: Ca2Handle, q: URLSearchParams): RouteResult {
  const conversationId = q.get('conversationId')?.trim()
  if (!conversationId) return fail(400, 'invalid_conversation')
  const tokens = lastCtxTokens(h.db, conversationId)
  const window = contextWindowTokens(h.env)
  return ok({ tokens, window, percent: tokens === null ? null : Math.round((tokens / window) * PERCENT), lastCompaction: lastCompaction(h, conversationId) })
}

function turnContext(h: Ca2Handle, id: string): RouteResult {
  const turn = getRow(h.db, 'SELECT context_json FROM central_turn WHERE id = ?', id)
  if (turn === null) return fail(404, 'turn_not_found')
  const record = parseRecord(turn.context_json)
  if (record === null) return ok({ memory: [], checkpointId: null, headerChars: null, stateVersions: null })
  const ids = (Array.isArray(record.memoryIds) ? record.memoryIds : []).filter((m): m is string => typeof m === 'string').slice(0, MEMORY_IDS_MAX)
  const found = ids.length === 0 ? [] : allRows(h.db, `SELECT id, title, trust, status FROM memory WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
  const byId = new Map(found.map((r) => [String(r.id), r]))
  const versions = record.stateVersions
  return ok({
    memory: ids.flatMap((m) => {
      const r = byId.get(m)
      return r ? [{ id: m, title: redactSecrets(String(r.title)).slice(0, TITLE_MAX), trust: String(r.trust), status: String(r.status) }] : []
    }),
    checkpointId: typeof record.checkpointId === 'string' ? record.checkpointId : null,
    headerChars: numberOrNull(record.headerChars),
    stateVersions: isRecord(versions) ? { global: numberOrNull(versions.global), project: numberOrNull(versions.project) } : null,
  })
}

/** Answers a path `isMemoryPath` accepted; every write needs a `human:*` actor. */
export async function memoryDispatch(
  h: Ca2Handle, req: { method: string; path: string; query: URLSearchParams; body: () => Promise<unknown> }, actor: string,
): Promise<RouteResult> {
  const { method, path, query } = req
  if (method === 'POST' && (path === STATE || MEMORY_ACTION.test(path)) && !actor.startsWith(HUMAN_PREFIX)) return fail(403, 'human_only')
  if (path === STATE) {
    if (method === 'GET') return stateView(h, query)
    return method === 'POST' ? saveState(h, await req.body(), actor) : notAllowed
  }
  if (path === CONTEXT) return method === 'GET' ? contextView(h, query) : notAllowed
  const action = MEMORY_ACTION.exec(path)
  const id = decode((action ?? TURN_CONTEXT.exec(path))?.[1] ?? '')
  if (action && method !== 'POST') return notAllowed
  if (!action && method !== 'GET') return notAllowed
  if (id === null) return fail(400, 'invalid_id')
  return action ? memoryAction(h, id, action[2] as string) : turnContext(h, id)
}
