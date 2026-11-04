// Uniform receipt for every capability execution (Orca receipt `{outcome, detail, next}` +
// `operationId`/`--retry-launch` replay). `evidence` is filled by the system (audit event seq,
// handler data keys), never by the model.
import { createHash } from 'node:crypto'

export type ReceiptOutcome = 'ok' | 'denied' | 'error'

export interface Receipt {
  outcome: ReceiptOutcome
  /** Stable code (`ok`, `tier_denied`, `invalid_shape`, ...); never raw error text. */
  detail: string
  /** Suggested follow-up the caller can act on, or null. */
  next: string | null
  /** System-produced facts about what happened. */
  evidence: Record<string, unknown>
  operationId: string | null
  /** True when this receipt was replayed from an earlier run of the same `operationId`. */
  replayed?: boolean
}

/**
 * Where receipts are kept for replay. Seam for F1-c: the in-memory log below is swapped for one
 * backed by the hash-chained `event` table, keyed by `operationId`, without touching callers.
 */
export interface ReceiptLog {
  get(operationId: string): { fingerprint: string; receipt: Receipt } | undefined
  put(operationId: string, fingerprint: string, receipt: Receipt): void
}

export const RECEIPT_LOG_MAX = 1000

/** Bounded in-memory log; the oldest entry is evicted past `max`. Lost on restart (see `ReceiptLog`). */
export function createMemoryReceiptLog(max = RECEIPT_LOG_MAX): ReceiptLog {
  const entries = new Map<string, { fingerprint: string; receipt: Receipt }>()
  return {
    get: (id) => entries.get(id),
    put(id, fingerprint, receipt) {
      entries.delete(id)
      entries.set(id, { fingerprint, receipt })
      if (entries.size > max) entries.delete(entries.keys().next().value as string)
    },
  }
}

/** Stable digest of a capability call (name + canonical args), used to reject a reused id with other args. */
export function callFingerprint(name: string, args: unknown): string {
  return createHash('sha256').update(name).update('\0').update(canonicalJson(args)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export const OPERATION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Runs `run` at most once per `operationId`: a repeat with the same call replays the stored receipt,
 * a repeat with different args is refused (`operation_conflict`). Without an id it always runs.
 * Only `ok` receipts are stored, so a denied or failed call may be retried under the same id.
 */
export async function runOnce(
  log: ReceiptLog, operationId: string | undefined, fingerprint: string, run: () => Promise<Receipt>,
): Promise<Receipt> {
  if (operationId === undefined) return run()
  if (!OPERATION_ID_RE.test(operationId)) return { outcome: 'error', detail: 'invalid_operation_id', next: null, evidence: {}, operationId: null }
  const prior = log.get(operationId)
  if (prior) {
    return prior.fingerprint === fingerprint
      ? { ...prior.receipt, replayed: true }
      : conflict(operationId)
  }
  // Concurrent repeats join the call already in flight instead of running it twice.
  const pending = inflightOf(log)
  const running = pending.get(operationId)
  if (running) return running.fingerprint === fingerprint ? { ...(await running.promise), replayed: true } : conflict(operationId)
  const promise = run().then((r) => {
    const receipt = { ...r, operationId }
    if (receipt.outcome === 'ok') log.put(operationId, fingerprint, receipt)
    return receipt
  }).finally(() => pending.delete(operationId))
  pending.set(operationId, { fingerprint, promise })
  return promise
}

const inflight = new WeakMap<ReceiptLog, Map<string, { fingerprint: string; promise: Promise<Receipt> }>>()
function inflightOf(log: ReceiptLog): Map<string, { fingerprint: string; promise: Promise<Receipt> }> {
  let map = inflight.get(log)
  if (!map) inflight.set(log, (map = new Map()))
  return map
}

function conflict(operationId: string): Receipt {
  return { outcome: 'error', detail: 'operation_conflict', next: 'use a new operationId for a different call', evidence: {}, operationId }
}
