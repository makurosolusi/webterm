// `/api/memory2[...]`: the memory panel (Settings › Control "What agents remember"). UI-only, the same gate
// as `/api/awareness/procedural` (approvalAuth.uiOnlyDenial): an agent credential is refused before any
// memory code runs, and only a same-origin webterm page acts, as the human principal `human-ui`.
//   GET  ?kind=semantic|episodic|procedural   list         GET/PUT /incognito {nodeId, on}  incognito sessions
//   POST /:id/forget   POST /:id/suppress {on}   POST /:id/edit {text}   POST /:id/verify
import type { IncomingMessage } from 'node:http'
import type { Database } from 'bun:sqlite'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import {
  editMemory, forgetMemory, listIncognito, listMemoryItems, nodeRef, setIncognito, suppressMemory, verifyMemory,
} from './memoryControls'
import { COGNITIVE_KINDS, type CognitiveKind, MemoryAuthorityError, type MemoryAuthority, MemoryRejectedError } from './memoryModel'

export const MEMORY_CONTROLS_PATH = '/api/memory2'
const INCOGNITO = 'incognito'
const HUMAN: MemoryAuthority = { kind: 'human', id: 'human-ui' }

export const isMemoryControlsPath = (p: string): boolean => p === MEMORY_CONTROLS_PATH || p.startsWith(`${MEMORY_CONTROLS_PATH}/`)

export interface MemoryControlsDeps {
  db: Database
  isNodeToken: (token: string) => boolean
  now: () => number
  /** Removes the Markdown file of a forgotten `user` memory (memoryUserStore); absent = SQLite only. */
  removeUserFile?: (key: string) => Promise<void>
}

type Result = { status: number; body: unknown }
const field = (body: unknown, name: string): unknown => (body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined)

async function dispatch(method: string, url: URL, body: unknown, deps: MemoryControlsDeps): Promise<Result> {
  const { db } = deps
  const now = deps.now()
  const [rawId = '', action = ''] = url.pathname.slice(MEMORY_CONTROLS_PATH.length + 1).split('/')
  const id = decodeURIComponent(rawId)
  if (!id && method === 'GET') {
    const kind = url.searchParams.get('kind')
    if (kind !== null && !COGNITIVE_KINDS.includes(kind as CognitiveKind)) return { status: 400, body: { error: 'invalid_kind' } }
    return { status: 200, body: { items: listMemoryItems(db, now, kind === null ? undefined : (kind as CognitiveKind)) } }
  }
  if (id === INCOGNITO && !action) {
    if (method === 'GET') return { status: 200, body: { refs: listIncognito(db) } }
    if (method === 'PUT') {
      const nodeId = field(body, 'nodeId')
      const on = field(body, 'on')
      if (typeof nodeId !== 'string' || typeof on !== 'boolean') return { status: 400, body: { error: 'invalid_shape' } }
      return { status: 200, body: { refs: setIncognito(db, HUMAN, nodeRef(nodeId), on, now) } }
    }
  }
  if (id && method === 'POST') {
    if (action === 'forget') {
      const { scope, key } = forgetMemory(db, HUMAN, id, now)
      if (scope === 'user') await deps.removeUserFile?.(key)
      return { status: 200, body: { ok: true } }
    }
    if (action === 'suppress') {
      const on = field(body, 'on')
      if (typeof on !== 'boolean') return { status: 400, body: { error: 'invalid_shape' } }
      return { status: 200, body: { item: suppressMemory(db, HUMAN, id, on, now) } }
    }
    if (action === 'edit') return { status: 200, body: { item: editMemory(db, HUMAN, id, field(body, 'text'), now) } }
    if (action === 'verify') return { status: 200, body: { item: verifyMemory(db, HUMAN, id, now) } }
  }
  return { status: 405, body: { error: 'method_not_allowed' } }
}

/** Handles `/api/memory2*`; null when `url` is not ours. Errors map to stable codes, never raw messages. */
export async function handleMemoryControlsApi(req: IncomingMessage, url: URL, body: unknown, deps: MemoryControlsDeps): Promise<Result | null> {
  if (!isMemoryControlsPath(url.pathname)) return null
  const denial = uiOnlyDenial(req, url, deps.isNodeToken)
  if (denial) return { status: 403, body: { error: denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_remember' : denial } }
  try {
    return await dispatch(req.method ?? 'GET', url, body, deps)
  } catch (err) {
    if (err instanceof MemoryRejectedError) return { status: err.code === 'not_found' ? 404 : 400, body: { error: err.code } }
    if (err instanceof MemoryAuthorityError) return { status: 403, body: { error: 'forbidden' } }
    if (err instanceof URIError) return { status: 400, body: { error: 'invalid_id' } }
    throw err
  }
}
