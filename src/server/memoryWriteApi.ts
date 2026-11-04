// Tulis memory lewat HTTP: `POST /api/memory/claim` dan `POST /api/memory/promote`.
// Repositori (`memory/memoryWrite.ts`) tetap satu-satunya tempat aturan claim/promote; modul ini
// hanya membaca body berbatas, memetakan error, dan menolak field otoritas dari payload.
//
// OTORITAS: route ini tidak ada di `isNodeTokenPath`, jadi hanya token root/loopback yang bisa
// mencapainya. Karena itu aktornya diturunkan server sebagai `human:api-root` — payload TIDAK
// pernah boleh menyebut `authority`/`actor`/`status`; field itu diabaikan, bukan dipercaya.
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { LEDGER_OFF, type RouteResult } from './apiShared.types'
import { BodyReadError } from './cappedRequestBody'
import {
  MEMORY_SCOPES,
  type MachineEvidence,
  type Memory,
  type MemoryAuthority,
  type MemoryScope,
  MemoryAuthorityError,
  MemoryConflictError,
  MemoryEvidenceError,
  MemoryNotFoundError,
  claimMemory,
  promoteMemory,
} from './memory/memory'
import { MemoryRejectedError } from './memory/memoryModel'

/** Body JSON memory: beberapa field teks + evidence. 64 KiB jauh di atas pemakaian wajar. */
export const MEMORY_WRITE_BODY_MAX_BYTES = 64 * 1024

/** Aktor untuk pemanggil root/loopback. Konstan, bukan hasil parsing body. */
export const MEMORY_API_AUTHORITY: MemoryAuthority = { kind: 'human', id: 'api-root' }

const CLAIM_PATH = '/api/memory/claim'
const PROMOTE_PATH = '/api/memory/promote'

type Body = Record<string, unknown>

function isBody(value: unknown): value is Body {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Field wajib: string tak kosong. `undefined` = ditolak (400 invalid_memory). */
function requiredText(body: Body, field: string): string | undefined {
  const value = body[field]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function scopeOf(value: unknown): MemoryScope | undefined | null {
  if (value === undefined) return undefined
  return MEMORY_SCOPES.includes(value as MemoryScope) ? (value as MemoryScope) : null
}

/**
 * Evidence diteruskan apa adanya ke `validateEvidence` (satu-satunya validator bentuk evidence).
 * Cast di sini hanya batas tipe: objek non-objek sengaja diteruskan sebagai `undefined` supaya
 * repositori yang memberi pesan penolakan.
 */
function evidenceOf(value: unknown): MachineEvidence | undefined {
  return isBody(value) ? (value as unknown as MachineEvidence) : undefined
}

/** Semua error memory jadi kode stabil; pesan mentah tidak pernah diteruskan ke client. */
function failure(err: unknown): RouteResult {
  if (err instanceof MemoryConflictError) return { status: 409, body: { error: 'memory_conflict' } }
  if (err instanceof MemoryNotFoundError) return { status: 404, body: { error: 'memory_not_found' } }
  // Write-guard refusals (F5-a): `forgotten` (tombstone), `incognito`, `untrusted_source`. The code is a
  // fixed vocabulary from the repository, never a raw message, so it is safe to return.
  if (err instanceof MemoryRejectedError) return { status: 400, body: { error: 'memory_rejected', reason: err.code } }
  if (err instanceof MemoryEvidenceError || err instanceof MemoryAuthorityError) {
    return { status: 400, body: { error: 'invalid_memory' } }
  }
  throw err
}

function claim(db: LedgerRuntime['db'], body: Body): RouteResult {
  const projectId = requiredText(body, 'projectId')
  const key = requiredText(body, 'key')
  const title = requiredText(body, 'title')
  const text = requiredText(body, 'body')
  const sourceKind = requiredText(body, 'sourceKind')
  const sourceRef = requiredText(body, 'sourceRef')
  const scope = scopeOf(body.scope)
  if (
    projectId === undefined || key === undefined || title === undefined ||
    text === undefined || sourceKind === undefined || sourceRef === undefined || scope === null
  ) {
    return { status: 400, body: { error: 'invalid_memory' } }
  }
  const memory = claimMemory(db, MEMORY_API_AUTHORITY, {
    projectId,
    scope,
    key,
    title,
    body: text,
    sourceKind,
    sourceRef,
  })
  return { status: 201, body: { ok: true, memory } }
}

function promote(db: LedgerRuntime['db'], body: Body): RouteResult {
  const id = requiredText(body, 'id')
  if (id === undefined) return { status: 400, body: { error: 'invalid_memory' } }
  const memory: Memory = promoteMemory(db, MEMORY_API_AUTHORITY, {
    id,
    evidence: evidenceOf(body.evidence) as MachineEvidence,
  })
  return { status: 200, body: { ok: true, memory } }
}

/**
 * `null` = bukan route ini (path lain, atau method selain POST) sehingga `api.ts` lanjut ke 404.
 * `body` dibaca malas: route yang tidak cocok tidak pernah menyentuh stream request.
 */
export async function memoryWriteRoute(
  path: string,
  method: string,
  body: () => Promise<string>,
  runtime: LedgerRuntime | null
): Promise<RouteResult | null> {
  if (path !== CLAIM_PATH && path !== PROMOTE_PATH) return null
  if (method !== 'POST') return null
  if (!runtime) return LEDGER_OFF

  let raw: string
  try {
    raw = await body()
  } catch (err) {
    if (!(err instanceof BodyReadError)) throw err
    return err.reason === 'too_large'
      ? { status: 413, body: { error: 'payload_too_large' } }
      : { status: 400, body: { error: 'body_read_failed' } }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { status: 400, body: { error: 'invalid_json' } }
  }
  if (!isBody(parsed)) return { status: 400, body: { error: 'invalid_body' } }

  try {
    return path === CLAIM_PATH ? claim(runtime.db, parsed) : promote(runtime.db, parsed)
  } catch (err) {
    return failure(err)
  }
}
