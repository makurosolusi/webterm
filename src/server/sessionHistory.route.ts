// Rute Agent History: `GET /api/session-history` (indeks transcript, berhalaman) dan
// `GET|PUT /api/closed-history` (riwayat node yang ditutup, bertahan lintas reload/restart).
// Konvensi `workspacesApi.ts`: kembalikan `{ status, body }`, `null` = bukan milik modul ini.
// Otorisasi sudah ditegakkan `index.ts` untuk seluruh `/api/*`.
import { BodyReadError } from './cappedRequestBody'
import { scanSessions, type ScanRoot } from './sessionHistory.scan'
import {
  CLOSED_CAP, ensureSessionHistorySchema, listClosed, listSessions, replaceClosed,
  type ClosedRecord, type HistoryDb,
} from './sessionHistory.store'

export const SESSION_HISTORY_PATH = '/api/session-history'
export const CLOSED_HISTORY_PATH = '/api/closed-history'

/** Jeda minimum antar scan: tiap halaman yang di-scroll memanggil GET lagi, dan stat ribuan file
 *  per request tidak ada gunanya. `refresh=1` (tombol Refresh) melewatinya. */
export const SCAN_MIN_INTERVAL_MS = 5000

export type HistoryResult = { status: number; body?: unknown } | null

export interface HistoryDeps {
  db: HistoryDb
  roots?: readonly ScanRoot[]
  now?: () => number
}

const scanState = new WeakMap<HistoryDb, { at: number; running: Promise<void> | null }>()

/** Scan single-flight + ber-throttle per database. */
async function freshen(deps: HistoryDeps, force: boolean): Promise<void> {
  const now = (deps.now ?? Date.now)()
  const st = scanState.get(deps.db) ?? { at: -Infinity, running: null }
  scanState.set(deps.db, st)
  if (st.running) return st.running
  if (!force && now - st.at < SCAN_MIN_INTERVAL_MS) return
  st.running = scanSessions(deps.db, deps.roots).finally(() => {
    st.at = now
    st.running = null
  })
  return st.running
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Validasi batas input: entry yang bentuknya salah ditolak seluruh body-nya (400), bukan
 *  diam-diam disaring, supaya klien yang rusak terlihat. */
export function parseClosedBody(raw: string): ClosedRecord[] | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  const list = isObj(v) ? v.entries : undefined
  if (!Array.isArray(list) || list.length > CLOSED_CAP) return null
  const ok = list.every((e) =>
    isObj(e) && isObj(e.node) && typeof e.node.id === 'string' && e.node.id !== '' &&
    typeof e.node.kind === 'string' && typeof e.workspaceId === 'string' &&
    typeof e.workspaceName === 'string' && typeof e.closedAt === 'number')
  return ok ? (list as ClosedRecord[]) : null
}

export async function sessionHistoryRoute(
  path: string,
  method: string,
  query: URLSearchParams,
  body: () => Promise<string>,
  deps: HistoryDeps,
): Promise<HistoryResult> {
  if (path === SESSION_HISTORY_PATH && method === 'GET') {
    await freshen(deps, query.get('refresh') === '1')
    const page = listSessions(deps.db, {
      cwd: query.get('cwd') ?? undefined,
      q: query.get('q') ?? undefined,
      limit: Number(query.get('limit') ?? undefined),
      offset: Number(query.get('offset') ?? undefined),
    })
    return { status: 200, body: page }
  }
  if (path !== CLOSED_HISTORY_PATH) return null
  if (method === 'GET') return { status: 200, body: { entries: listClosed(deps.db) } }
  if (method !== 'PUT') return null
  let raw: string
  try {
    raw = await body()
  } catch (err) {
    if (!(err instanceof BodyReadError)) throw err
    return { status: err.reason === 'too_large' ? 413 : 400, body: { error: err.reason } }
  }
  const entries = parseClosedBody(raw)
  if (!entries) return { status: 400, body: { error: 'entries must be an array of closed entries' } }
  replaceClosed(deps.db, entries)
  return { status: 204 }
}

let liveDeps: HistoryDeps | null = null

/** Koneksi webterm.db milik rute ini, dibuka sekali (pola `envSettings.runtime.ts`). Impor dinamis
 *  supaya modul ini tetap bisa dimuat test tanpa bun:sqlite. */
export async function sessionHistoryDeps(): Promise<HistoryDeps> {
  if (liveDeps) return liveDeps
  const { openDb } = await import('./db')
  const db = openDb()
  ensureSessionHistorySchema(db)
  liveDeps = { db }
  return liveDeps
}
