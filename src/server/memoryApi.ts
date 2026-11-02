// HTTP baca memory (P4). Dua route read-only: FTS search dan listing riwayat. Tidak ada
// tulis/claim/promote di sini — otoritas tetap di `memory/memoryWrite.ts` (route tulis menyusul).
// Otorisasi transport (token root/loopback) sudah dilakukan `index.ts` sebelum `handleApi`.
import { listMemory, searchMemory } from './memory/memory'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { boundedInteger, projectParam } from './apiShared.params'
import { LEDGER_OFF, type RouteResult } from './apiShared.types'

const MEMORY_PATH = '/api/memory'
const SEARCH_PATH = '/api/memory/search'
const MAX_QUERY_CHARS = 512
const SEARCH_LIMIT_MAX = 100
// `listMemory` clamps an explicit limit to 100 (its default, when omitted, is 200).
const LIST_LIMIT_MAX = 100

/** Body sukses: `{ projectId, q, limit, items }` / `{ projectId, limit, items }`. */
export function memoryRoute(
  path: string,
  method: string,
  params: URLSearchParams,
  runtime: LedgerRuntime | null
): RouteResult | null {
  const search = path === SEARCH_PATH
  if (!search && path !== MEMORY_PATH) return null
  if (method !== 'GET') return null
  if (!runtime) return LEDGER_OFF
  const projectId = projectParam(params)
  if (projectId === null) return { status: 400, body: { error: 'invalid_project_id' } }
  if (!search) {
    const limit = boundedInteger(params.get('limit'), 1, LIST_LIMIT_MAX)
    if (limit === null) return { status: 400, body: { error: 'invalid_limit' } }
    const items = listMemory(runtime.db, projectId, limit === undefined ? {} : { limit })
    return { status: 200, body: { projectId, limit: limit ?? 200, items } }
  }
  const q = (params.get('q') ?? '').trim()
  if (q === '' || q.length > MAX_QUERY_CHARS) return { status: 400, body: { error: 'invalid_q' } }
  const limit = boundedInteger(params.get('limit'), 1, SEARCH_LIMIT_MAX)
  if (limit === null) return { status: 400, body: { error: 'invalid_limit' } }
  const items = searchMemory(runtime.db, projectId, q, limit ?? 20)
  return { status: 200, body: { projectId, q, limit: limit ?? 20, items } }
}
