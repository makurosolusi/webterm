// HTTP GET untuk inbox state-first (P4). Proyeksinya murni SELECT dari `inbox/inbox.ts`:
// merender inbox tidak pernah approve/retry/bertindak. Otorisasi transport (token root/loopback)
// sudah dilakukan `index.ts` sebelum `handleApi`, jadi modul ini hanya membaca query.
import { buildInbox, inboxCounts } from './inbox'
import type { LedgerRuntime } from './ledger/ledgerRuntime'

export type RouteResult = { status: number; body: unknown }

export const LEDGER_OFF: RouteResult = { status: 503, body: { error: 'ledger_off' } }

const INBOX_PATH = '/api/inbox'
const MAX_PROJECT_ID = 200
const MAX_LIMIT = 100
const MAX_OFFSET = 1_000_000

/** `undefined` = tidak dikirim, `null` = tidak sah. Hanya digit: `1e3`/`-1` bukan halaman. */
function boundedInteger(raw: string | null, min: number, max: number): number | undefined | null {
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}

/** Project id opsional (absen = tampilan lintas project); string kosong/panjang ditolak. */
function projectParam(params: URLSearchParams): string | undefined | null {
  const raw = params.get('projectId')
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > MAX_PROJECT_ID) return null
  return trimmed
}

/**
 * `null` = bukan `/api/inbox`, pemanggil lanjut ke route lain (termasuk 404).
 * Body sukses: `{ items, total, limit, offset, counts }`.
 */
export function inboxRoute(
  path: string,
  method: string,
  params: URLSearchParams,
  runtime: LedgerRuntime | null
): RouteResult | null {
  if (path !== INBOX_PATH || method !== 'GET') return null
  if (!runtime) return LEDGER_OFF
  const projectId = projectParam(params)
  if (projectId === null) return { status: 400, body: { error: 'invalid_project_id' } }
  const limit = boundedInteger(params.get('limit'), 1, MAX_LIMIT)
  if (limit === null) return { status: 400, body: { error: 'invalid_limit' } }
  const offset = boundedInteger(params.get('offset'), 0, MAX_OFFSET)
  if (offset === null) return { status: 400, body: { error: 'invalid_offset' } }
  const options = {
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  }
  const page = buildInbox(runtime.db, projectId, options)
  return {
    status: 200,
    body: { ...page, counts: inboxCounts(runtime.db, projectId, options) },
  }
}
