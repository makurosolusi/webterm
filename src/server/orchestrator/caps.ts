// Cap sumber daya P3 (RND/03-RENCANA.md §8): cap memblokir, tidak pernah sekadar warning.
// `checkCaps` murni dan mengembalikan semua pelanggaran bertipe supaya caller bisa
// mencatat alasan deny ke ledger/event tanpa parsing pesan.

/** Default keras; wiring boleh meng-override lewat `OrchestratorDeps.caps`. */
export const DEFAULT_CAPS: Readonly<CapLimits> = Object.freeze({
  maxParallelWorkers: 3,
  maxAttemptsPerTask: 3,
  leaseMs: 10 * 60_000,
  maxTokens: 200_000,
  maxCostMicros: 5_000_000,
  maxTurns: 40,
  maxWallMs: 30 * 60_000,
})

export interface CapLimits {
  /** Worker yang boleh berjalan bersamaan dalam satu project. */
  maxParallelWorkers: number
  /** Attempt total per task (termasuk percobaan sekarang). */
  maxAttemptsPerTask: number
  /** Umur lease maksimum per grant. */
  leaseMs: number
  maxTokens: number
  /** Biaya dalam micro-USD (1 USD = 1_000_000). */
  maxCostMicros: number
  maxTurns: number
  maxWallMs: number
}

export interface CapSnapshot {
  activeWorkers: number
  attemptsUsed: number
  tokensUsed: number
  costMicros: number
  turnsUsed: number
  elapsedMs: number
}

/** Kebutuhan tambahan untuk satu grant; field kosong berarti 0. */
export interface CapRequest {
  /** Worker baru yang akan dijalankan sekarang. */
  workers?: number
  /** Nomor attempt yang akan dikonsumsi (1-based). */
  attempt?: number
  tokens?: number
  costMicros?: number
  turns?: number
  /** Tambahan waktu yang diminta (mis. sisa wall clock percobaan ini). */
  elapsedMs?: number
  leaseMs?: number
}

export type CapDenyCode =
  | 'parallel_workers'
  | 'attempts'
  | 'tokens'
  | 'cost_usd'
  | 'turns'
  | 'wall_time'
  | 'lease_ttl'

export interface CapViolation {
  code: CapDenyCode
  limit: number
  actual: number
}

export type CapDecision = { ok: true } | { ok: false; denials: CapViolation[] }

export class CapExceededError extends Error {
  constructor(readonly denials: CapViolation[]) {
    super(
      `caps exceeded: ${denials.map((d) => `${d.code} ${d.actual} > ${d.limit}`).join('; ')}`
    )
    this.name = 'CapExceededError'
  }
}

function amount(value: number | undefined, label: string): number {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`caps.${label} must be a finite non-negative number, got ${String(value)}`)
  }
  return value
}

function limitOf(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`caps.${label} limit must be a positive finite number, got ${String(value)}`)
  }
  return value
}

/**
 * Membandingkan snapshot pemakaian + permintaan terhadap limits. Tidak ada side effect:
 * pemanggil yang memutuskan berhenti, dan `assertCaps` yang mengubah hasil jadi exception.
 */
export function checkCaps(
  snapshot: CapSnapshot,
  request: CapRequest = {},
  limits: CapLimits = DEFAULT_CAPS
): CapDecision {
  const maxWorkers = limitOf(limits.maxParallelWorkers, 'maxParallelWorkers')
  const maxAttempts = limitOf(limits.maxAttemptsPerTask, 'maxAttemptsPerTask')
  const maxTokens = limitOf(limits.maxTokens, 'maxTokens')
  const maxCost = limitOf(limits.maxCostMicros, 'maxCostMicros')
  const maxTurns = limitOf(limits.maxTurns, 'maxTurns')
  const maxWall = limitOf(limits.maxWallMs, 'maxWallMs')
  const maxLease = limitOf(limits.leaseMs, 'leaseMs')

  const denials: CapViolation[] = []
  const deny = (code: CapDenyCode, actual: number, limit: number) =>
    denials.push({ code, actual, limit })

  const workers = amount(snapshot.activeWorkers, 'snapshot.activeWorkers') +
    amount(request.workers, 'workers')
  if (workers > maxWorkers) deny('parallel_workers', workers, maxWorkers)

  const attempt = request.attempt ?? snapshot.attemptsUsed
  if (attempt > maxAttempts) deny('attempts', attempt, maxAttempts)

  const tokens = amount(snapshot.tokensUsed, 'snapshot.tokensUsed') + amount(request.tokens, 'tokens')
  if (tokens > maxTokens) deny('tokens', tokens, maxTokens)

  const cost = amount(snapshot.costMicros, 'snapshot.costMicros') + amount(request.costMicros, 'costMicros')
  if (cost > maxCost) deny('cost_usd', cost, maxCost)

  const turns = amount(snapshot.turnsUsed, 'snapshot.turnsUsed') + amount(request.turns, 'turns')
  if (turns > maxTurns) deny('turns', turns, maxTurns)

  const wall = amount(snapshot.elapsedMs, 'snapshot.elapsedMs') + amount(request.elapsedMs, 'elapsedMs')
  if (wall > maxWall) deny('wall_time', wall, maxWall)

  if (request.leaseMs !== undefined && amount(request.leaseMs, 'leaseMs') > maxLease) {
    deny('lease_ttl', request.leaseMs, maxLease)
  }

  return denials.length === 0 ? { ok: true } : { ok: false, denials }
}

/** Varian blocking untuk jalur mutasi: cap yang dilanggar menjadi `CapExceededError`. */
export function assertCaps(
  snapshot: CapSnapshot,
  request: CapRequest = {},
  limits: CapLimits = DEFAULT_CAPS
): void {
  const decision = checkCaps(snapshot, request, limits)
  if (!decision.ok) throw new CapExceededError(decision.denials)
}

/** Snapshot kosong untuk project yang belum punya run apa pun. */
export function emptyCapSnapshot(): CapSnapshot {
  return { activeWorkers: 0, attemptsUsed: 0, tokensUsed: 0, costMicros: 0, turnsUsed: 0, elapsedMs: 0 }
}
